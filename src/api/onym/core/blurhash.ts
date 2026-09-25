// BlurHash encoder (https://github.com/woltapp/blurhash): the placeholder the Onym apps draw while a photo loads.
// onym-android requires it on every image attachment, so a photo sent from here always carries one
const BASE83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

export function encodeBlurhash(
  pixels: Uint8ClampedArray, width: number, height: number, xComponents = 4, yComponents = 3,
) {
  const factors: [number, number, number][] = [];
  for (let y = 0; y < yComponents; y++) {
    for (let x = 0; x < xComponents; x++) {
      const normalisation = x === 0 && y === 0 ? 1 : 2;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
          const basis = normalisation * Math.cos((Math.PI * x * i) / width) * Math.cos((Math.PI * y * j) / height);
          const offset = 4 * (j * width + i);
          r += basis * srgbToLinear(pixels[offset]);
          g += basis * srgbToLinear(pixels[offset + 1]);
          b += basis * srgbToLinear(pixels[offset + 2]);
        }
      }
      const scale = 1 / (width * height);
      factors.push([r * scale, g * scale, b * scale]);
    }
  }

  const [dc, ...ac] = factors;
  let hash = encode83((xComponents - 1) + (yComponents - 1) * 9, 1);

  let maximumValue = 1;
  if (ac.length) {
    // The reference encoder takes the largest signed value, not the largest magnitude
    const actualMaximum = Math.max(...ac.flat());
    const quantisedMaximum = Math.floor(Math.max(0, Math.min(82, Math.floor(actualMaximum * 166 - 0.5))));
    maximumValue = (quantisedMaximum + 1) / 166;
    hash += encode83(quantisedMaximum, 1);
  } else {
    hash += encode83(0, 1);
  }

  hash += encode83((linearToSrgb(dc[0]) << 16) + (linearToSrgb(dc[1]) << 8) + linearToSrgb(dc[2]), 4);
  ac.forEach((factor) => {
    const [r, g, b] = factor.map((value) => Math.floor(
      Math.max(0, Math.min(18, Math.floor(signPow(value / maximumValue, 0.5) * 9 + 9.5))),
    ));
    hash += encode83(r * 19 * 19 + g * 19 + b, 2);
  });
  return hash;
}

function encode83(value: number, length: number) {
  let result = '';
  for (let i = 1; i <= length; i++) {
    result += BASE83[Math.floor(value / 83 ** (length - i)) % 83];
  }
  return result;
}

function srgbToLinear(value: number) {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number) {
  const v = Math.max(0, Math.min(1, value));
  return v <= 0.0031308 ? Math.trunc(v * 12.92 * 255 + 0.5) : Math.trunc((1.055 * v ** (1 / 2.4) - 0.055) * 255 + 0.5);
}

function signPow(value: number, exponent: number) {
  return Math.sign(value) * Math.abs(value) ** exponent;
}
