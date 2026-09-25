import type { ApiMessage } from '../types';
import type { IdentityPublic, IdentitySecrets } from './core/identity';
import type {
  Group, Message, Notice, Offer,
} from './messenger';
import { MAIN_THREAD_ID } from '../types';

import { sendApiUpdate } from '../gramjs/updates/apiUpdateEmitter';
import { getIdentityPublic } from './core/identity';
import { RelayPool } from './core/relayPool';
import { Messenger } from './messenger';
import { getSettings, loadSettings } from './settings';
import {
  buildGroupChat, buildGroupMessage, buildMemberUsers, buildNoticeMessage, buildSelfUser, getChatIdOfGroup,
  getUserIdOfMember, SYSTEM_CHAT_ID,
} from './telegram';

export type Session = {
  secrets: IdentitySecrets;
  identity: IdentityPublic;
  firstName: string;
  lastName?: string;
  pool: RelayPool;
  messenger: Messenger;
  selfUserId: string;
};

let session: Session | undefined;

export function getSession() {
  return session;
}

export async function openSession({ secrets, firstName, lastName }: {
  secrets: IdentitySecrets;
  firstName: string;
  lastName?: string;
}) {
  closeSession();

  const identity = getIdentityPublic(secrets);
  const selfUserId = getUserIdOfMember(identity.blsPublicKey);
  const pool = new RelayPool((connected) => {
    sendApiUpdate({
      '@type': 'updateConnectionState',
      connectionState: connected ? 'connectionStateReady' : 'connectionStateConnecting',
    });
  });

  const current: Session = {
    secrets, identity, firstName, lastName, pool, selfUserId, messenger: undefined!,
  };
  const displayName = () => [current.firstName, current.lastName].filter(Boolean).join(' ') || 'Onym user';
  const sendsReadReceipts = () => getSettings().sendsReadReceipts;
  current.messenger = new Messenger(secrets, identity, displayName, sendsReadReceipts, pool, {
    onGroup: (group, isNew) => emitGroup(current, group, isNew),
    onMessage: (message, isNew) => emitMessage(current, message, isNew),
    onMessagesCleared: (groupId, seqs) => emitMessagesCleared(current, groupId, seqs),
    onNotice: (notice, isNew) => emitNotice(current, notice, isNew),
    onOffer: (offer) => emitOffer(current, offer),
  });
  await loadSettings();
  session = current;

  await current.messenger.load();
  Object.values(current.messenger.getState().groups).forEach((group) => {
    getChatIdOfGroup(group.id);
    Object.keys(group.memberProfiles).forEach(getUserIdOfMember);
  });
  pool.setRelays(getSettings().relays);
  pool.connectAll();
  current.messenger.start();

  sendApiUpdate({ '@type': 'updateCurrentUser', currentUser: buildSelfUser(current), currentUserFullInfo: {} });
  return current;
}

export function closeSession() {
  if (!session) return;
  void session.messenger.flush();
  session.pool.disconnectAll();
  Object.values(session.secrets).forEach((secret) => secret.fill(0));
  session = undefined;
}

export function buildMessageForUi(current: Session, message: Message): ApiMessage {
  return buildGroupMessage(message, current.messenger.getMessages(message.groupId));
}

export function buildNoticeForUi(current: Session, notice: Notice): ApiMessage {
  const offer = notice.offerGroupId ? current.messenger.getState().offers[notice.offerGroupId] : undefined;
  return buildNoticeMessage(notice, offer, current.selfUserId);
}

export function buildReadState(group: Group, messages: Message[]) {
  return {
    unreadCount: messages.filter(({ isOutgoing, seq }) => !isOutgoing && seq > group.lastReadInboxSeq).length,
    lastReadInboxMessageId: group.lastReadInboxSeq,
    lastReadOutboxMessageId: group.lastReadOutboxSeq,
  };
}

function emitGroup(current: Session, group: Group, isNew: boolean) {
  if (session !== current) return;
  buildMemberUsers(group, current.identity.blsPublicKey).forEach((user) => {
    sendApiUpdate({ '@type': 'updateUser', id: user.id, user });
  });
  if (isNew) {
    sendApiUpdate({
      '@type': 'updateThreadInfo',
      threadInfo: { isCommentsInfo: false, chatId: getChatIdOfGroup(group.id), threadId: MAIN_THREAD_ID },
    });
  }
  const readState = buildReadState(group, current.messenger.getMessages(group.id));
  sendApiUpdate({
    '@type': 'updateChat',
    id: getChatIdOfGroup(group.id),
    chat: buildGroupChat(group),
    readState,
    noTopChatsRequest: !isNew,
  });
  // `updateChat` leaves the thread's read state alone, so the ticks of messages others have read change only here
  sendApiUpdate({
    '@type': 'updateThreadReadState', chatId: getChatIdOfGroup(group.id), threadId: MAIN_THREAD_ID, readState,
  });
}

function emitMessage(current: Session, message: Message, isNew: boolean) {
  if (session !== current) return;
  // Outgoing messages reach the UI through `sendMessage`, which owns their local id
  if (isNew && message.isOutgoing) return;

  const apiMessage = buildMessageForUi(current, message);
  if (isNew) {
    sendApiUpdate({
      '@type': 'newMessage', chatId: apiMessage.chatId, id: apiMessage.id, message: apiMessage,
    });
  } else {
    sendApiUpdate({
      '@type': 'updateMessage', chatId: apiMessage.chatId, id: apiMessage.id, message: apiMessage, isFull: true,
    });
  }
}

function emitMessagesCleared(current: Session, groupId: string, seqs: number[]) {
  if (session !== current) return;
  const chatId = getChatIdOfGroup(groupId);
  sendApiUpdate({ '@type': 'deleteMessages', ids: seqs, chatId });
  const group = current.messenger.getGroup(groupId);
  if (group) emitGroup(current, group, false);
}

function emitNotice(current: Session, notice: Notice, isNew: boolean) {
  if (session !== current || notice.isOutgoing) return;
  const apiMessage = buildNoticeForUi(current, notice);
  sendApiUpdate(isNew
    ? { '@type': 'newMessage', chatId: SYSTEM_CHAT_ID, id: notice.seq, message: apiMessage }
    : {
      '@type': 'updateMessage', chatId: SYSTEM_CHAT_ID, id: notice.seq, message: apiMessage, isFull: true,
    });
}

// An answered invitation loses its Join/Decline buttons
function emitOffer(current: Session, offer: Offer) {
  if (session !== current || !offer.noticeSeq) return;
  const notice = current.messenger.getState().notices.find(({ seq }) => seq === offer.noticeSeq);
  if (notice) emitNotice(current, notice, false);
}
