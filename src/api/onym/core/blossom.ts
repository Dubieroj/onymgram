import { sha256 } from '@noble/hashes/sha2.js';

import {
  concatBytes, fromHex, toBase64, toHex, utf8,
} from './bytes';
import { signWithEphemeralKey } from './nostr';

// Encrypted media on Blossom (onym-ios `ChatImageCrypto`, `BlossomClient`): a blob is nonce(12) ‖ ciphertext ‖ tag(16)
// under a random AES-256-GCM key that travels only inside the sealed chat message, addressed by the SHA-256 of the
// encrypted bytes, so the server stores what it cannot read
export const DEFAULT_BLOSSOM_SERVERS = ['https://blossom.onym.app'];

const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const MAX_BLOB_BYTES = 50 * 1024 * 1024;
// BUD-01 authorization: kind 24242, valid for five minutes, content as the apps write it
const AUTH_KIND = 24242;
const AUTH_TTL_SECONDS = 300;
const AUTH_CONTENT = 'Upload chat image';

// A stamped server is used only if it is one of ours (onym-ios `BlossomServerStampPolicy`): a message cannot make
// this client fetch from an address its sender chose
export function pickServer(stamped: string | undefined, servers = DEFAULT_BLOSSOM_SERVERS) {
  const normalized = stamped?.replace(/\/+$/, '');
  return normalized && servers.includes(normalized) ? normalized : servers[0];
}

export async function downloadEncryptedBlob(server: string, hash: string) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid blob hash');

  const response = await fetch(`${server}/${hash}`);
  if (!response.ok) throw new Error(`Blossom answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_BLOB_BYTES) throw new Error('Blob too large');
  if (toHex(sha256(bytes)) !== hash) throw new Error('Blob does not match its address');
  return bytes;
}

export async function decryptBlob(blob: Uint8Array, keyHex: string) {
  const key = await crypto.subtle.importKey('raw', fromHex(keyHex).slice().buffer, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: blob.slice(0, NONCE_BYTES) }, key, blob.slice(NONCE_BYTES).buffer,
  );
  return new Uint8Array(plain);
}

export async function encryptBlob(plain: Uint8Array) {
  const keyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const key = await crypto.subtle.importKey('raw', keyBytes.slice().buffer, 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain.slice().buffer),
  );
  const blob = concatBytes(nonce, sealed);
  const keyHex = toHex(keyBytes);
  keyBytes.fill(0);
  return { blob, hash: toHex(sha256(blob)), keyHex };
}

export async function uploadBlob(server: string, blob: Uint8Array, hash: string, mimeType: string) {
  const expiration = String(Math.floor(Date.now() / 1000) + AUTH_TTL_SECONDS);
  const tags = [['t', 'upload'], ['x', hash], ['expiration', expiration]];
  const auth = signWithEphemeralKey(AUTH_KIND, tags, AUTH_CONTENT);
  const response = await fetch(`${server}/upload`, {
    method: 'PUT',
    headers: { Authorization: `Nostr ${toBase64(utf8(JSON.stringify(auth)))}`, 'Content-Type': mimeType },
    body: blob.slice().buffer,
  });
  if (!response.ok) throw new Error(`Blossom answered ${response.status}`);
}
