import type { ApiUser, ApiUserFullInfo } from '../../types';

import { sendApiUpdate } from '../../gramjs/updates/apiUpdateEmitter';
import { buildIdentityLink } from '../core/links';
import { getSession } from '../session';
import {
  buildSelfUser, buildSystemUser, getMemberByUserId, SYSTEM_CHAT_ID,
} from '../telegram';

export function fetchCurrentUser() {
  const current = getSession();
  if (!current) return Promise.resolve(undefined);

  sendApiUpdate({
    '@type': 'updateCurrentUser',
    currentUser: buildSelfUser(current),
    currentUserFullInfo: { bio: buildIdentityLink(current.identity.inboxPublicKey) },
  });
  return Promise.resolve(undefined);
}

// A member's card shows what the network knows: their self-chosen alias and keys, never a verified identity
export function fetchFullUser({ id }: { id: string; accessHash?: string }) {
  const current = getSession();
  if (!current) return Promise.resolve(undefined);

  let user: ApiUser | undefined;
  let fullInfo: ApiUserFullInfo | undefined;
  if (id === current.selfUserId) {
    user = buildSelfUser(current);
    fullInfo = { bio: buildIdentityLink(current.identity.inboxPublicKey) };
  } else if (id === SYSTEM_CHAT_ID) {
    user = buildSystemUser();
    fullInfo = { bio: 'Notices of this interface: your invite link, invitations and join requests. Stays here.' };
  } else {
    const bls = getMemberByUserId(id);
    const group = bls ? Object.values(current.messenger.getState().groups)
      .find(({ memberProfiles }) => memberProfiles[bls]) : undefined;
    const profile = bls && group?.memberProfiles[bls];
    if (!profile) return Promise.resolve(undefined);

    user = {
      id, isMin: false, type: 'userTypeRegular', firstName: profile.alias || 'Member', phoneNumber: '',
    };
    fullInfo = {
      bio: `Self-chosen name, not verified. Inbox key ${profile.inboxPublicKey.slice(0, 16)}…`,
    };
  }

  sendApiUpdate({
    '@type': 'updateUser', id, user, fullInfo,
  });
  return Promise.resolve({
    user, fullInfo, users: [user], chats: [], userStatusesById: {},
  });
}
