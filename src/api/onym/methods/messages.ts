import type { ThreadId } from '../../../types';
import type {
  ApiAttachment, ApiChat, ApiGlobalMessageSearchType, ApiMessage, ApiMessageSearchType, ApiOnProgress, ApiPeer,
  ApiVoice,
} from '../../types';
import type { ImageAttachment } from '../core/payloads';
import type { Message, OutgoingContent } from '../messenger';
import type { Session } from '../session';

import { decodeWaveform } from '../../../util/waveform';
import { sendApiUpdate } from '../../gramjs/updates/apiUpdateEmitter';
import { parseIdentityLink, parseJoinLink } from '../core/links';
import { getMessageSpan } from '../messenger';
import { uploadPhoto, uploadVoice } from '../photo';
import { buildMessagesForUi, buildNoticeForUi, getSession } from '../session';
import {
  buildNextLocalId, getChatIdOfGroup, getGroupIdByChatId, SYSTEM_CHAT_ID,
} from '../telegram';

type SendParams = {
  chat?: ApiChat;
  text?: string;
  lastMessageId?: number;
  replyInfo?: { type: string; replyToMsgId?: number };
  attachment?: ApiAttachment;
  sticker?: unknown;
  gif?: unknown;
  poll?: unknown;
  contact?: unknown;
  groupedId?: string;
  wasDrafted?: boolean;
};

// The photos of an album arrive as one call each with the same `groupedId`, all before the first upload is done
// (the UI does not wait between them), and leave as one Onym message, as GramJS gathers them into one request
type PendingAlbum = {
  count: number;
  settled: number;
  text: string;
  replyTo?: string;
  localIds: number[];
  blobUrls: string[];
  images: (ImageAttachment | undefined)[];
};

const LOCAL_MEDIA_ID = 'temp';
const GIF_MIME_TYPE = 'image/gif';
const VOICE_MIME_TYPE = 'audio/mp4';

const pendingAlbums = new Map<string, PendingAlbum>();

const HELP_TEXT = [
  'This chat only understands join links.',
  'To get into a group, paste its join link here (https://onym.app/join?c=…), or give your inbox key to someone '
  + 'with the Onym app so they can invite you. Your key and its QR code are under My Profile.',
  'Groups are created in the Onym app: this interface cannot create them yet.',
].join('\n\n');

export function buildLastMessages(current: Session) {
  const messages: ApiMessage[] = [];
  const lastMessageByChatId: Record<string, number> = {};

  const { notices, groups } = current.messenger.getState();
  const lastNotice = notices[notices.length - 1];
  if (lastNotice) {
    messages.push(buildNoticeForUi(current, lastNotice));
    lastMessageByChatId[SYSTEM_CHAT_ID] = lastNotice.seq;
  }

  Object.keys(groups).forEach((groupId) => {
    const list = current.messenger.getMessages(groupId);
    const last = list[list.length - 1];
    if (!last) return;
    messages.push(...buildMessagesForUi(current, last));
    lastMessageByChatId[getChatIdOfGroup(groupId)] = last.seq + getMessageSpan(last) - 1;
  });

  return { messages, lastMessageByChatId };
}

// Telegram's history paging: newest first, starting below `offsetId`, shifted by `addOffset` (negative reaches newer)
export function fetchMessages({
  chat, offsetId, addOffset = 0, limit,
}: {
  chat: ApiChat; threadId?: ThreadId; offsetId?: number; addOffset?: number; limit: number;
}) {
  const current = getSession();
  if (!current) return Promise.resolve(undefined);

  const all = listChatMessages(current, chat.id).sort((a, b) => b.id - a.id);
  const firstBelow = offsetId ? all.findIndex(({ id }) => id < offsetId) : 0;
  const start = Math.max(0, (firstBelow === -1 ? all.length : firstBelow) + addOffset);
  const messages = all.slice(start, start + limit);

  return Promise.resolve({
    messages, users: [], chats: [], count: all.length, topics: [],
  });
}

export function fetchMessage({ chat, messageId }: { chat: ApiChat; messageId: number }) {
  const current = getSession();
  const message = current ? listChatMessages(current, chat.id).find(({ id }) => id === messageId) : undefined;
  return Promise.resolve(message ? { message } : undefined);
}

export function fetchMessagesById({ chat, messageIds }: { chat: ApiChat; messageIds: number[] }) {
  const current = getSession();
  if (!current) return Promise.resolve(undefined);
  const ids = new Set(messageIds);
  return Promise.resolve(listChatMessages(current, chat.id).filter(({ id }) => ids.has(id)));
}

// The Onym network carries text, photos, albums of photos and voice clips: anything else the composer offers is
// refused before it is shown as sent
export async function sendMessage(params: SendParams, onProgress?: ApiOnProgress): Promise<void> {
  const current = getSession();
  const {
    chat, text = '', attachment, groupedId, wasDrafted,
  } = params;
  if (!current || !chat) return;

  const isServiceChat = chat.id === SYSTEM_CHAT_ID;
  const photo = attachment && !isServiceChat && isSendablePhoto(attachment) ? attachment : undefined;
  const voice = attachment && !isServiceChat && isSendableVoice(attachment) ? attachment : undefined;
  const hasUnsupported = Boolean(
    (attachment && !photo && !voice) || params.sticker || params.gif || params.poll || params.contact,
  );
  if (hasUnsupported || (!text.trim() && !photo && !voice)) {
    sendApiUpdate({
      '@type': 'error',
      error: { message: 'Onym carries text, photos and voice messages: this interface does not send other media.' },
    });
    return;
  }

  const album = photo && groupedId ? joinAlbum(groupedId) : undefined;
  const localMessage: ApiMessage = {
    id: buildNextLocalId(params.lastMessageId),
    chatId: chat.id,
    date: Math.floor(Date.now() / 1000),
    isOutgoing: true,
    senderId: current.selfUserId,
    content: photo ? { photo: buildLocalPhoto(photo), text: text ? { text } : undefined }
      : voice ? { voice: buildLocalVoice(voice) } : { text: { text } },
    sendingState: 'messageSendingStatePending',
    replyInfo: params.replyInfo?.type === 'message' && params.replyInfo.replyToMsgId
      ? { type: 'message', replyToMsgId: params.replyInfo.replyToMsgId }
      : undefined,
    ...(album && { groupedId, isInAlbum: true }),
  };

  sendApiUpdate({
    '@type': 'newMessage', chatId: chat.id, id: localMessage.id, message: localMessage, wasDrafted,
  });
  onProgress?.(1);

  if (isServiceChat) {
    const notice = current.messenger.addOutgoingNotice(text);
    sendApiUpdate({
      '@type': 'updateMessageSendSucceeded',
      chatId: chat.id,
      localId: localMessage.id,
      message: buildNoticeForUi(current, notice),
    });
    handleSystemCommand(current, text);
    return;
  }

  const groupId = getGroupIdByChatId(chat.id);
  if (!groupId) return;

  const replyToId = localMessage.replyInfo?.type === 'message' ? localMessage.replyInfo.replyToMsgId : undefined;
  const replyTo = replyToId ? findMessageById(current, groupId, replyToId)?.logicalId : undefined;

  if (album) {
    const index = album.count - 1;
    album.localIds[index] = localMessage.id;
    album.blobUrls[index] = photo!.blobUrl;
    if (text) album.text = text;
    if (replyTo) album.replyTo = replyTo;
    album.images[index] = await uploadPhoto(await readBlob(photo!.blobUrl)).catch(() => undefined);
    if (++album.settled === album.count) {
      pendingAlbums.delete(groupedId!);
      await sendAlbum(current, chat.id, groupId, album);
    }
    return;
  }

  let content: OutgoingContent;
  try {
    content = {
      text,
      replyTo,
      image: photo && await uploadPhoto(await readBlob(photo.blobUrl)),
      voice: voice && await uploadVoice(await readBlob(voice.blobUrl), voice.voice!.duration, voice.voice!.waveform),
    };
  } catch (err) {
    sendApiUpdate({
      '@type': 'updateMessageSendFailed', chatId: chat.id, localId: localMessage.id, error: String(err),
    });
    return;
  }

  const sent = await current.messenger.sendMessage(groupId, content);
  const [message] = buildMessagesForUi(current, sent);
  if (message.content.photo && photo) {
    // Keep showing the local copy instead of fetching back the photo just uploaded
    message.content.photo.blobUrl = photo.blobUrl;
  }
  if (voice && content.voice) rememberSentMedia(content.voice.sha256, await readBlob(voice.blobUrl));
  sendApiUpdate({
    '@type': 'updateMessageSendSucceeded', chatId: chat.id, localId: localMessage.id, message,
  });
}

function joinAlbum(groupedId: string) {
  const album = pendingAlbums.get(groupedId) || {
    count: 0, settled: 0, text: '', localIds: [], blobUrls: [], images: [],
  };
  album.count++;
  pendingAlbums.set(groupedId, album);
  return album;
}

// An album goes whole or not at all: a photo that failed to upload fails the others with it
async function sendAlbum(current: Session, chatId: string, groupId: string, album: PendingAlbum) {
  const images = album.images.filter((image): image is ImageAttachment => Boolean(image));
  if (images.length !== album.count) {
    album.localIds.forEach((localId) => sendApiUpdate({
      '@type': 'updateMessageSendFailed', chatId, localId, error: 'A photo of the album did not upload',
    }));
    return;
  }

  const sent = await current.messenger.sendMessage(groupId, { text: album.text, replyTo: album.replyTo, images });
  buildMessagesForUi(current, sent).forEach((message, i) => {
    if (message.content.photo) message.content.photo.blobUrl = album.blobUrls[i];
    sendApiUpdate({
      '@type': 'updateMessageSendSucceeded', chatId, localId: album.localIds[i], message,
    });
  });
}

function findMessageById(current: Session, groupId: string, id: number): Message | undefined {
  return current.messenger.getMessages(groupId).find((message) => (
    id >= message.seq && id < message.seq + getMessageSpan(message)
  ));
}

async function readBlob(blobUrl: string) {
  return (await fetch(blobUrl)).blob();
}

// A clip this client just sent plays from memory instead of being fetched back from Blossom
const sentMedia = new Map<string, Blob>();
const SENT_MEDIA_LIMIT = 20;

function rememberSentMedia(hash: string, blob: Blob) {
  sentMedia.set(hash, blob);
  if (sentMedia.size > SENT_MEDIA_LIMIT) sentMedia.delete(sentMedia.keys().next().value!);
}

export function getSentMedia(hash: string) {
  return sentMedia.get(hash);
}

// Photos go as images; GIFs and anything chosen to go as a file do not
function isSendablePhoto(attachment: ApiAttachment) {
  return attachment.mimeType.startsWith('image/') && attachment.mimeType !== GIF_MIME_TYPE
    && !attachment.shouldSendAsFile && Boolean(attachment.quick);
}

// A voice clip recorded as the apps record one; the recorder here writes AAC in MPEG-4 for the Onym network
function isSendableVoice(attachment: ApiAttachment) {
  return Boolean(attachment.voice) && attachment.mimeType === VOICE_MIME_TYPE;
}

function buildLocalVoice({ voice, size }: ApiAttachment): ApiVoice {
  return {
    mediaType: 'voice',
    id: LOCAL_MEDIA_ID,
    duration: voice!.duration,
    waveform: Array.from(decodeWaveform(new Uint8Array(voice!.waveform))),
    size,
  };
}

function buildLocalPhoto({ blobUrl, previewBlobUrl, quick }: ApiAttachment) {
  const { width, height } = quick!;
  return {
    mediaType: 'photo' as const,
    id: LOCAL_MEDIA_ID,
    sizes: [],
    thumbnail: { width, height, dataUri: previewBlobUrl || blobUrl },
    blobUrl,
    date: Math.floor(Date.now() / 1000),
  };
}

// Shared media and in-chat search run over the messages this interface holds: photos for the media tab, text for a
// query; the other Telegram media kinds never occur on the Onym network
export function searchMessagesInChat({
  peer, type, query, offsetId, limit, fromPeer,
}: {
  peer: ApiPeer; type?: ApiMessageSearchType | ApiGlobalMessageSearchType; query?: string; offsetId?: number;
  limit: number; fromPeer?: ApiPeer;
}) {
  const current = getSession();
  if (!current) return Promise.resolve(undefined);

  const needle = query?.trim().toLowerCase();
  const matches = listChatMessages(current, peer.id)
    .filter(({ content }) => (type === 'media' ? Boolean(content.photo) : !type || type === 'text'))
    .filter(({ content }) => !needle || Boolean(content.text?.text.toLowerCase().includes(needle)))
    .filter(({ senderId }) => !fromPeer || senderId === fromPeer.id)
    .sort((a, b) => b.id - a.id);
  const page = matches.filter(({ id }) => !offsetId || id < offsetId).slice(0, limit);

  return Promise.resolve({
    userStatusesById: {},
    messages: page,
    topics: [],
    totalCount: matches.length,
    nextOffsetId: page.length === limit ? page[page.length - 1].id : undefined,
  });
}

// The calendar's jump: the first message sent on or after the chosen moment
export function findFirstMessageIdAfterDate({ chat, timestamp }: { chat: ApiChat; timestamp: number }) {
  const current = getSession();
  if (!current) return Promise.resolve(undefined);

  return Promise.resolve(listChatMessages(current, chat.id).find(({ date }) => date >= timestamp)?.id);
}

export function markMessageListRead({ chat, maxId = 0 }: { chat: ApiChat; threadId: ThreadId; maxId?: number }) {
  const current = getSession();
  if (!current) return Promise.resolve(undefined);

  if (chat.id === SYSTEM_CHAT_ID) {
    current.messenger.markNoticesRead(maxId);
  } else {
    const groupId = getGroupIdByChatId(chat.id);
    if (groupId) void current.messenger.markRead(groupId, maxId);
  }
  return Promise.resolve(undefined);
}

function handleSystemCommand(current: Session, text: string) {
  const joinLink = text.split(/\s+/).map(parseJoinLink).find(Boolean);
  if (joinLink) {
    current.messenger.addOfferFromLink(joinLink);
    return;
  }

  if (text.split(/\s+/).some((word) => parseIdentityLink(word))) {
    current.messenger.addNotice(`That link is someone's inbox key: it lets them be invited, not you.\n\n${HELP_TEXT}`);
    return;
  }

  current.messenger.addNotice(HELP_TEXT);
}

function listChatMessages(current: Session, chatId: string): ApiMessage[] {
  if (chatId === SYSTEM_CHAT_ID) {
    return current.messenger.getState().notices.map((notice) => buildNoticeForUi(current, notice));
  }

  const groupId = getGroupIdByChatId(chatId);
  if (!groupId) return [];
  return current.messenger.getMessages(groupId).flatMap((message) => buildMessagesForUi(current, message));
}
