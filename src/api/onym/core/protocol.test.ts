import { describe, expect, it } from 'vitest';

import { toHex, utf8 } from './bytes';
import { buildIdentityLink, parseIdentityLink, parseJoinLink } from './links';
import {
  decodeInboundPayload, encodeChatMessage, encodeJoinRequest, encodeReceipt,
} from './payloads';
import { hashRules, isRulesAgreement, signRulesAgreement } from './rules';

const GROUP_ID = toHex(Uint8Array.from({ length: 32 }, (_, i) => i));
const BLS = 'a5859e962056987df69617fa41318641def18a1f78959951d1cf07bd164a6dcb50962786c8ead48c4e6aab5db6ce8f10';

function base64Url(text: string) {
  return Buffer.from(text).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('group rules (onym-ios GroupRulesVectorTests)', () => {
  const seed = new Uint8Array(32).fill(0x07);
  const rules = 'Be kind. No links.';

  it('hashes the canonical text only', () => {
    expect(hashRules(rules)).toBe('440518f597c71a23fe7d99980df8c2156ac86dcc7f5b49493a4d403819b16473');
    expect(hashRules(`\u3000 ${rules}\n`)).toBe(hashRules(rules));
  });

  it('verifies the foreign signature and its own', () => {
    const publicKey = 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c';
    const foreign = 'd1b32ae2d65faad6f3867c7a47dec90a1c040ccbcb14e70cfbf5c4ce29229eb9'
      + 'c39055e12bacbfb46c3c83940fd5fed61a9747a5c2ef8fc6468db5fc9421810e';
    expect(isRulesAgreement(foreign, rules, GROUP_ID, publicKey)).toBe(true);
    const own = signRulesAgreement(rules, GROUP_ID, seed);
    expect(isRulesAgreement(own.rulesSignature, rules, GROUP_ID, publicKey)).toBe(true);
    expect(isRulesAgreement(own.rulesSignature, 'Other rules', GROUP_ID, publicKey)).toBe(false);
  });
});

describe('links', () => {
  it('parses the join-link vectors (onym-ios IntroCapabilityInteropTests)', () => {
    const pub = Buffer.alloc(32, 1).toString('base64');
    const gid = Buffer.alloc(32, 2).toString('base64');
    const minimal = base64Url(`{"intro_pub":"${pub}","group_id":"${gid}"}`);
    const capability = parseJoinLink(`https://onym.app/join?c=${minimal}`);
    expect(capability).toEqual({
      introPublicKey: '01'.repeat(32), groupId: '02'.repeat(32), groupName: undefined, rules: undefined,
    });
    const named = parseJoinLink(
      `onym://join?c=${base64Url(`{"group_id":"${gid}","group_name":"Family","intro_pub":"${pub}"}`)}`,
    );
    expect(named?.groupName).toBe('Family');
    expect(parseJoinLink('https://example.com/join?c=abc')).toBeUndefined();
  });

  it('round-trips identity links in every accepted form', () => {
    const key = '66ac34309b3b73163b628c2c40174ea76d58d4eb769172611e5c42f9a0cefe5f';
    expect(parseIdentityLink(buildIdentityLink(key))).toBe(key);
    expect(parseIdentityLink(`https://onym.app?payload=${key}`)).toBe(key);
    expect(parseIdentityLink(key.toUpperCase())).toBe(key);
    expect(parseIdentityLink('https://evil.example/i?k=abc')).toBeUndefined();
  });
});

describe('payloads', () => {
  it('encodes chat messages the way the apps decode them', () => {
    const json = JSON.parse(new TextDecoder().decode(encodeChatMessage({
      messageId: 'e621e1f8-c36c-495a-93fc-0c247a3e6e5f',
      groupId: GROUP_ID,
      senderBlsPublicKey: BLS,
      sentAtMs: 1790294655140,
      body: 'Hello / привет',
    })));
    expect(json).toEqual({
      version: 1,
      message_id: 'E621E1F8-C36C-495A-93FC-0C247A3E6E5F',
      group_id: Buffer.from(GROUP_ID, 'hex').toString('base64'),
      sender_bls_pubkey_hex: BLS,
      sent_at_millis: 1790294655140,
      variant: { kind: 'tyranny', body: 'Hello / привет' },
    });
    expect(decodeInboundPayload(utf8(JSON.stringify(json)))).toMatchObject({
      type: 'message', body: 'Hello / привет', variantKind: 'tyranny',
    });
  });

  it('accepts Android nulls and classifies each payload type', () => {
    /* eslint-disable no-null/no-null */
    const gid = Buffer.from(GROUP_ID, 'hex').toString('base64');
    expect(decodeInboundPayload(utf8(JSON.stringify({
      version: 1,
      message_id: 'E621E1F8-C36C-495A-93FC-0C247A3E6E5F',
      group_id: gid,
      sender_bls_pubkey_hex: BLS.toUpperCase(),
      sent_at_millis: 1,
      reply_to_message_id: null,
      variant: { kind: 'tyranny', body: 'x' },
      attachment: null,
      video_attachment: null,
    })))).toMatchObject({ type: 'message', senderBlsPublicKey: BLS, hasUnsupportedMedia: undefined });
    /* eslint-enable no-null/no-null */

    expect(decodeInboundPayload(encodeReceipt({
      groupId: GROUP_ID, senderBlsPublicKey: BLS, kind: 'read', messageIds: ['e621e1f8-c36c-495a-93fc-0c247a3e6e5f'],
    }))).toMatchObject({ type: 'receipt', kind: 'read' });

    expect(decodeInboundPayload(utf8(JSON.stringify({
      offer_version: 1, intro_pub: gid, group_id: gid, inviter_alias: 'Alice',
    })))).toMatchObject({ type: 'offer', inviterAlias: 'Alice', groupId: GROUP_ID });

    expect(decodeInboundPayload(encodeJoinRequest({
      joinerInboxPublicKey: GROUP_ID,
      joinerBlsPublicKey: BLS,
      joinerLeafHash: GROUP_ID,
      joinerSendingPublicKey: GROUP_ID,
      joinerDisplayLabel: 'Bob',
      groupId: GROUP_ID,
    }))).toBeUndefined();
  });
});
