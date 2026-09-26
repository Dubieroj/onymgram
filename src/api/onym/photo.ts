import type { ImageAttachment, VoiceAttachment } from './core/payloads';

import { decodeWaveform } from '../../util/waveform';
import { encryptBlob, uploadBlob } from './core/blossom';
import { encodeBlurhash } from './core/blurhash';
import { getSettings } from './settings';

// The composer has already scaled the photo to a JPEG; this measures it, draws its BlurHash from a small sample,
// encrypts it and uploads the ciphertext, returning the descriptor that travels inside the sealed message
const BLURHASH_SAMPLE_SIZE = 32;
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
// As both apps record and play a voice clip: AAC in MPEG-4, a waveform of 40 bars scaled to 0…255
const VOICE_MIME_TYPE = 'audio/mp4';
const VOICE_WAVEFORM_BARS = 40;

export async function uploadPhoto(photo: Blob): Promise<ImageAttachment> {
  const bytes = new Uint8Array(await photo.arrayBuffer());
  const bitmap = await createImageBitmap(photo);
  const { width, height } = bitmap;
  const scale = BLURHASH_SAMPLE_SIZE / Math.max(width, height);
  const sampleWidth = Math.max(1, Math.round(width * scale));
  const sampleHeight = Math.max(1, Math.round(height * scale));
  const context = new OffscreenCanvas(sampleWidth, sampleHeight).getContext('2d')!;
  context.drawImage(bitmap, 0, 0, sampleWidth, sampleHeight);
  bitmap.close();
  const { data } = context.getImageData(0, 0, sampleWidth, sampleHeight);
  const blurhash = encodeBlurhash(data, sampleWidth, sampleHeight);

  const mimeType = JPEG_MAGIC.every((byte, i) => bytes[i] === byte) ? 'image/jpeg' : photo.type || 'image/jpeg';
  const { blob, hash, keyHex } = await encryptBlob(bytes);
  const [server] = getSettings().blossomServers;
  await uploadBlob(server, blob, hash, mimeType);

  return {
    sha256: hash,
    mimeType,
    byteSize: blob.length,
    width,
    height,
    encryptionKey: keyHex,
    blurhash,
    server,
  };
}

// A recorded clip, already AAC in MPEG-4, with the recorder's 5-bit waveform packed as Telegram packs it
export async function uploadVoice(
  clip: Blob, durationSeconds: number, packedWaveform: number[],
): Promise<VoiceAttachment> {
  const { blob, hash, keyHex } = await encryptBlob(new Uint8Array(await clip.arrayBuffer()));
  const [server] = getSettings().blossomServers;
  await uploadBlob(server, blob, hash, VOICE_MIME_TYPE);

  return {
    sha256: hash,
    mimeType: VOICE_MIME_TYPE,
    byteSize: blob.length,
    durationSeconds,
    encryptionKey: keyHex,
    waveform: toVoiceBars(Array.from(decodeWaveform(new Uint8Array(packedWaveform)))),
    server,
  };
}

// The loudest sample of each of 40 buckets, scaled so the loudest bar is 255 (the apps normalize the same way)
function toVoiceBars(samples: number[]) {
  const bars = Array.from({ length: VOICE_WAVEFORM_BARS }, (_, i) => {
    const start = Math.floor((i * samples.length) / VOICE_WAVEFORM_BARS);
    const end = Math.max(start + 1, Math.floor(((i + 1) * samples.length) / VOICE_WAVEFORM_BARS));
    return Math.max(0, ...samples.slice(start, end));
  });
  const peak = Math.max(...bars);
  return bars.map((bar) => (peak ? Math.round((bar / peak) * 255) : 0));
}
