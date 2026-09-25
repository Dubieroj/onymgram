import { bls12_381, bls12_381_Fr } from '@noble/curves/bls12-381.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { phraseToSeed } from './bip39';
import { concatBytes, toHex, utf8 } from './bytes';
import { encodeStellarAccount } from './stellar';

// Onym identity keys, derived exactly as the Onym apps derive them (onym-ios `IdentityRepository`, `Bip39`;
// Identity-BIP39 profile §5):
//   seed    = BIP-39 seed of the phrase, no passphrase
//   nostr   = HKDF-SHA256(seed,  salt "app.onym.bip39", info "nostr-secp256k1-v1")
//   bls     = HKDF-SHA256(seed,  salt "app.onym.bip39", info "bls12-381-v1"), big-endian, reduced mod r
//   stellar = HKDF-SHA256(nostr, salt "app.onym.ios",   info "stellar-ed25519-v1")       — the "sending" key
//   inbox   = HKDF-SHA256(nostr, salt "app.onym.ios",   info "x25519-key-agreement-v1")  — X25519
//   tag     = hex(SHA-256("sep-inbox-v1" ‖ inboxPublicKey)[0..8])
const KEY_BYTES = 32;
const INBOX_TAG_BYTES = 8;

export type IdentitySecrets = {
  nostrSecretKey: Uint8Array;
  blsSecretKey: Uint8Array;
  sendingSeed: Uint8Array;
  inboxSecretKey: Uint8Array;
};

export type IdentityPublic = {
  nostrPublicKey: string;
  blsPublicKey: string;
  sendingPublicKey: string;
  stellarAccount: string;
  inboxPublicKey: string;
  inboxTag: string;
};

export function deriveIdentity(phrase: string): IdentitySecrets {
  const seed = phraseToSeed(phrase);
  const nostrSecretKey = hkdf(sha256, seed, utf8('app.onym.bip39'), utf8('nostr-secp256k1-v1'), KEY_BYTES);
  const blsSecretKey = hkdf(sha256, seed, utf8('app.onym.bip39'), utf8('bls12-381-v1'), KEY_BYTES);
  const sendingSeed = hkdf(sha256, nostrSecretKey, utf8('app.onym.ios'), utf8('stellar-ed25519-v1'), KEY_BYTES);
  const inboxSecretKey = hkdf(
    sha256, nostrSecretKey, utf8('app.onym.ios'), utf8('x25519-key-agreement-v1'), KEY_BYTES,
  );
  seed.fill(0);
  return {
    nostrSecretKey, blsSecretKey, sendingSeed, inboxSecretKey,
  };
}

export function getIdentityPublic(secrets: IdentitySecrets): IdentityPublic {
  const sendingPublic = ed25519.getPublicKey(secrets.sendingSeed);
  const inboxPublic = x25519.getPublicKey(secrets.inboxSecretKey);
  return {
    nostrPublicKey: toHex(schnorr.getPublicKey(secrets.nostrSecretKey)),
    blsPublicKey: toHex(getBlsPublicKey(secrets.blsSecretKey)),
    sendingPublicKey: toHex(sendingPublic),
    stellarAccount: encodeStellarAccount(sendingPublic),
    inboxPublicKey: toHex(inboxPublic),
    inboxTag: getInboxTag(inboxPublic),
  };
}

export function getInboxTag(inboxPublicKey: Uint8Array) {
  return toHex(sha256(concatBytes(utf8('sep-inbox-v1'), inboxPublicKey)).slice(0, INBOX_TAG_BYTES));
}

// The BLS secret is read as a big-endian integer mod r (arkworks `from_be_bytes_mod_order`), which is also how
// `Common.leafHash` reads it
export function getBlsScalar(blsSecretKey: Uint8Array) {
  return bls12_381_Fr.create(BigInt(`0x${toHex(blsSecretKey)}`));
}

// Compressed G1, ZCash encoding (arkworks), 48 bytes
export function getBlsPublicKey(blsSecretKey: Uint8Array) {
  const scalar = getBlsScalar(blsSecretKey);
  if (scalar === 0n) throw new Error('Degenerate BLS secret');
  return bls12_381.G1.Point.BASE.multiply(scalar).toBytes(true);
}
