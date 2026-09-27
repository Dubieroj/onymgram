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

// Whatever a message claims: a blob URL of a type a member chose, such as text/html or SVG, would open as a page of
// this origin. Browsers find a photo's real image format themselves
const VOICE_MIME_TYPE = 'audio/mp4';
const PHOTO_MIME_TYPE = 'image/jpeg';

export async function downloadMedia(
  { url, mediaFormat }: { url: string; mediaFormat: ApiMediaFormat; start?: number; end?: number },
  onProgress?: ApiOnProgress,
) {
  const current = getSession();
  const match = url.match(MEDIA_URL_RE);
  if (!current || !match) return undefined;

  const [, kind, id] = match;
  const bytes = kind === 'avatar' || kind === 'profile'
    ? loadGroupAvatar(current, id)
    : await loadBlob(findBlobs(current, id));
  if (!bytes) return undefined;
  onProgress?.(1);

  const mimeType = kind === 'document' ? VOICE_MIME_TYPE : PHOTO_MIME_TYPE;
  const isBlob = mediaFormat === ApiMediaFormat.BlobUrl;
  return {
    dataBlob: isBlob ? new Blob([bytes.slice().buffer], { type: mimeType }) : '',
    arrayBuffer: isBlob ? undefined : bytes.slice().buffer,
    mimeType,
    fullSize: bytes.length,
  };
}

function findBlobs(current: Session, hash: string) {
  return Object.values(current.messenger.getState().messages).flat()
    .flatMap((message) => [message.image, ...(message.images || []), message.voice])
    .filter((blob): blob is NonNullable<typeof blob> => blob?.sha256 === hash);
}

async function loadBlob(descriptors: BlobDescriptor[]) {
  if (!descriptors.length) return undefined;
  const sent = getSentMedia(descriptors[0].sha256);
  if (sent) return new Uint8Array(await sent.arrayBuffer());

  // A member of another group may name the same hash with a wrong key or server: the first copy that opens wins
  for (const { sha256: hash, encryptionKey, server } of descriptors) {
    try {
      const blob = await downloadEncryptedBlob(pickServer(server, getSettings().blossomServers), hash);
      return await decryptBlob(blob, encryptionKey);
    } catch {
      // The next copy
    }
  }
  return undefined;
}

function loadGroupAvatar(current: Session, chatId: string) {
  const groupId = getGroupIdByChatId(chatId);
  const avatar = groupId ? current.messenger.getGroup(groupId)?.avatar : undefined;
  return avatar ? fromBase64(avatar) : undefined;
}
