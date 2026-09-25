import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';

import { BIP39_WORDS } from './bip39Words';

const WORD_INDEX = new Map(BIP39_WORDS.map((word, i) => [word, i]));
const PHRASE_LENGTHS = new Set([12, 15, 18, 21, 24]);
const NEW_PHRASE_ENTROPY_BYTES = 16;
const SEED_ITERATIONS = 2048;
const SEED_BYTES = 64;

export type PhraseProblem = 'length' | 'word' | 'checksum';

export function normalizePhrase(phrase: string) {
  return phrase.toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

// Invalid phrases are refused, never corrected (Identity-BIP39 §4.1)
export function checkPhrase(phrase: string): PhraseProblem | undefined {
  const words = normalizePhrase(phrase).split(' ');
  if (!PHRASE_LENGTHS.has(words.length)) return 'length';
  if (words.some((word) => !WORD_INDEX.has(word))) return 'word';

  const bits = words.map((word) => WORD_INDEX.get(word)!.toString(2).padStart(11, '0')).join('');
  const checksumBits = bits.length / 33;
  const entropy = bitsToBytes(bits.slice(0, bits.length - checksumBits));
  return bits.slice(bits.length - checksumBits) === checksumOf(entropy, checksumBits) ? undefined : 'checksum';
}

export function entropyToPhrase(entropy: Uint8Array) {
  const bits = [...entropy].map((byte) => byte.toString(2).padStart(8, '0')).join('')
    + checksumOf(entropy, entropy.length / 4);
  return bits.match(/.{11}/g)!.map((chunk) => BIP39_WORDS[parseInt(chunk, 2)]).join(' ');
}

export function generatePhrase() {
  return entropyToPhrase(crypto.getRandomValues(new Uint8Array(NEW_PHRASE_ENTROPY_BYTES)));
}

export function phraseToSeed(phrase: string) {
  const password = new TextEncoder().encode(normalizePhrase(phrase).normalize('NFKD'));
  return pbkdf2(sha512, password, new TextEncoder().encode('mnemonic'), { c: SEED_ITERATIONS, dkLen: SEED_BYTES });
}

function checksumOf(entropy: Uint8Array, bitCount: number) {
  return sha256(entropy)[0].toString(2).padStart(8, '0').slice(0, bitCount);
}

function bitsToBytes(bits: string) {
  return Uint8Array.from(bits.match(/.{8}/g)!.map((chunk) => parseInt(chunk, 2)));
}
