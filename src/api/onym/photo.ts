import type { ImageAttachment } from './core/payloads';

import { DEFAULT_BLOSSOM_SERVERS, encryptBlob, uploadBlob } from './core/blossom';
import { encodeBlurhash } from './core/blurhash';

// The composer has already scaled the photo to a JPEG; this measures it, draws its BlurHash from a small sample,
// encrypts it and uploads the ciphertext, returning the descriptor that travels inside the sealed message
const BLURHASH_SAMPLE_SIZE = 32;
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

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
  const server = DEFAULT_BLOSSOM_SERVERS[0];
  await uploadBlob(server, blob, hash, mimeType);

  return {
    sha256: hash,
    mimeType,
    byteSize: bytes.length,
    width,
    height,
    encryptionKey: keyHex,
    blurhash,
    server,
  };
}
