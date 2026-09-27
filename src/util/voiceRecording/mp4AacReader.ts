// Reads the AAC frames and their AudioSpecificConfig out of an MPEG-4 file, indexed or fragmented (MediaRecorder writes
// fragments), so M4aAacWriter can write them again as the one indexed file the Onym apps open
export type AacTrack = {
  config: Uint8Array;
  sampleRate: number;
  channels: number;
  frames: Uint8Array[];
};

type Box = { type: string; start: number; end: number; body: number };

const AUDIO_SAMPLE_ENTRY_SIZE = 28;
const SAMPLING_FREQUENCIES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const ES_DESCRIPTOR_TAG = 0x03;
const DECODER_CONFIG_TAG = 0x04;
const DECODER_SPECIFIC_INFO_TAG = 0x05;
// objectTypeIndication, streamType, bufferSizeDB, maxBitrate, avgBitrate
const DECODER_CONFIG_FIXED_SIZE = 13;

// `tfhd` and `trun` flags (ISO/IEC 14496-12 §8.8.7, §8.8.8)
const TFHD_BASE_DATA_OFFSET = 0x01;
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x02;
const TFHD_DEFAULT_DURATION = 0x08;
const TFHD_DEFAULT_SIZE = 0x10;
const TRUN_DATA_OFFSET = 0x01;
const TRUN_FIRST_SAMPLE_FLAGS = 0x04;
const TRUN_DURATION = 0x100;
const TRUN_SIZE = 0x200;
const TRUN_FLAGS = 0x400;
const TRUN_COMPOSITION_OFFSET = 0x800;

export function readAacTrack(file: Uint8Array): AacTrack | undefined {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const top = readBoxes(file, view, 0, file.length);
  const stbl = find(file, view, top, ['moov', 'trak', 'mdia', 'minf', 'stbl']);
  const stsd = stbl && readBoxes(file, view, stbl.body, stbl.end).find(({ type }) => type === 'stsd');
  if (!stbl || !stsd) return undefined;

  // The first sample entry must be AAC: `mp4a` with its `esds`
  const [entry] = readBoxes(file, view, stsd.body + 8, stsd.end);
  if (entry?.type !== 'mp4a') return undefined;
  const esds = readBoxes(file, view, entry.body + AUDIO_SAMPLE_ENTRY_SIZE, entry.end)
    .find(({ type }) => type === 'esds');
  const config = esds && readDecoderSpecificInfo(file, esds.body + 4, esds.end);
  if (!config) return undefined;
  // The AudioSpecificConfig is the truth: Apple writes two channels into the sample entry of a mono file
  const { sampleRate, channels } = readAudioSpecificConfig(config) || {
    channels: view.getUint16(entry.body + 16), sampleRate: view.getUint32(entry.body + 24) >>> 16,
  };

  const frames = [
    ...readIndexedSamples(file, view, readBoxes(file, view, stbl.body, stbl.end)),
    ...top.filter(({ type }) => type === 'moof').flatMap((moof) => readFragmentSamples(file, view, moof)),
  ];
  return {
    config, sampleRate, channels, frames,
  };
}

function readIndexedSamples(file: Uint8Array, view: DataView, boxes: Box[]) {
  const stsz = boxes.find(({ type }) => type === 'stsz');
  const stsc = boxes.find(({ type }) => type === 'stsc');
  const chunkOffsets = boxes.find(({ type }) => type === 'stco' || type === 'co64');
  if (!stsz || !stsc || !chunkOffsets) return [];

  const fixedSize = view.getUint32(stsz.body + 4);
  const count = view.getUint32(stsz.body + 8);
  const sizes = Array.from({ length: count }, (_, i) => fixedSize || view.getUint32(stsz.body + 12 + i * 4));

  const isLong = chunkOffsets.type === 'co64';
  const chunkCount = view.getUint32(chunkOffsets.body + 4);
  const offsets = Array.from({ length: chunkCount }, (_, i) => (isLong
    ? Number(view.getBigUint64(chunkOffsets.body + 8 + i * 8))
    : view.getUint32(chunkOffsets.body + 8 + i * 4)));

  const runs = Array.from({ length: view.getUint32(stsc.body + 4) }, (_, i) => ({
    firstChunk: view.getUint32(stsc.body + 8 + i * 12),
    samplesPerChunk: view.getUint32(stsc.body + 12 + i * 12),
  }));

  const frames: Uint8Array[] = [];
  let sample = 0;
  offsets.forEach((chunkOffset, chunk) => {
    const run = [...runs].reverse().find(({ firstChunk }) => firstChunk <= chunk + 1);
    let offset = chunkOffset;
    for (let i = 0; i < (run?.samplesPerChunk || 0) && sample < count; i++, sample++) {
      frames.push(file.slice(offset, offset + sizes[sample]));
      offset += sizes[sample];
    }
  });
  return frames;
}

function readFragmentSamples(file: Uint8Array, view: DataView, moof: Box) {
  return readBoxes(file, view, moof.body, moof.end).filter(({ type }) => type === 'traf').flatMap((traf) => {
    const boxes = readBoxes(file, view, traf.body, traf.end);
    const tfhd = boxes.find(({ type }) => type === 'tfhd');
    if (!tfhd) return [];

    const tfhdFlags = view.getUint32(tfhd.body) & 0xffffff;
    let cursor = tfhd.body + 8;
    let base = moof.start;
    if (tfhdFlags & TFHD_BASE_DATA_OFFSET) {
      base = Number(view.getBigUint64(cursor));
      cursor += 8;
    }
    if (tfhdFlags & TFHD_SAMPLE_DESCRIPTION_INDEX) cursor += 4;
    if (tfhdFlags & TFHD_DEFAULT_DURATION) cursor += 4;
    const defaultSize = tfhdFlags & TFHD_DEFAULT_SIZE ? view.getUint32(cursor) : 0;

    const frames: Uint8Array[] = [];
    let dataEnd = base;
    boxes.filter(({ type }) => type === 'trun').forEach((trun) => {
      const flags = view.getUint32(trun.body) & 0xffffff;
      const count = view.getUint32(trun.body + 4);
      let at = trun.body + 8;
      let offset = dataEnd;
      if (flags & TRUN_DATA_OFFSET) {
        offset = base + view.getInt32(at);
        at += 4;
      }
      if (flags & TRUN_FIRST_SAMPLE_FLAGS) at += 4;
      for (let i = 0; i < count; i++) {
        if (flags & TRUN_DURATION) at += 4;
        let size = defaultSize;
        if (flags & TRUN_SIZE) {
          size = view.getUint32(at);
          at += 4;
        }
        if (flags & TRUN_FLAGS) at += 4;
        if (flags & TRUN_COMPOSITION_OFFSET) at += 4;
        frames.push(file.slice(offset, offset + size));
        offset += size;
      }
      dataEnd = offset;
    });
    return frames;
  });
}

// ISO/IEC 14496-3 §1.6.2.1: five bits of object type, four of frequency index, four of channel configuration
function readAudioSpecificConfig(config: Uint8Array) {
  if (config.length < 2 || config[0] >> 3 === 31) return undefined;
  const frequencyIndex = ((config[0] & 0x07) << 1) | (config[1] >> 7);
  const channels = (config[1] >> 3) & 0x0f;
  const sampleRate = SAMPLING_FREQUENCIES[frequencyIndex];
  return sampleRate && channels ? { sampleRate, channels } : undefined;
}

// ES_Descriptor → DecoderConfigDescriptor → DecoderSpecificInfo, whose body is the AudioSpecificConfig
function readDecoderSpecificInfo(file: Uint8Array, start: number, end: number): Uint8Array | undefined {
  let at = start;
  while (at < end) {
    const tag = file[at++];
    let length = 0;
    for (let i = 0; i < 4; i++) {
      const byte = file[at++];
      length = (length << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    if (tag === DECODER_SPECIFIC_INFO_TAG) return file.slice(at, at + length);
    // Step into the ES and DecoderConfig descriptors past their fixed fields; skip anything else
    if (tag === ES_DESCRIPTOR_TAG) {
      const flags = file[at + 2];
      at += 3;
      if (flags & 0x80) at += 2;
      if (flags & 0x40) at += 1 + file[at];
      if (flags & 0x20) at += 2;
    } else if (tag === DECODER_CONFIG_TAG) {
      at += DECODER_CONFIG_FIXED_SIZE;
    } else {
      at += length;
    }
  }
  return undefined;
}

function find(file: Uint8Array, view: DataView, boxes: Box[], path: string[]): Box | undefined {
  const [type, ...rest] = path;
  for (const box of boxes.filter((candidate) => candidate.type === type)) {
    if (!rest.length) return box;
    const found = find(file, view, readBoxes(file, view, box.body, box.end), rest);
    if (found) return found;
  }
  return undefined;
}

function readBoxes(file: Uint8Array, view: DataView, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) break;
    const type = String.fromCharCode(...file.subarray(at + 4, at + 8));
    boxes.push({
      type, start: at, end: at + size, body: at + header,
    });
    at += size;
  }
  return boxes;
}
