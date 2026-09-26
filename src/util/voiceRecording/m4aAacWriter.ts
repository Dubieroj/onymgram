// Packs raw AAC frames from WebCodecs into an MPEG-4 audio file (.m4a) as AVAudioRecorder and Android's
// MediaRecorder write one: a single sound track, every frame in one chunk, the index (moov) before the data, so
// AVAudioPlayer (AudioToolbox) and Android's MediaPlayer open it without streaming support
const AAC_LC_OBJECT_TYPE = 2;
const AUDIO_OBJECT_TYPE_INDICATION = 0x40;
const AUDIO_STREAM_TYPE = 0x05;
const SAMPLING_FREQUENCIES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const UNDETERMINED_LANGUAGE = 0x55c4;
const UNITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

type Options = { sampleRate: number; channels: number; bitrate: number };

export default class M4aAacWriter {
  private frames: Uint8Array[] = [];

  private durations: number[] = [];

  private audioSpecificConfig?: Uint8Array;

  constructor(private options: Options) {}

  // The encoder's `decoderConfig.description`: the AudioSpecificConfig of the stream
  setDecoderConfig(description: Uint8Array) {
    this.audioSpecificConfig = description.slice();
  }

  writePacket(frame: Uint8Array, durationSamples: number) {
    this.frames.push(frame);
    this.durations.push(durationSamples);
  }

  finalize(): Uint8Array {
    const ftyp = box('ftyp', ascii('M4A '), u32(0), ascii('M4A '), ascii('mp42'), ascii('isom'));
    const payloadSize = this.frames.reduce((sum, frame) => sum + frame.length, 0);
    // The chunk offset is a fixed-width field, so the index measures the same whatever offset it carries
    const moovSize = this.buildMoov(0).length;
    const moov = this.buildMoov(ftyp.length + moovSize + 8);
    const mdat = new Uint8Array(8 + payloadSize);
    mdat.set(u32(8 + payloadSize), 0);
    mdat.set(ascii('mdat'), 4);
    let offset = 8;
    this.frames.forEach((frame) => {
      mdat.set(frame, offset);
      offset += frame.length;
    });
    return concat(ftyp, moov, mdat);
  }

  private buildMoov(chunkOffset: number) {
    const { sampleRate, channels, bitrate } = this.options;
    const duration = this.durations.reduce((sum, samples) => sum + samples, 0);
    const maxFrame = this.frames.reduce((max, frame) => Math.max(max, frame.length), 0);

    const mvhd = fullBox('mvhd', 0, 0,
      u32(0), u32(0), u32(sampleRate), u32(duration), u32(0x00010000), u16(0x0100), zeros(10),
      ...UNITY_MATRIX.map(u32), zeros(24), u32(2));
    const tkhd = fullBox('tkhd', 0, 3,
      u32(0), u32(0), u32(1), u32(0), u32(duration), zeros(8), u16(0), u16(0), u16(0x0100), u16(0),
      ...UNITY_MATRIX.map(u32), u32(0), u32(0));
    const mdhd = fullBox('mdhd', 0, 0,
      u32(0), u32(0), u32(sampleRate), u32(duration), u16(UNDETERMINED_LANGUAGE), u16(0));
    const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii('soun'), zeros(12), ascii('SoundHandler\0'));

    const esds = fullBox('esds', 0, 0, descriptor(0x03,
      u16(1), u8(0),
      descriptor(0x04,
        u8(AUDIO_OBJECT_TYPE_INDICATION), u8((AUDIO_STREAM_TYPE << 2) | 1), u24(maxFrame), u32(bitrate), u32(bitrate),
        descriptor(0x05, this.audioSpecificConfig || buildAudioSpecificConfig(sampleRate, channels))),
      descriptor(0x06, u8(2))));
    const mp4a = box('mp4a',
      zeros(6), u16(1), zeros(8), u16(channels), u16(16), u16(0), u16(0), u32(sampleRate * 0x10000), esds);

    const stbl = box('stbl',
      fullBox('stsd', 0, 0, u32(1), mp4a),
      fullBox('stts', 0, 0, ...buildTimeToSample(this.durations)),
      fullBox('stsc', 0, 0, u32(1), u32(1), u32(this.frames.length), u32(1)),
      fullBox('stsz', 0, 0, u32(0), u32(this.frames.length), ...this.frames.map((frame) => u32(frame.length))),
      fullBox('stco', 0, 0, u32(1), u32(chunkOffset)));
    const minf = box('minf',
      fullBox('smhd', 0, 0, u16(0), u16(0)),
      box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
      stbl);

    return box('moov', mvhd, box('trak', tkhd, box('mdia', mdhd, hdlr, minf)));
  }
}

// Runs of equal frame durations (every AAC frame is 1024 samples)
function buildTimeToSample(durations: number[]) {
  const runs: [number, number][] = [];
  durations.forEach((duration) => {
    const last = runs[runs.length - 1];
    if (last && last[1] === duration) last[0]++;
    else runs.push([1, duration]);
  });
  return [u32(runs.length), ...runs.flatMap(([count, duration]) => [u32(count), u32(duration)])];
}

// AAC-LC for the given rate and channel count, for an encoder that does not report its own
function buildAudioSpecificConfig(sampleRate: number, channels: number) {
  const frequencyIndex = SAMPLING_FREQUENCIES.indexOf(sampleRate);
  const value = (AAC_LC_OBJECT_TYPE << 11) | (frequencyIndex << 7) | (channels << 3);
  return new Uint8Array([value >> 8, value & 0xff]);
}

function descriptor(tag: number, ...payloads: Uint8Array[]) {
  const body = concat(...payloads);
  // The four-byte length form, as Apple's writer uses it
  const length = [0x80 | ((body.length >> 21) & 0x7f), 0x80 | ((body.length >> 14) & 0x7f),
    0x80 | ((body.length >> 7) & 0x7f), body.length & 0x7f];
  return concat(new Uint8Array([tag, ...length]), body);
}

function box(type: string, ...payloads: Uint8Array[]) {
  const body = concat(...payloads);
  return concat(u32(8 + body.length), ascii(type), body);
}

function fullBox(type: string, version: number, flags: number, ...payloads: Uint8Array[]) {
  return box(type, u8(version), u24(flags), ...payloads);
}

function concat(...parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  parts.forEach((part) => {
    result.set(part, offset);
    offset += part.length;
  });
  return result;
}

function u8(value: number) {
  return new Uint8Array([value & 0xff]);
}

function u16(value: number) {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

function u24(value: number) {
  return new Uint8Array([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function u32(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0);
  return bytes;
}

function zeros(length: number) {
  return new Uint8Array(length);
}

function ascii(text: string) {
  return new Uint8Array([...text].map((char) => char.charCodeAt(0)));
}
