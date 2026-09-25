import { describe, expect, it } from 'vitest';

import { toHex, utf8 } from './bytes';
import { openEnvelope, sealEnvelope } from './envelope';
import { deriveIdentity, getIdentityPublic } from './identity';

const ALICE = deriveIdentity(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
);
const BOB = deriveIdentity('legal winner thank year wave sausage worth useful legal winner thank yellow');

describe('sealed envelope', () => {
  it('opens for the recipient and names the verified sender', async () => {
    const bobInbox = Uint8Array.from(Buffer.from(getIdentityPublic(BOB).inboxPublicKey, 'hex'));
    const sealed = await sealEnvelope(utf8('{"hello":"world"}'), bobInbox, ALICE.sendingSeed);
    const json = JSON.parse(new TextDecoder().decode(sealed));
    expect(Object.keys(json).sort()).toEqual([
      'authentication_tag', 'ciphertext', 'ephemeral_key_signature', 'ephemeral_public_key', 'nonce', 'scheme',
      'sender_ed25519_public_key', 'version',
    ]);
    expect(json.scheme).toBe('x25519-aes-256-gcm-v1');

    const opened = await openEnvelope(sealed, BOB.inboxSecretKey);
    expect(new TextDecoder().decode(opened.plaintext)).toBe('{"hello":"world"}');
    expect(opened.verifiedSender).toBe(getIdentityPublic(ALICE).sendingPublicKey);
  });

  it('refuses a forged signature and a wrong recipient', async () => {
    const bobInbox = Uint8Array.from(Buffer.from(getIdentityPublic(BOB).inboxPublicKey, 'hex'));
    const sealed = await sealEnvelope(utf8('x'), bobInbox, ALICE.sendingSeed);
    const json = JSON.parse(new TextDecoder().decode(sealed));
    json.sender_ed25519_public_key = Buffer.from(getIdentityPublic(BOB).sendingPublicKey, 'hex').toString('base64');
    await expect(openEnvelope(utf8(JSON.stringify(json)), BOB.inboxSecretKey)).rejects.toThrow();
    await expect(openEnvelope(sealed, ALICE.inboxSecretKey)).rejects.toThrow();
    expect(toHex(ALICE.inboxSecretKey)).not.toBe(toHex(BOB.inboxSecretKey));
  });
});
