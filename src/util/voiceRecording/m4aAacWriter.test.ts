import { describe, expect, it } from 'vitest';

import M4aAacWriter from './m4aAacWriter';

function readBoxes(bytes: Uint8Array, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: { type: string; start: number; size: number }[] = [];
  for (let offset = start; offset < end;) {
    const size = view.getUint32(offset);
    boxes.push({ type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)), start: offset, size });
    offset += size;
  }
  return boxes;
}

function find(bytes: Uint8Array, type: string) {
  const code = [...type].map((char) => char.charCodeAt(0));
  for (let i = 4; i < bytes.length - 4; i++) {
    if (code.every((byte, j) => bytes[i + j] === byte)) return i - 4;
  }
  return -1;
}

describe('M4aAacWriter', () => {
  it('writes one AAC track with its index ahead of the data it points to', () => {
    const writer = new M4aAacWriter({ sampleRate: 48000, channels: 1, bitrate: 64000 });
    writer.setDecoderConfig(new Uint8Array([0x11, 0x88]));
    const frames = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];
    frames.forEach((frame) => writer.writePacket(frame, 1024));
    const file = writer.finalize();
    const view = new DataView(file.buffer);

    expect(readBoxes(file).map(({ type }) => type)).toEqual(['ftyp', 'moov', 'mdat']);

    const mdat = readBoxes(file).find(({ type }) => type === 'mdat')!;
    expect([...file.subarray(mdat.start + 8, mdat.start + mdat.size)]).toEqual([1, 2, 3, 4, 5, 6]);

    const stco = find(file, 'stco');
    expect(view.getUint32(stco + 16)).toBe(mdat.start + 8);

    const stsz = find(file, 'stsz');
    expect(view.getUint32(stsz + 16)).toBe(3);
    expect([20, 24, 28].map((offset) => view.getUint32(stsz + offset))).toEqual([3, 2, 1]);

    const mvhd = find(file, 'mvhd');
    expect(view.getUint32(mvhd + 20)).toBe(48000);
    expect(view.getUint32(mvhd + 24)).toBe(3 * 1024);

    const esds = find(file, 'esds');
    expect([...file.subarray(esds, esds + 128)].join(',')).toContain([0x05, 0x80, 0x80, 0x80, 2, 0x11, 0x88].join(','));
  });
});
