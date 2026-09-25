import { schnorr } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'vitest';

import { fromHex, toHex, utf8 } from './bytes';
import {
  buildInboxEvent, buildInboxFilters, computeEventId, getEventTimeMs, INBOX_KIND, openInboxEvent,
} from './nostr';

const NOW_MS = 1785580800123;

describe('nostr courier', () => {
  it('builds inbox events with the exact application tags', () => {
    const event = buildInboxEvent('inbox-1', utf8('sealed'), NOW_MS);
    expect(event.kind).toBe(INBOX_KIND);
    expect(event.created_at).toBe(1785580800);
    expect(event.tags).toEqual([
      ['d', 'sep-inbox:inbox-1'], ['t', 'inbox-1'], ['sep_inbox', 'inbox-1'], ['sep_version', '1'],
      ['ms', String(NOW_MS)],
    ]);
    expect(getEventTimeMs(event)).toBe(NOW_MS);
  });

  it('opens an event under its own inbox only', () => {
    const event = buildInboxEvent('inbox-1', utf8('sealed'), NOW_MS);
    expect(new TextDecoder().decode(openInboxEvent(event, 'inbox-1')!.payload)).toBe('sealed');
    expect(openInboxEvent(event, 'inbox-2')).toBeUndefined();
  });

  it('uses a fresh outer key for every event', () => {
    const first = buildInboxEvent('i', utf8('x'), NOW_MS);
    const second = buildInboxEvent('i', utf8('x'), NOW_MS);
    expect(first.pubkey).not.toBe(second.pubkey);
  });

  it('rejects tampered events', () => {
    const event = buildInboxEvent('i', utf8('x'), NOW_MS);
    expect(openInboxEvent({ ...event, content: 'eQ==' }, 'i')).toBeUndefined();
    expect(openInboxEvent({ ...event, sig: event.sig.replace(/^./, event.sig[0] === 'a' ? 'b' : 'a') }, 'i'))
      .toBeUndefined();
  });

  it('accepts ids hashed with slashes escaped, as the apps compute them', () => {
    const secretKey = schnorr.utils.randomSecretKey();
    const unsigned = {
      pubkey: toHex(schnorr.getPublicKey(secretKey)),
      created_at: 1,
      kind: INBOX_KIND,
      tags: [['d', 'sep-inbox:i'], ['t', 'i']],
      content: '////',
    };
    const id = computeEventId(unsigned, true);
    expect(id).not.toBe(computeEventId(unsigned));
    const event = { ...unsigned, id, sig: toHex(schnorr.sign(fromHex(id), secretKey)) };
    expect(openInboxEvent(event, 'i')).toBeDefined();
  });

  it('asks for all three inbox filters in one request', () => {
    expect(buildInboxFilters('i')).toEqual([
      { kinds: [34113], '#d': ['sep-inbox:i'] },
      { kinds: [34113], '#t': ['i'] },
      { kinds: [24113], '#t': ['i'] },
    ]);
  });
});
