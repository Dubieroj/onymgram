import { describe, expect, it } from 'vitest';

import { decodeWaveform, encodeWaveform } from './waveform';

describe('encodeWaveform', () => {
  it('packs 5-bit values the way decodeWaveform reads them', () => {
    const values = Array.from({ length: 40 }, (_, i) => (i * 7) % 32);

    expect(decodeWaveform(new Uint8Array(encodeWaveform(values)))).toEqual(values);
  });
});
