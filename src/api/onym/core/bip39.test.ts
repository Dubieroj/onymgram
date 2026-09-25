import { describe, expect, it } from 'vitest';

import {
  checkPhrase, entropyToPhrase, generatePhrase, phraseToSeed,
} from './bip39';
import { toHex } from './bytes';

const ABANDON_ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('bip39', () => {
  it('derives the reference seed without a passphrase', () => {
    expect(toHex(phraseToSeed(ABANDON_ABOUT))).toBe(
      '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1'
      + '9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4',
    );
  });

  it('refuses invalid phrases instead of correcting them', () => {
    expect(checkPhrase(ABANDON_ABOUT)).toBeUndefined();
    expect(checkPhrase(`  ${ABANDON_ABOUT.toUpperCase()}  `)).toBeUndefined();
    expect(checkPhrase(ABANDON_ABOUT.replace(/about$/, 'abandon'))).toBe('checksum');
    expect(checkPhrase(ABANDON_ABOUT.replace(/about$/, 'aboutt'))).toBe('word');
    expect(checkPhrase('abandon about')).toBe('length');
  });

  it('round-trips generated phrases', () => {
    const phrase = generatePhrase();
    expect(phrase.split(' ')).toHaveLength(12);
    expect(checkPhrase(phrase)).toBeUndefined();
    expect(entropyToPhrase(new Uint8Array(16))).toBe(ABANDON_ABOUT);
  });
});
