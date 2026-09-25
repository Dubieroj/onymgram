import type { ThreadId } from '../../../types';
import type {
  ApiAttachment, ApiChat, ApiGlobalMessageSearchType, ApiMessage, ApiMessageSearchType, ApiOnProgress, ApiPeer,
} from '../../types';
import type { ImageAttachment } from '../core/payloads';
import type { Session } from '../session';

import { sendApiUpdate } from '../../gramjs/updates/apiUpdateEmitter';
import { parseIdentityLink, parseJoinLink } from '../core/links';
import { uploadPhoto } from '../photo';
import { buildMessageForUi, buildNoticeForUi, getSession } from '../session';
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
  wasDrafted?: boolean;
};

const LOCAL_PHOTO_ID = 'temp';
const GIF_MIME_TYPE = 'image/gif';

const HELP_TEXT = [
  'Paste a join link (https://onym.app/join?c=…) to ask to join a group.',
  'Creating groups and inviting people need the group admin to anchor the group on Stellar with a PLONK proof, '
  + 'which this interface cannot do yet: ask a friend with the Onym app to create the group and invite you.',
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
    messages.push(buildMessageForUi(current, last));
    lastMessageByChatId[getChatIdOfGroup(groupId)] = last.seq;
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

// The Onym network carries text and photos: anything else the composer offers is refused before it is shown as sent
export async function sendMessage(params: SendParams, onProgress?: ApiOnProgress): Promise<void> {
  const current = getSession();
  const { chat, text = '', attachment, wasDrafted } = params;
  if (!current || !chat) return;

  const photo = attachment && isSendablePhoto(attachment) && chat.id !== SYSTEM_CHAT_ID ? attachment : undefined;
  const hasUnsupported = Boolean(
    (attachment && !photo) || params.sticker || params.gif || params.poll || params.contact,
  );
  if (hasUnsupported || (!text.trim() && !photo)) {
    sendApiUpdate({
      '@type': 'error',
      error: { message: 'Onym carries text and photos: this interface does not send other media.' },
    });
    return;
  }

  const localMessage: ApiMessage = {
    id: buildNextLocalId(params.lastMessageId),
    chatId: chat.id,
    date: Math.floor(Date.now() / 1000),
    isOutgoing: true,
    senderId: current.selfUserId,
    content: photo ? { photo: buildLocalPhoto(photo), text: text ? { text } : undefined } : { text: { text } },
    sendingState: 'messageSendingStatePending',
    replyInfo: params.replyInfo?.type === 'message' && params.replyInfo.replyToMsgId
      ? { type: 'message', replyToMsgId: params.replyInfo.replyToMsgId }
      : undefined,
  };

  sendApiUpdate({
    '@type': 'newMessage', chatId: chat.id, id: localMessage.id, message: localMessage, wasDrafted,
  });
  onProgress?.(1);

  if (chat.id === SYSTEM_CHAT_ID) {
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

  const replyToSeq = localMessage.replyInfo?.type === 'message' ? localMessage.replyInfo.replyToMsgId : undefined;
  const replyTo = replyToSeq
    ? current.messenger.getMessages(groupId).find(({ seq }) => seq === replyToSeq)?.logicalId
    : undefined;

  let image: ImageAttachment | undefined;
  if (photo) {
    try {
      image = await uploadPhoto(await (await fetch(photo.blobUrl)).blob());
    } catch (err) {
      sendApiUpdate({
        '@type': 'updateMessageSendFailed', chatId: chat.id, localId: localMessage.id, error: String(err),
      });
      return;
    }
  }

  const sent = await current.messenger.sendMessage(groupId, { text, replyTo, image });
  const message = buildMessageForUi(current, sent);
  if (message.content.photo && photo) {
    // Keep showing the local copy instead of fetching back the photo just uploaded
    message.content.photo.blobUrl = photo.blobUrl;
  }
  sendApiUpdate({
    '@type': 'updateMessageSendSucceeded', chatId: chat.id, localId: localMessage.id, message,
  });
}

// Photos go as images; GIFs and anything chosen to go as a file do not
function isSendablePhoto(attachment: ApiAttachment) {
  return attachment.mimeType.startsWith('image/') && attachment.mimeType !== GIF_MIME_TYPE
    && !attachment.shouldSendAsFile && Boolean(attachment.quick);
}

function buildLocalPhoto({ blobUrl, previewBlobUrl, quick }: ApiAttachment) {
  const { width, height } = quick!;
  return {
    mediaType: 'photo' as const,
    id: LOCAL_PHOTO_ID,
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
    current.messenger.addNotice(`That is someone's invite link. ${HELP_TEXT}`);
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
  return current.messenger.getMessages(groupId).map((message) => buildMessageForUi(current, message));
}
