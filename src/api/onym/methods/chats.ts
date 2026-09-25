import type {
  ApiChat, ApiChatMember, ApiMessage, ApiThreadInfo, ApiUser,
} from '../../types';
import type { Session } from '../session';
import { MAIN_THREAD_ID } from '../../types';

import { buildReadState, getSession } from '../session';
import {
  buildGroupChat, buildMemberUsers, buildSelfUser, buildSystemChat, buildSystemUser, getGroupIdByChatId,
  getUserIdOfMember, SYSTEM_CHAT_ID,
} from '../telegram';
import { buildLastMessages } from './messages';

// The whole chat list is local, so one call returns it complete
export function fetchChats({ archived }: { limit: number; archived?: boolean }) {
  const current = getSession();
  if (!current) return Promise.resolve(undefined);

  const groups = archived ? [] : Object.values(current.messenger.getState().groups);
  const chats: ApiChat[] = archived ? [] : [buildSystemChat(), ...groups.map(buildGroupChat)];
  const users: ApiUser[] = [
    buildSelfUser(current),
    buildSystemUser(),
    ...groups.flatMap((group) => buildMemberUsers(group, current.identity.blsPublicKey)),
  ];
  const { messages, lastMessageByChatId } = archived
    ? { messages: [] as ApiMessage[], lastMessageByChatId: {} }
    : buildLastMessages(current);

  return Promise.resolve({
    chatIds: chats.map(({ id }) => id),
    chats,
    users,
    userStatusesById: {},
    draftsById: {},
    threadReadStatesById: buildReadStates(current),
    // The UI keeps a chat's message list only once its main thread is known
    threadInfos: chats.map((chat): ApiThreadInfo => ({
      isCommentsInfo: false, chatId: chat.id, threadId: MAIN_THREAD_ID, lastMessageId: lastMessageByChatId[chat.id],
    })),
    orderedPinnedIds: undefined,
    totalChatCount: chats.length,
    messages,
    notifyExceptionById: {},
    lastMessageByChatId,
    isFullyLoaded: true as const,
  });
}

export function fetchFullChat(chat: ApiChat) {
  const current = getSession();
  const groupId = getGroupIdByChatId(chat.id);
  const group = groupId ? current?.messenger.getGroup(groupId) : undefined;
  if (!current || !group) return Promise.resolve(undefined);

  const adminBls = Object.entries(group.memberProfiles)
    .find(([, profile]) => profile.sendingPublicKey === group.adminSendingKey)?.[0];
  const members: ApiChatMember[] = Object.keys(group.memberProfiles).map((bls) => ({
    userId: getUserIdOfMember(bls),
    isOwner: bls === adminBls ? true : undefined,
  }));

  const about = [
    group.invitationMessage,
    `Onym Founder group · ${members.length} members`,
    group.isCommitmentConsistent
      ? 'Roster matches its commitment; the on-chain anchor is not checked by this interface.'
      : 'The on-chain anchor is not checked by this interface.',
  ].filter(Boolean).join('\n\n');

  return Promise.resolve({
    fullInfo: {
      about,
      members,
      adminMembersById: Object.fromEntries(members.filter(({ isOwner }) => isOwner).map((m) => [m.userId, m])),
      canViewMembers: true,
      isPreHistoryHidden: true,
    },
    chats: [],
    userStatusesById: {},
    membersCount: members.length,
  });
}

export function fetchChat({ type, user }: { type: 'user' | 'self' | 'support'; user?: ApiUser }) {
  const current = getSession();
  if (!current) return Promise.resolve(undefined);
  if (type === 'self' || user?.id === current.selfUserId) return Promise.resolve(undefined);
  if (user?.id === SYSTEM_CHAT_ID) return Promise.resolve({ chatId: SYSTEM_CHAT_ID });
  return Promise.resolve(undefined);
}

function buildReadStates(current: Session) {
  const { groups, lastReadNoticeSeq = 0, notices } = current.messenger.getState();
  const states: Record<string, ReturnType<typeof buildReadState>> = {
    [SYSTEM_CHAT_ID]: {
      unreadCount: notices.filter(({ seq, isOutgoing }) => !isOutgoing && seq > lastReadNoticeSeq).length,
      lastReadInboxMessageId: lastReadNoticeSeq,
      lastReadOutboxMessageId: notices[notices.length - 1]?.seq || 0,
    },
  };
  Object.values(groups).forEach((group) => {
    states[buildGroupChat(group).id] = buildReadState(group, current.messenger.getMessages(group.id));
  });
  return states;
}
