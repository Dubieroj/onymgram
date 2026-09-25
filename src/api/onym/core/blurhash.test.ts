import { describe, expect, it } from 'vitest';

import { encodeBlurhash } from './blurhash';

// Expected values come from the reference encoder (npm `blurhash` 2.x, woltapp)
describe('blurhash', () => {
  it('encodes a gradient as the reference does', () => {
    const width = 32;
    const height = 24;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = 4 * (y * width + x);
        pixels.set([x * 8, y * 10, 200 - x * 3, 255], offset);
      }
    }
    expect(encodeBlurhash(pixels, width, height)).toBe('LWH27[2|,cT0qSWFjuahgcfjfQfj');
  });

  it('encodes a solid image as the reference does', () => {
    expect(encodeBlurhash(new Uint8ClampedArray(16 * 16 * 4).fill(255), 16, 16)).toBe('LKTSUA~qfQ~q~qoffQoffQfQfQfQ');
  });
});
