import { sha256 } from '@noble/hashes/sha2.js';

import type {
  ApiChat, ApiKeyboardButtons, ApiMessage, ApiPhoto, ApiUser,
} from '../types';
import type { ImageAttachment } from './core/payloads';
import type {
  Group, Message, Notice, Offer,
} from './messenger';
import type { Session } from './session';

import { SERVICE_NOTIFICATIONS_USER_ID } from '../../config';
import { toHex, utf8 } from './core/bytes';
import { toGroupChatId, toUserId } from './ids';

// How the Onym network looks through Telegram's window: a Founder group is a basic group, each member a user keyed
// by their BLS key, and this interface's own notices (invite link, invitations, join status) the service chat
export const SYSTEM_CHAT_ID = SERVICE_NOTIFICATIONS_USER_ID;
export const JOIN_CALLBACK_PREFIX = 'onym:join:';
export const DECLINE_CALLBACK_PREFIX = 'onym:decline:';

const LOCAL_ID_STEP = 1e-6;
const AVATAR_ID_LENGTH = 16;

const groupIdByChatId = new Map<string, string>();
const blsByUserId = new Map<string, string>();
let localIdCounter = 0;

export function getGroupIdByChatId(chatId: string) {
  return groupIdByChatId.get(chatId);
}

export function getChatIdOfGroup(groupId: string) {
  const chatId = toGroupChatId(groupId);
  groupIdByChatId.set(chatId, groupId);
  return chatId;
}

export function getUserIdOfMember(bls: string) {
  const userId = toUserId(bls);
  blsByUserId.set(userId, bls);
  return userId;
}

export function getMemberByUserId(userId: string) {
  return blsByUserId.get(userId);
}

export function buildNextLocalId(lastMessageId = 0) {
  return lastMessageId + (++localIdCounter * LOCAL_ID_STEP);
}

export function buildSelfUser(session: Session): ApiUser {
  return {
    id: getUserIdOfMember(session.identity.blsPublicKey),
    isMin: false,
    isSelf: true,
    type: 'userTypeRegular',
    firstName: session.firstName,
    lastName: session.lastName,
    phoneNumber: '',
  };
}

export function buildSystemUser(): ApiUser {
  return {
    id: SYSTEM_CHAT_ID,
    isMin: false,
    type: 'userTypeRegular',
    firstName: 'Onymgram',
    phoneNumber: '',
  };
}

export function buildSystemChat(): ApiChat {
  return {
    id: SYSTEM_CHAT_ID,
    type: 'chatTypePrivate',
    title: 'Onymgram',
    isListed: true,
  };
}

export function buildGroupChat(group: Group): ApiChat {
  return {
    id: getChatIdOfGroup(group.id),
    type: 'chatTypeBasicGroup',
    title: group.name || 'Onym group',
    // Changes whenever the photo does, so the UI reloads it
    avatarPhotoId: group.avatar ? toHex(sha256(utf8(group.avatar))).slice(0, AVATAR_ID_LENGTH) : undefined,
    membersCount: Object.keys(group.memberProfiles).length,
    creationDate: Math.floor(group.joinedAt / 1000),
    isListed: true,
    isOwner: false,
  };
}

export function buildMemberUsers(group: Group, selfBls: string): ApiUser[] {
  return Object.entries(group.memberProfiles)
    .filter(([bls]) => bls !== selfBls)
    .map(([bls, profile]) => ({
      id: getUserIdOfMember(bls),
      isMin: false,
      type: 'userTypeRegular',
      firstName: profile.alias || 'Member',
      phoneNumber: '',
    }));
}

// One Onym message is one Telegram message, except an album: Telegram shows one message per photo, grouped, with
// the caption on the first
export function buildGroupMessages(message: Message, messages: Message[]): ApiMessage[] {
  const replyToSeq = message.replyTo
    ? messages.find(({ logicalId }) => logicalId === message.replyTo)?.seq
    : undefined;

  const common = {
    chatId: getChatIdOfGroup(message.groupId),
    date: Math.floor(message.sentAtMs / 1000),
    isOutgoing: message.isOutgoing,
    senderId: getUserIdOfMember(message.senderBls),
    sendingState: message.status === 'failed' ? 'messageSendingStateFailed' as const
      : message.status === 'pending' ? 'messageSendingStatePending' as const : undefined,
    replyInfo: replyToSeq ? { type: 'message' as const, replyToMsgId: replyToSeq } : undefined,
    isForwardingAllowed: true,
  };

  if (message.images) {
    const caption = buildCaption(message);
    return message.images.map((image, i) => ({
      ...common,
      id: message.seq + i,
      groupedId: message.logicalId,
      isInAlbum: true,
      content: { photo: buildPhoto(image, message), text: i === 0 ? caption : undefined },
    }));
  }

  return [{ ...common, id: message.seq, content: buildMessageContent(message) }];
}

export function buildNoticeMessage(notice: Notice, offer: Offer | undefined, selfUserId: string): ApiMessage {
  const isOpenOffer = offer?.status === 'pending' && offer.noticeSeq === notice.seq;
  const inlineButtons: ApiKeyboardButtons | undefined = isOpenOffer ? [[
    { text: 'Join', action: { type: 'callback', data: `${JOIN_CALLBACK_PREFIX}${offer.groupId}` } },
    { text: 'Decline', action: { type: 'callback', data: `${DECLINE_CALLBACK_PREFIX}${offer.groupId}` } },
  ]] : undefined;

  return {
    id: notice.seq,
    chatId: SYSTEM_CHAT_ID,
    date: Math.floor(notice.dateMs / 1000),
    isOutgoing: Boolean(notice.isOutgoing),
    senderId: notice.isOutgoing ? selfUserId : SYSTEM_CHAT_ID,
    content: { text: { text: notice.text } },
    inlineButtons,
  };
}

function buildMessageContent(message: Message): ApiMessage['content'] {
  const text = buildCaption(message);
  if (message.image) {
    return { photo: buildPhoto(message.image, message), text };
  }
  if (message.voice) {
    const { sha256: hash, durationSeconds, waveform, byteSize } = message.voice;
    // The waveform is drawn relative to its own peak, so the apps' 0…255 values need no rescaling
    return {
      voice: {
        mediaType: 'voice', id: hash, duration: Math.round(durationSeconds), waveform, size: byteSize,
      },
      text,
    };
  }
  return { text: text || { text: '' } };
}

function buildPhoto(image: ImageAttachment, message: Message): ApiPhoto {
  const { sha256: hash, width, height } = image;
  return {
    mediaType: 'photo',
    id: hash,
    date: Math.floor(message.sentAtMs / 1000),
    sizes: [{ type: 'x', width, height }],
  };
}

// Video is not shown here yet: its place in the message says so
function buildCaption(message: Message) {
  const note = message.hasUnsupportedMedia ? '📎 Video — this interface does not play Onym video yet' : undefined;
  const text = [note, message.text].filter(Boolean).join('\n');
  return text ? { text } : undefined;
}
