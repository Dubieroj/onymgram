import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  fromBase64, fromHex, toBase64, toHex, utf8,
} from './bytes';

// Onym message courier over Nostr: `onym:message-implementation:nostr-courier-v1` (UI-Message-Nostr.md). The apps
// carry every payload through per-recipient inboxes; the profile's group topics (kind 44114) are unused
export const INBOX_KIND = 34113;
export const INBOX_LEGACY_KIND = 24113;

const MAX_EVENT_TAGS = 16;
const MAX_TAG_VALUE_LENGTH = 1024;
const MAX_CONTENT_LENGTH = 1_048_576;

export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export type NostrFilter = {
  kinds?: number[];
  '#t'?: string[];
  '#d'?: string[];
};

export function computeEventId(event: Omit<NostrEvent, 'id' | 'sig'>, shouldEscapeSlashes = false) {
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  return toHex(sha256(utf8(shouldEscapeSlashes ? serialized.replace(/\//g, '\\/') : serialized)));
}

// Every event is signed by a fresh key (§5): it reduces stable sender correlation and is not an Onym identity;
// the sealed envelope authenticates the sender on its own
export function signWithEphemeralKey(kind: number, tags: string[][], content: string, nowMs = Date.now()) {
  const secretKey = schnorr.utils.randomSecretKey();
  const pubkey = toHex(schnorr.getPublicKey(secretKey));
  const unsigned = {
    pubkey,
    created_at: Math.floor(nowMs / 1000),
    kind,
    tags: [...tags, ['ms', String(nowMs)]],
    content,
  };
  const id = computeEventId(unsigned);
  const sig = toHex(schnorr.sign(fromHex(id), secretKey));
  secretKey.fill(0);
  return { ...unsigned, id, sig } satisfies NostrEvent;
}

export function buildInboxEvent(inbox: string, payload: Uint8Array, nowMs?: number) {
  return signWithEphemeralKey(INBOX_KIND, [
    ['d', `sep-inbox:${inbox}`],
    ['t', inbox],
    ['sep_inbox', inbox],
    ['sep_version', '1'],
  ], toBase64(payload), nowMs);
}

// One `REQ` with three filters: canonical `d`, the same-kind `t` path, and the receive-only legacy kind (§7.2)
export function buildInboxFilters(inbox: string): NostrFilter[] {
  return [
    { kinds: [INBOX_KIND], '#d': [`sep-inbox:${inbox}`] },
    { kinds: [INBOX_KIND], '#t': [inbox] },
    { kinds: [INBOX_LEGACY_KIND], '#t': [inbox] },
  ];
}

// Outer validation (§9): exact shape, canonical id, BIP-340 signature, allowed kind and the requested address
// relation, strict base64. A relay is not trusted to have applied the filter
export function openInboxEvent(raw: unknown, inbox: string): { event: NostrEvent; payload: Uint8Array } | undefined {
  const event = parseEvent(raw);
  if (!event) return undefined;
  if (!isAddressedTo(event, inbox)) return undefined;
  // The apps hash `/` escaped as `\/` (Foundation `JSONSerialization`, `org.json`), which NIP-01 does not; the base64
  // content they send never contains a slash, so both forms agree on real traffic, and either is accepted
  if (computeEventId(event) !== event.id && computeEventId(event, true) !== event.id) return undefined;

  try {
    if (!schnorr.verify(fromHex(event.sig), fromHex(event.id), fromHex(event.pubkey))) return undefined;
    return { event, payload: fromBase64(event.content) };
  } catch {
    return undefined;
  }
}

export function getEventTimeMs(event: NostrEvent) {
  const ms = event.tags.find(([name]) => name === 'ms')?.[1];
  const parsed = ms && /^\d{1,16}$/.test(ms) ? Number(ms) : undefined;
  return parsed ?? event.created_at * 1000;
}

function isAddressedTo(event: NostrEvent, inbox: string) {
  const hasTag = (name: string, value: string) => event.tags.some((tag) => tag[0] === name && tag[1] === value);
  if (event.kind === INBOX_KIND) return hasTag('d', `sep-inbox:${inbox}`) || hasTag('t', inbox);
  return event.kind === INBOX_LEGACY_KIND && hasTag('t', inbox);
}

function parseEvent(raw: unknown): NostrEvent | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const {
    id, pubkey, created_at: createdAt, kind, tags, content, sig,
  } = raw as Record<string, unknown>;

  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) return undefined;
  if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(pubkey)) return undefined;
  if (typeof sig !== 'string' || !/^[0-9a-f]{128}$/.test(sig)) return undefined;
  if (!Number.isSafeInteger(createdAt) || (createdAt as number) < 0) return undefined;
  if (!Number.isSafeInteger(kind)) return undefined;
  if (typeof content !== 'string' || content.length > MAX_CONTENT_LENGTH) return undefined;
  if (!Array.isArray(tags) || tags.length > MAX_EVENT_TAGS) return undefined;
  if (!tags.every((tag) => Array.isArray(tag) && tag.every(
    (item) => typeof item === 'string' && item.length <= MAX_TAG_VALUE_LENGTH,
  ))) return undefined;

  return {
    id, pubkey, created_at: createdAt as number, kind: kind as number, tags: tags as string[][], content, sig,
  };
}
