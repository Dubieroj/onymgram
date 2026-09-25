import type { ApiOnProgress } from '../../types';
import type { Session } from '../session';
import { ApiMediaFormat } from '../../types';

import { decryptBlob, downloadEncryptedBlob, pickServer } from '../core/blossom';
import { fromBase64 } from '../core/bytes';
import { getSession } from '../session';
import { getSettings } from '../settings';
import { getGroupIdByChatId } from '../telegram';

// Serves the UI's media requests from the Onym network: `photo<sha256>` is an encrypted Blossom blob named in a
// message this client holds, `avatar<chatId>` / `profile<chatId>` a group photo carried in the group's state
const MEDIA_URL_RE = /^(photo|avatar|profile)([-\w]+)/;

export async function downloadMedia(
  { url, mediaFormat }: { url: string; mediaFormat: ApiMediaFormat; start?: number; end?: number },
  onProgress?: ApiOnProgress,
) {
  const current = getSession();
  const match = url.match(MEDIA_URL_RE);
  if (!current || !match) return undefined;

  const [, kind, id] = match;
  const bytes = kind === 'photo' ? await loadPhoto(current, id) : loadGroupAvatar(current, id);
  if (!bytes) return undefined;
  onProgress?.(1);

  const mimeType = 'image/jpeg';
  const isBlob = mediaFormat === ApiMediaFormat.BlobUrl;
  return {
    dataBlob: isBlob ? new Blob([bytes.slice().buffer], { type: mimeType }) : '',
    arrayBuffer: isBlob ? undefined : bytes.slice().buffer,
    mimeType,
    fullSize: bytes.length,
  };
}

async function loadPhoto(current: Session, hash: string) {
  const attachment = Object.values(current.messenger.getState().messages)
    .flat()
    .find(({ image }) => image?.sha256 === hash)?.image;
  if (!attachment) return undefined;

  try {
    const blob = await downloadEncryptedBlob(pickServer(attachment.server, getSettings().blossomServers), hash);
    return await decryptBlob(blob, attachment.encryptionKey);
  } catch {
    return undefined;
  }
}

function loadGroupAvatar(current: Session, chatId: string) {
  const groupId = getGroupIdByChatId(chatId);
  const avatar = groupId ? current.messenger.getGroup(groupId)?.avatar : undefined;
  return avatar ? fromBase64(avatar) : undefined;
}
