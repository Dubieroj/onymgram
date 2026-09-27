import { describe, expect, it } from 'vitest';

import M4aAacWriter from './m4aAacWriter';
import { readAacTrack } from './mp4AacReader';

const MONO_48K = new Uint8Array([0x11, 0x88]);

function u32(value: number) {
  return [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function box(type: string, ...parts: number[][]) {
  const body = parts.flat();
  return [...u32(8 + body.length), ...[...type].map((char) => char.charCodeAt(0)), ...body];
}

function writeM4a(frames: number[][], channels = 1) {
  const writer = new M4aAacWriter({ sampleRate: 48000, channels, bitrate: 64000 });
  writer.setDecoderConfig(MONO_48K);
  frames.forEach((frame) => writer.writePacket(new Uint8Array(frame), 1024));
  return writer.finalize();
}

describe('readAacTrack', () => {
  it('reads back the indexed file M4aAacWriter writes', () => {
    const frames = [[1, 2, 3], [4, 5], [6]];
    const track = readAacTrack(writeM4a(frames))!;

    expect([...track.config]).toEqual([...MONO_48K]);
    expect(track.frames.map((frame) => [...frame])).toEqual(frames);
  });

  it('takes the rate and channels from the AudioSpecificConfig, not the sample entry', () => {
    // Apple's writers put two channels into the sample entry of a mono file
    const track = readAacTrack(writeM4a([[1]], 2))!;

    expect(track.sampleRate).toBe(48000);
    expect(track.channels).toBe(1);
  });

  it('reads the fragments MediaRecorder writes', () => {
    // As Safari lays them out: offsets from the start of `moof`, two runs with their own offsets and sizes
    const tfhd = box('tfhd', u32(0x020018), u32(1), u32(1024), u32(0));
    const trun = (offset: number, sizes: number[]) => box('trun', u32(0x000201), u32(sizes.length), u32(offset),
      ...sizes.map(u32));
    const buildMoof = (first: number, second: number) => box('moof',
      box('mfhd', u32(0), u32(1)),
      box('traf', tfhd, trun(first, [3, 2]), trun(second, [1])));
    const moofSize = buildMoof(0, 0).length;
    const moof = buildMoof(moofSize + 8, moofSize + 8 + 5);
    const mdat = box('mdat', [1, 2, 3, 4, 5, 6]);

    const track = readAacTrack(new Uint8Array([...writeM4a([]), ...moof, ...mdat]))!;

    expect(track.frames.map((frame) => [...frame])).toEqual([[1, 2, 3], [4, 5], [6]]);
  });

  it('refuses a track that is not AAC', () => {
    // Chrome's MediaRecorder writes Opus into MPEG-4 unless AAC is asked for
    const file = writeM4a([[1]]);
    const entry = file.findIndex((_, i) => String.fromCharCode(...file.subarray(i, i + 4)) === 'mp4a');
    file.set([...'Opus'].map((char) => char.charCodeAt(0)), entry);

    expect(readAacTrack(file)).toBeUndefined();
  });
});
