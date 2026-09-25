import type { ApiInitialArgs, ApiUpdateAuthorizationStateType } from '../../types';

import { sendApiUpdate } from '../../gramjs/updates/apiUpdateEmitter';
import { checkPhrase, normalizePhrase } from '../core/bip39';
import { deriveIdentity } from '../core/identity';
import { closeSession, getSession, openSession } from '../session';
import {
  eraseAll, readSealed, removeSealed, writeSealed,
} from '../store';

type StoredIdentity = {
  phrase: string;
  firstName?: string;
  lastName?: string;
};

const IDENTITY_ENTRY = 'identity';
const SESSION_MARKER = 'onym';

let pendingPhrase: string | undefined;

export async function start(initialArgs: ApiInitialArgs) {
  const stored = await readSealed<StoredIdentity>(IDENTITY_ENTRY);
  if (!stored) {
    sendAuthState('authorizationStateWaitPhoneNumber');
    return;
  }

  // The main thread shows the app from its own cache while this runs; relays connect in the background
  void startSession(stored, Boolean(initialArgs.sessionData));
}

export function acceptPhrase(phrase: string) {
  const problem = checkPhrase(phrase);
  if (problem) return { problem };

  pendingPhrase = normalizePhrase(phrase);
  sendAuthState('authorizationStateWaitRegistration');
  return {};
}

export async function acceptRegistration(firstName: string, lastName?: string) {
  if (!pendingPhrase) return;

  const stored: StoredIdentity = { phrase: pendingPhrase, firstName: firstName.trim(), lastName: lastName?.trim() };
  pendingPhrase = undefined;
  await writeSealed(IDENTITY_ENTRY, stored);
  await startSession(stored, false);
}

export async function updateStoredProfile(firstName: string, lastName?: string) {
  const stored = await readSealed<StoredIdentity>(IDENTITY_ENTRY);
  if (!stored) return;
  await writeSealed(IDENTITY_ENTRY, { ...stored, firstName, lastName });
}

export async function readStoredPhrase() {
  return (await readSealed<StoredIdentity>(IDENTITY_ENTRY))?.phrase;
}

// Signing out of an interface deletes its local state and nothing else (Interface.md §10.3)
export async function destroy(noLogOut = false, noClearLocalDb = false) {
  closeSession();
  if (!noLogOut && !noClearLocalDb) {
    await removeSealed(IDENTITY_ENTRY);
    await eraseAll();
  }
}

export function disconnect() {
  getSession()?.pool.disconnectAll();
}

async function startSession(stored: StoredIdentity, wasSignedIn: boolean) {
  await openSession({
    secrets: deriveIdentity(stored.phrase),
    firstName: stored.firstName || '',
    lastName: stored.lastName,
  });

  sendAuthState('authorizationStateReady');
  if (!wasSignedIn) {
    sendApiUpdate({ '@type': 'updateSession', sessionData: { mainDcId: 1, keys: { 1: SESSION_MARKER } } });
  }
  sendApiUpdate({ '@type': 'updateApiReady' });
}

function sendAuthState(authorizationState: ApiUpdateAuthorizationStateType) {
  sendApiUpdate({ '@type': 'updateAuthorizationState', authorizationState });
}
