import { describe, expect, it } from 'vitest';

import { deriveIdentity, getIdentityPublic } from './identity';

// onym-ios `IdentityRepositoryTests.test_derivation_matchesCrossPlatformFixture`
const ABANDON_ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('identity', () => {
  it('derives every key the Onym apps pin for the reference phrase', () => {
    expect(getIdentityPublic(deriveIdentity(ABANDON_ABOUT))).toEqual({
      nostrPublicKey: 'd8631b8e96d3d3d6d42cdadd07bc6db04108367dc2ce2d5e9b9a524123dc0821',
      blsPublicKey: 'a5859e962056987df69617fa41318641def18a1f78959951d1cf07bd'
        + '164a6dcb50962786c8ead48c4e6aab5db6ce8f10',
      sendingPublicKey: '7a33c09cdb7f51fe723a4003d2f28272cddc8fa2cf3d74a374a5f2ee6fb1fcdc',
      stellarAccount: 'GB5DHQE43N7VD7TSHJAAHUXSQJZM3XEPULHT25FDOSS7F3TPWH6NYJ7A',
      inboxPublicKey: '66ac34309b3b73163b628c2c40174ea76d58d4eb769172611e5c42f9a0cefe5f',
      inboxTag: 'f462ae97384bd242',
    });
  });
});
