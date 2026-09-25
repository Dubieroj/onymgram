import { generatePhrase } from '../core/bip39';
import { DEFAULT_BLOSSOM_SERVERS } from '../core/blossom';
import { buildIdentityLink } from '../core/links';
import { getSession } from '../session';
import {
  DEFAULT_RELAYS, normalizeServerUrl, readSettings, updateSettings,
} from '../settings';
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
  });
}

export async function fetchOnymSettings() {
  const { relays, blossomServers, sendsReadReceipts } = await readSettings();
  return {
    relays,
    defaultRelays: DEFAULT_RELAYS,
    blossomServers,
    defaultBlossomServers: DEFAULT_BLOSSOM_SERVERS,
    sendsReadReceipts,
  };
}

// Replaces the whole list; answers the normalized list, or the entry it refused
export async function setOnymServers(kind: 'relay' | 'blossom', entries: string[]) {
  const normalized = entries.map((entry) => normalizeServerUrl(entry, kind));
  const refused = entries.find((_, i) => !normalized[i]);
  if (refused !== undefined) return { refused };

  const list = [...new Set(normalized as string[])];
  if (!list.length) return { refused: '' };

  if (kind === 'relay') {
    await updateSettings({ relays: list });
    getSession()?.pool.setRelays(list);
  } else {
    await updateSettings({ blossomServers: list });
  }
  return { list };
}

export async function setOnymReadReceipts(isEnabled: boolean) {
  await updateSettings({ sendsReadReceipts: isEnabled });
}

export async function clearOnymMessages() {
  await getSession()?.messenger.clearMessages();
  return true;
}

// Shown only on the user's explicit request, never cached in the UI's global state
export function fetchOnymPhrase() {
  return readStoredPhrase();
}
