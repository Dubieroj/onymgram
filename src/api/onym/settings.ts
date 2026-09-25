import { DEFAULT_BLOSSOM_SERVERS } from './core/blossom';
import { readSealed, writeSealed } from './store';

// The user's own choices of carriers and receipts, sealed with the rest of this browser's state. Defaults are Onym's
// reference servers, labelled as defaults and replaceable in place (Interface.md §4.2, §6)
export const DEFAULT_RELAYS = ['wss://nostr.onym.app'];

const SETTINGS_ENTRY = 'settings';

export type OnymSettings = {
  relays: string[];
  blossomServers: string[];
  sendsReadReceipts: boolean;
  // Chat id → unix time its mute ends; muting is this browser's choice alone and nothing about it is sent
  mutedUntilByChatId: Record<string, number>;
};

let settings = buildDefaults();
let markLoaded: () => void;
// A change made before the stored settings are read would otherwise be saved over them
const loaded = new Promise<void>((resolve) => {
  markLoaded = resolve;
});

export async function loadSettings() {
  settings = { ...buildDefaults(), ...await readSealed<Partial<OnymSettings>>(SETTINGS_ENTRY) };
  markLoaded();
  return settings;
}

export function getSettings() {
  return settings;
}

export async function readSettings() {
  await loaded;
  return settings;
}

export async function updateSettings(patch: Partial<OnymSettings>) {
  await loaded;
  settings = { ...settings, ...patch };
  await writeSealed(SETTINGS_ENTRY, settings);
  return settings;
}

// A courier is reached over TLS only (UI-Message-Nostr.md §8); a media server over HTTPS only
export function normalizeServerUrl(text: string, kind: 'relay' | 'blossom') {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== (kind === 'relay' ? 'wss:' : 'https:') || url.username || url.password || url.search) {
    return undefined;
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

function buildDefaults(): OnymSettings {
  return {
    relays: DEFAULT_RELAYS, blossomServers: DEFAULT_BLOSSOM_SERVERS, sendsReadReceipts: true, mutedUntilByChatId: {},
  };
}
