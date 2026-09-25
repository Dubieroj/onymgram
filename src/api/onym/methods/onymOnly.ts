import { generatePhrase } from '../core/bip39';
import { buildIdentityLink } from '../core/links';
import { DEFAULT_RELAYS, getSession } from '../session';
import { acceptPhrase, readStoredPhrase } from './client';

// Methods with no Telegram counterpart; `Methods` includes them so the main thread calls them through `callApi`

export function generateOnymPhrase() {
  return Promise.resolve(generatePhrase());
}

export function provideOnymPhrase(phrase: string) {
  return Promise.resolve(acceptPhrase(phrase));
}

export function fetchOnymIdentity() {
  const current = getSession();
  if (!current) return Promise.resolve(undefined);
  return Promise.resolve({
    inviteLink: buildIdentityLink(current.identity.inboxPublicKey),
    inboxKey: current.identity.inboxPublicKey,
    stellarAccount: current.identity.stellarAccount,
    blsPublicKey: current.identity.blsPublicKey,
    relays: current.pool.getRelayUrls(),
    defaultRelays: DEFAULT_RELAYS,
  });
}

// Shown only on the user's explicit request, never cached in the UI's global state
export function fetchOnymPhrase() {
  return readStoredPhrase();
}
