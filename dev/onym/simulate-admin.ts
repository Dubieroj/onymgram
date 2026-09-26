/* eslint-disable no-console */
// Plays the Onym iOS app's admin side against a real relay, byte-for-byte in the apps' formats, to exercise this
// interface end to end: offer → join request → invitation → chat both ways → receipts. It does not anchor anything
// on Stellar (this interface does not read the chain yet), so it proves the messaging protocol, not the notary.
//
//   npx tsx dev/onym/simulate-admin.ts <invite link of the web user> [--photo image.jpg] [--album a.jpg,b.jpg]
//     [--voice clip.m4a] [--save-media dir] [--relay wss://…]
//
// With --save-media, every photo, album photo and voice clip the web client sends is fetched from Blossom, checked
// against its SHA-256 address and decrypted as the apps do (`ChatImageLoader`, `ChatVoiceLoader`), and written to
// the directory for `sips` / `afinfo` to open with the same Apple decoders the iOS app uses
import { bls12_381_Fr as Fr } from '@noble/curves/bls12-381.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';

import { fromHex, toBase64, toHex, utf8 } from '../../src/api/onym/core/bytes';
import { openEnvelope, sealEnvelope } from '../../src/api/onym/core/envelope';
import { deriveIdentity, getIdentityPublic, getInboxTag } from '../../src/api/onym/core/identity';
import { parseIdentityLink } from '../../src/api/onym/core/links';
import {
  buildInboxEvent, buildInboxFilters, computeEventId, openInboxEvent,
} from '../../src/api/onym/core/nostr';
import {
  decodeInboundPayload, encodeChatMessage, encodeReceipt,
} from '../../src/api/onym/core/payloads';
import {
  computeCommitment, computeLeafHash, computeMerkleRoot, frToBytes,
} from '../../src/api/onym/core/poseidon';

const ADMIN_PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const GROUP_NAME = 'Onym × Telegram interop test';
const DEPTH = 5;

const [link, ...options] = process.argv.slice(2);
const relayUrl = readOption('--relay') || 'wss://nostr.onym.app';
const photoPath = readOption('--photo');
const albumPaths = readOption('--album')?.split(',');
const voicePath = readOption('--voice');
const mediaDir = readOption('--save-media');
const BLOSSOM = 'https://blossom.onym.app';
const joinerInbox = link && parseIdentityLink(link);
if (!joinerInbox) {
  console.error('Usage: simulate-admin.ts <https://onym.app/i?k=… invite link> [relay]');
  process.exit(1);
}

const admin = deriveIdentity(ADMIN_PHRASE);
const adminPublic = getIdentityPublic(admin);
const adminLeaf = toHex(computeLeafHash(admin.blsSecretKey));
const groupId = toHex(frToBytes(Fr.create(BigInt(`0x${toHex(crypto.getRandomValues(new Uint8Array(32)))}`))));
const groupSecret = crypto.getRandomValues(new Uint8Array(32));
const introSecret = x25519.utils.randomSecretKey();
const introPublic = x25519.getPublicKey(introSecret);

const socket = new WebSocket(relayUrl);
const pendingOk = new Map<string, (ok: boolean, reason: string) => void>();

socket.onmessage = async ({ data }) => {
  const frame = JSON.parse(String(data));
  if (frame[0] === 'OK') {
    pendingOk.get(frame[1])?.(frame[2], frame[3]);
    return;
  }
  if (frame[0] !== 'EVENT') return;

  const inbox = frame[1] === 'intro' ? getInboxTag(introPublic) : adminPublic.inboxTag;
  const opened = openInboxEvent(frame[2], inbox);
  if (!opened) return;

  const secret = frame[1] === 'intro' ? introSecret : admin.inboxSecretKey;
  const envelope = await openEnvelope(opened.payload, secret).catch(() => undefined);
  if (!envelope) return;
  const json = JSON.parse(new TextDecoder().decode(envelope.plaintext));

  if (frame[1] === 'intro' && json.joiner_inbox_pub) {
    await approveJoin(json, envelope.verifiedSender);
    return;
  }

  const payload = decodeInboundPayload(envelope.plaintext);
  if (payload?.type === 'message') {
    console.log(`← message from the web client: “${payload.body}” (${payload.messageId})`);
    if (mediaDir) await saveMedia(payload);
    await send(joinerInbox, encodeReceipt({
      groupId, senderBlsPublicKey: adminPublic.blsPublicKey, kind: 'read', messageIds: [payload.messageId],
    }));
    console.log('→ read receipt sent; interop run complete');
  } else if (payload?.type === 'receipt') {
    console.log(`← ${payload.kind} receipt for ${payload.messageIds.join(', ')}`);
  }
};

socket.onopen = async () => {
  socket.send(JSON.stringify(['REQ', 'intro', ...buildInboxFilters(getInboxTag(introPublic))]));
  socket.send(JSON.stringify(['REQ', 'admin', ...buildInboxFilters(adminPublic.inboxTag)]));

  // What the iOS creator sends each invitee once the group is anchored: an offer sealed to their inbox key
  const offer = utf8(JSON.stringify({
    offer_version: 1,
    intro_pub: toBase64(introPublic),
    group_id: toBase64(fromHex(groupId)),
    group_name: GROUP_NAME,
    inviter_alias: 'Interop Admin',
  }));
  await send(joinerInbox, offer);
  console.log(`→ offer sent for group ${groupId.slice(0, 16)}…; press Join in the web client`);
};

async function approveJoin(request: Record<string, string>, verifiedSender?: string) {
  const joinerBls = toHex(Buffer.from(request.joiner_bls_pub, 'base64'));
  const joinerLeaf = toHex(Buffer.from(request.joiner_leaf_hash, 'base64'));
  const joinerSending = toHex(Buffer.from(request.joiner_sending_pub, 'base64'));
  const joinerInboxKey = toHex(Buffer.from(request.joiner_inbox_pub, 'base64'));
  const isSigner = verifiedSender === joinerSending;
  console.log(`← join request from “${request.joiner_display_label}”, signer matches: ${isSigner}`);

  const members = [
    { public_key_compressed: adminPublic.blsPublicKey, leaf_hash: adminLeaf },
    { public_key_compressed: joinerBls, leaf_hash: joinerLeaf },
  ].sort((a, b) => (a.public_key_compressed < b.public_key_compressed ? -1 : 1));
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const epoch = 1n;
  const root = computeMerkleRoot(members.map(({ leaf_hash: leaf }) => fromHex(leaf)), DEPTH);
  const commitment = computeCommitment(root, epoch, salt);

  const invitation = utf8(JSON.stringify({
    version: 1,
    group_id: toBase64(fromHex(groupId)),
    group_secret: toBase64(groupSecret),
    name: GROUP_NAME,
    members: members.map((member) => ({
      public_key_compressed: toBase64(fromHex(member.public_key_compressed)),
      leaf_hash: toBase64(fromHex(member.leaf_hash)),
    })),
    epoch: Number(epoch),
    salt: toBase64(salt),
    commitment: toBase64(commitment),
    tier_raw: 0,
    group_type_raw: 'tyranny',
    admin_pubkey_hex: adminPublic.blsPublicKey,
    member_profiles: {
      [adminPublic.blsPublicKey]: {
        alias: 'Interop Admin',
        inbox_public_key: toBase64(fromHex(adminPublic.inboxPublicKey)),
        sending_pubkey: toBase64(fromHex(adminPublic.sendingPublicKey)),
      },
      [joinerBls]: {
        alias: request.joiner_display_label,
        inbox_public_key: toBase64(fromHex(joinerInboxKey)),
        sending_pubkey: toBase64(fromHex(joinerSending)),
      },
    },
  }));
  await send(joinerInboxKey, invitation);
  console.log('→ invitation sent (roster of two, commitment recomputable)');

  await send(joinerInboxKey, encodeChatMessage({
    messageId: crypto.randomUUID(),
    groupId,
    senderBlsPublicKey: adminPublic.blsPublicKey,
    sentAtMs: Date.now(),
    body: 'Hello from the iOS-format admin 👋 Reply to finish the test.',
  }));
  console.log('→ chat message sent; waiting for a reply from the web client');

  if (photoPath) await sendPhoto(joinerInboxKey, photoPath);
  if (albumPaths) await sendAlbum(joinerInboxKey, albumPaths);
  if (voicePath) await sendVoice(joinerInboxKey, voicePath);
}

// As onym-ios `ChatImageCrypto` + `BlossomClient`: encrypt, upload under a kind-24242 authorization; the descriptor
// with the key then travels inside the sealed message
async function uploadEncrypted(plain: Uint8Array, mimeType: string) {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain));
  const blob = new Uint8Array([...nonce, ...sealed]);
  const hash = toHex(sha256(blob));

  const nowMs = Date.now();
  const secretKey = schnorr.utils.randomSecretKey();
  const unsigned = {
    pubkey: toHex(schnorr.getPublicKey(secretKey)),
    created_at: Math.floor(nowMs / 1000),
    kind: 24242,
    tags: [['t', 'upload'], ['x', hash], ['expiration', String(Math.floor(nowMs / 1000) + 300)], ['ms', String(nowMs)]],
    content: 'Upload chat image',
  };
  const id = computeEventId(unsigned);
  const authEvent = { ...unsigned, id, sig: toHex(schnorr.sign(fromHex(id), secretKey)) };
  const response = await fetch(`${BLOSSOM}/upload`, {
    method: 'PUT',
    headers: {
      Authorization: `Nostr ${Buffer.from(JSON.stringify(authEvent)).toString('base64')}`,
      'Content-Type': mimeType,
    },
    body: blob,
  });
  console.log(`→ ${mimeType} uploaded to Blossom: HTTP ${response.status} (${hash.slice(0, 16)}…)`);
  return {
    sha256: hash, enc_key: toBase64(keyBytes), byte_size: blob.length, server: BLOSSOM,
  };
}

async function buildImage(path: string) {
  return {
    ...await uploadEncrypted(readFileSync(path), 'image/jpeg'),
    mime_type: 'image/jpeg',
    width: 160,
    height: 120,
    blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
  };
}

function buildMessage(body: string, media: Record<string, unknown>) {
  return utf8(JSON.stringify({
    version: 1,
    message_id: crypto.randomUUID().toUpperCase(),
    group_id: toBase64(fromHex(groupId)),
    sender_bls_pubkey_hex: adminPublic.blsPublicKey,
    sent_at_millis: Date.now(),
    variant: { kind: 'tyranny', body },
    ...media,
  }));
}

async function sendPhoto(recipientInboxHex: string, path: string) {
  await send(recipientInboxHex, buildMessage('A photo, encrypted on Blossom', { attachment: await buildImage(path) }));
  console.log('→ photo message sent');
}

// An album is one message: `attachments` lists its items and the flat single fields stay empty
async function sendAlbum(recipientInboxHex: string, paths: string[]) {
  const items = [];
  for (const path of paths) items.push({ kind: 'image', image: await buildImage(path) });
  await send(recipientInboxHex, buildMessage(`An album of ${paths.length} photos`, { attachments: items }));
  console.log(`→ album of ${paths.length} photos sent`);
}

// A voice clip as the apps record it: AAC in MPEG-4, its duration from the file, 40 waveform bars 0…255
async function sendVoice(recipientInboxHex: string, path: string) {
  const clip = readFileSync(path);
  const uploaded = await uploadEncrypted(clip, 'audio/mp4');
  const waveform = Array.from({ length: 40 }, (_, i) => Math.round(127 + 127 * Math.sin(i / 3)));
  await send(recipientInboxHex, buildMessage('', {
    voice_attachment: {
      ...uploaded, mime_type: 'audio/mp4', duration_seconds: readMp4Duration(clip), waveform,
    },
  }));
  console.log('→ voice message sent');
}

// `mvhd` version 0: timescale and duration after the two creation times
function readMp4Duration(file: Uint8Array) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  for (let i = 0; i + 28 < file.length; i++) {
    if (file[i] === 0x6d && file[i + 1] === 0x76 && file[i + 2] === 0x68 && file[i + 3] === 0x64) {
      return view.getUint32(i + 16) ? view.getUint32(i + 20) / view.getUint32(i + 16) : 0;
    }
  }
  return 0;
}

// Fetch, check and decrypt what the web client attached, the way `ChatImageLoader` / `ChatVoiceLoader` do
async function saveMedia(message: { image?: MediaRef; images?: MediaRef[]; voice?: MediaRef }) {
  mkdirSync(mediaDir!, { recursive: true });
  const refs = [
    ...[message.image, ...(message.images || [])].filter(Boolean).map((ref) => [ref!, 'jpg'] as const),
    ...(message.voice ? [[message.voice, 'm4a'] as const] : []),
  ];
  for (const [ref, extension] of refs) {
    const response = await fetch(`${BLOSSOM}/${ref.sha256}`, { redirect: 'error' });
    const blob = new Uint8Array(await response.arrayBuffer());
    if (toHex(sha256(blob)) !== ref.sha256) {
      console.log(`← ${extension} ${ref.sha256.slice(0, 16)}… does not match its address`);
      continue;
    }
    const key = await crypto.subtle.importKey('raw', fromHex(ref.encryptionKey), 'AES-GCM', false, ['decrypt']);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12) }, key, blob.slice(12)),
    );
    const file = `${mediaDir}/${ref.sha256.slice(0, 16)}.${extension}`;
    writeFileSync(file, plain);
    console.log(`← ${extension} saved: ${file} (${plain.length} B; byte_size ${ref.byteSize}, blob ${blob.length})`);
  }
}

type MediaRef = { sha256: string; encryptionKey: string; byteSize: number };

function readOption(name: string) {
  const index = options.indexOf(name);
  return index === -1 ? undefined : options[index + 1];
}

async function send(recipientInboxHex: string, payload: Uint8Array) {
  const recipient = fromHex(recipientInboxHex);
  const sealed = await sealEnvelope(payload, recipient, admin.sendingSeed);
  const event = buildInboxEvent(getInboxTag(recipient), sealed);
  const ok = await new Promise<string>((resolve) => {
    pendingOk.set(event.id, (isOk, reason) => resolve(isOk ? 'accepted' : `rejected: ${reason}`));
    socket.send(JSON.stringify(['EVENT', event]));
    setTimeout(() => resolve('no OK'), 8000);
  });
  if (ok !== 'accepted') console.log(`  relay: ${ok}`);
}
