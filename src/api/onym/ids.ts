import { sha256 } from '@noble/hashes/sha2.js';

import { utf8 } from './core/bytes';

// Telegram's UI keys peers by numeric strings: users positive, basic groups negative above `-CHANNEL_ID_BASE`.
// Onym names peers by keys and group ids, so each is mapped to a stable number derived from its hash
const USER_ID_BITS = 48n;
const GROUP_ID_BITS = 39n;

export function toUserId(onymKey: string) {
  return String(hashToInteger(`user:${onymKey}`, USER_ID_BITS) + 1n);
}

export function toGroupChatId(onymGroupId: string) {
  return String(-(hashToInteger(`group:${onymGroupId}`, GROUP_ID_BITS) + 1n));
}

function hashToInteger(label: string, bits: bigint) {
  const digest = sha256(utf8(label));
  let value = 0n;
  for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(digest[i]);
  return value & ((1n << bits) - 1n);
}
