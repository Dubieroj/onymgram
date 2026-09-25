import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  concatBytes, fromBase64, toBase64, toHex, utf8,
} from './bytes';

// Every Onym inbox payload travels in this envelope (onym-ios `SealedEnvelope`, `IdentityRepository.sealInvitation`):
// a fresh X25519 key agrees with the recipient's inbox key, HKDF-SHA256(salt "sep-invitation-v1", info
// "aes-256-gcm") gives the AES-256-GCM key, and the sender's Ed25519 "sending" key signs the ephemeral public key
const SCHEME = 'x25519-aes-256-gcm-v1';
const KEY_SALT = 'sep-invitation-v1';
const KEY_INFO = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

type EnvelopeJson = {
  version: number;
  scheme: string;
  ephemeral_public_key?: string;
  ephemeral_key_signature?: string;
  sender_ed25519_public_key?: string;
  nonce?: string;
  ciphertext: string;
  authentication_tag?: string;
};

export type OpenedEnvelope = {
  plaintext: Uint8Array;
  // Present only when the envelope carried a signature by this key over its ephemeral key and it verified
  verifiedSender?: string;
};

export async function sealEnvelope(
  plaintext: Uint8Array, recipientInboxPublicKey: Uint8Array, sendingSeed: Uint8Array,
) {
  const ephemeralSecret = x25519.utils.randomSecretKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
  const key = deriveKey(x25519.getSharedSecret(ephemeralSecret, recipientInboxPublicKey));
  ephemeralSecret.fill(0);

  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, await importKey(key), toBuffer(plaintext),
  ));
  key.fill(0);

  const envelope: EnvelopeJson = {
    version: 1,
    scheme: SCHEME,
    ephemeral_public_key: toBase64(ephemeralPublic),
    ephemeral_key_signature: toBase64(ed25519.sign(ephemeralPublic, sendingSeed)),
    sender_ed25519_public_key: toBase64(ed25519.getPublicKey(sendingSeed)),
    nonce: toBase64(nonce),
    ciphertext: toBase64(sealed.subarray(0, sealed.length - TAG_BYTES)),
    authentication_tag: toBase64(sealed.subarray(sealed.length - TAG_BYTES)),
  };
  return utf8(JSON.stringify(envelope));
}

export async function openEnvelope(bytes: Uint8Array, inboxSecretKey: Uint8Array): Promise<OpenedEnvelope> {
  const envelope = JSON.parse(new TextDecoder().decode(bytes)) as EnvelopeJson;
  if (envelope.scheme !== SCHEME) throw new Error(`Unsupported envelope scheme: ${envelope.scheme}`);
  if (!envelope.ephemeral_public_key || !envelope.nonce || !envelope.authentication_tag) {
    throw new Error('Incomplete envelope');
  }

  const ephemeralPublic = fromBase64(envelope.ephemeral_public_key);
  let verifiedSender: string | undefined;
  if (envelope.ephemeral_key_signature && envelope.sender_ed25519_public_key) {
    const senderPublic = fromBase64(envelope.sender_ed25519_public_key);
    // A present but invalid signature refuses the envelope instead of reading it as unsigned
    if (!ed25519.verify(fromBase64(envelope.ephemeral_key_signature), ephemeralPublic, senderPublic)) {
      throw new Error('Envelope signature does not verify');
    }
    verifiedSender = toHex(senderPublic);
  }

  const key = deriveKey(x25519.getSharedSecret(inboxSecretKey, ephemeralPublic));
  const nonce = fromBase64(envelope.nonce);
  const sealed = concatBytes(fromBase64(envelope.ciphertext), fromBase64(envelope.authentication_tag));
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuffer(nonce) }, await importKey(key), toBuffer(sealed),
  ));
  key.fill(0);
  return { plaintext, verifiedSender };
}

function deriveKey(sharedSecret: Uint8Array) {
  const key = hkdf(sha256, sharedSecret, utf8(KEY_SALT), utf8(KEY_INFO), KEY_BYTES);
  sharedSecret.fill(0);
  return key;
}

function importKey(key: Uint8Array) {
  return crypto.subtle.importKey('raw', toBuffer(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function toBuffer(bytes: Uint8Array) {
  return bytes.slice().buffer;
}
