import { sha256 } from '@noble/hashes/sha2.js';

import { fromHex, toHex } from './bytes';

// Encrypted media on Blossom (onym-ios `ChatImageCrypto`, `BlossomClient`): a blob is nonce(12) ‖ ciphertext ‖ tag(16)
// under a random AES-256-GCM key that travels only inside the sealed chat message, addressed by the SHA-256 of the
// encrypted bytes, so the server stores what it cannot read
export const DEFAULT_BLOSSOM_SERVERS = ['https://blossom.onym.app'];

const NONCE_BYTES = 12;
const MAX_BLOB_BYTES = 50 * 1024 * 1024;

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
