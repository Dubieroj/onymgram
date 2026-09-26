import type { ApiOnProgress } from '../../types';
import type { Session } from '../session';
import { ApiMediaFormat } from '../../types';

import { decryptBlob, downloadEncryptedBlob, pickServer } from '../core/blossom';
import { fromBase64 } from '../core/bytes';
import { getSession } from '../session';
import { getSettings } from '../settings';
import { getGroupIdByChatId } from '../telegram';
import { getSentMedia } from './messages';

// Serves the UI's media requests from the Onym network: `photo<sha256>` (a photo, alone or in an album) and
// `document<sha256>` (a voice clip) are encrypted Blossom blobs named in a message this client holds,
// `avatar<chatId>` / `profile<chatId>` a group photo carried in the group's state
const MEDIA_URL_RE = /^(photo|document|avatar|profile)([-\w]+)/;

type BlobDescriptor = { sha256: string; encryptionKey: string; mimeType: string; server?: string };

export async function downloadMedia(
  { url, mediaFormat }: { url: string; mediaFormat: ApiMediaFormat; start?: number; end?: number },
  onProgress?: ApiOnProgress,
) {
  const current = getSession();
  const match = url.match(MEDIA_URL_RE);
  if (!current || !match) return undefined;

  const [, kind, id] = match;
  const descriptor = kind === 'photo' || kind === 'document' ? findBlob(current, id) : undefined;
  const bytes = descriptor ? await loadBlob(descriptor) : loadGroupAvatar(current, id);
  if (!bytes) return undefined;
  onProgress?.(1);

  const mimeType = descriptor?.mimeType || 'image/jpeg';
  const isBlob = mediaFormat === ApiMediaFormat.BlobUrl;
  return {
    dataBlob: isBlob ? new Blob([bytes.slice().buffer], { type: mimeType }) : '',
    arrayBuffer: isBlob ? undefined : bytes.slice().buffer,
    mimeType,
    fullSize: bytes.length,
  };
}

function findBlob(current: Session, hash: string): BlobDescriptor | undefined {
  for (const message of Object.values(current.messenger.getState().messages).flat()) {
    const found = [message.image, ...(message.images || []), message.voice].find((blob) => blob?.sha256 === hash);
    if (found) return found;
  }
  return undefined;
}

async function loadBlob({ sha256: hash, encryptionKey, server }: BlobDescriptor) {
  const sent = getSentMedia(hash);
  if (sent) return new Uint8Array(await sent.arrayBuffer());

  try {
    const blob = await downloadEncryptedBlob(pickServer(server, getSettings().blossomServers), hash);
    return await decryptBlob(blob, encryptionKey);
  } catch {
    return undefined;
  }
}

function loadGroupAvatar(current: Session, chatId: string) {
  const groupId = getGroupIdByChatId(chatId);
  const avatar = groupId ? current.messenger.getGroup(groupId)?.avatar : undefined;
  return avatar ? fromBase64(avatar) : undefined;
}
