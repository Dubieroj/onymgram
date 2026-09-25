import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  concatBytes, fromHex, toHex, utf8,
} from './bytes';

// A joiner's agreement to a group's rules (onym-ios `GroupRules`): Ed25519 by the joiner's sending key over
// "onym-group-rules-v1" ‖ group id ‖ SHA-256(trimmed rules) ‖ joiner's sending public key
const DOMAIN = 'onym-group-rules-v1';
const TRIMMED = new Set([
  '\u0009', '\u000A', '\u000B', '\u000C', '\u000D', ' ', '\u0085', ' ', ' ', ' ', ' ',
  ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ',
  ' ', ' ', '　',
]);

export function normalizeRules(rules?: string) {
  if (rules === undefined) return undefined;
  const chars = [...rules];
  let start = 0;
  let end = chars.length;
  while (start < end && TRIMMED.has(chars[start])) start++;
  while (end > start && TRIMMED.has(chars[end - 1])) end--;
  const canonical = chars.slice(start, end).join('');
  return canonical || undefined;
}

export function hashRules(rules: string) {
  return toHex(sha256(utf8(normalizeRules(rules) || '')));
}

export function signRulesAgreement(rules: string, groupId: string, sendingSeed: Uint8Array) {
  const sendingPublic = ed25519.getPublicKey(sendingSeed);
  const statement = buildStatement(groupId, hashRules(rules), sendingPublic);
  return { rulesHash: hashRules(rules), rulesSignature: toHex(ed25519.sign(statement, sendingSeed)) };
}

export function isRulesAgreement(signature: string, rules: string, groupId: string, sendingPublicKey: string) {
  try {
    const statement = buildStatement(groupId, hashRules(rules), fromHex(sendingPublicKey));
    return ed25519.verify(fromHex(signature), statement, fromHex(sendingPublicKey));
  } catch {
    return false;
  }
}

function buildStatement(groupId: string, rulesHash: string, sendingPublicKey: Uint8Array) {
  return concatBytes(utf8(DOMAIN), fromHex(groupId), fromHex(rulesHash), sendingPublicKey);
}
