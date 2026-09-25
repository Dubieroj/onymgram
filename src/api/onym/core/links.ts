import {
  fromBase64, fromBase64Url, fromHex, toBase64Url, toHex,
} from './bytes';

// Links the Onym apps exchange (onym-ios `IntroCapability`, `SettingsQRCode`; onym-android `IdentityInviteUrl`,
// `InviteKeyCanonicalizer`)
const IDENTITY_LINK_BASE = 'https://onym.app/i?k=';
const JOIN_LINK_HOSTS = new Set(['onym.app', 'www.onym.app']);

export type JoinCapability = {
  introPublicKey: string;
  groupId: string;
  groupName?: string;
  rules?: string;
};

// Someone who has this link can invite the holder of the inbox key to a group
export function buildIdentityLink(inboxPublicKey: string) {
  return `${IDENTITY_LINK_BASE}${toBase64Url(fromHex(inboxPublicKey))}`;
}

// Accepts `https://onym.app/i?k=<base64url>`, the legacy `?payload=<hex>`, and a bare 64-character hex key
export function parseIdentityLink(text: string): string | undefined {
  const trimmed = text.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();

  const url = parseUrl(trimmed);
  if (!url || !JOIN_LINK_HOSTS.has(url.hostname)) return undefined;

  const key = url.searchParams.get('k');
  if (key) {
    try {
      const bytes = fromBase64Url(key);
      return bytes.length === 32 ? toHex(bytes) : undefined;
    } catch {
      return undefined;
    }
  }

  const payload = url.searchParams.get('payload');
  return payload && /^[0-9a-f]{64}$/i.test(payload) ? payload.toLowerCase() : undefined;
}

// `https://onym.app/join?c=` or `onym://join?c=`, where `c` is unpadded base64url of JSON with padded base64 fields
export function parseJoinLink(text: string): JoinCapability | undefined {
  const url = parseUrl(text.trim());
  if (!url) return undefined;

  const isAppLink = url.protocol === 'https:' && JOIN_LINK_HOSTS.has(url.hostname) && url.pathname === '/join';
  const isCustomScheme = url.protocol === 'onym:' && (url.hostname === 'join' || url.pathname === '//join');
  const capability = url.searchParams.get('c');
  if ((!isAppLink && !isCustomScheme) || !capability) return undefined;

  try {
    const json = JSON.parse(new TextDecoder().decode(fromBase64Url(capability)));
    const introPublicKey = fromBase64(json.intro_pub);
    const groupId = fromBase64(json.group_id);
    if (introPublicKey.length !== 32 || groupId.length !== 32) return undefined;
    return {
      introPublicKey: toHex(introPublicKey),
      groupId: toHex(groupId),
      groupName: typeof json.group_name === 'string' ? json.group_name : undefined,
      rules: typeof json.rules === 'string' ? json.rules : undefined,
    };
  } catch {
    return undefined;
  }
}

function parseUrl(text: string) {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}
