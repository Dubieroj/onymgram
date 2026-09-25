export function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string) {
  if (hex.length % 2 || /[^0-9a-f]/i.test(hex)) throw new Error('Invalid hex');
  return Uint8Array.from(hex.match(/../g) || [], (pair) => parseInt(pair, 16));
}

export function toBase64(bytes: Uint8Array) {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

// Strict standard base64: non-canonical padding or stray characters are refused, not repaired
export function fromBase64(text: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw new Error('Invalid base64');
  }
  const bytes = Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  if (toBase64(bytes) !== text) throw new Error('Non-canonical base64');
  return bytes;
}

export function toBase64Url(bytes: Uint8Array) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

export function concatBytes(...parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  parts.forEach((part) => {
    result.set(part, offset);
    offset += part.length;
  });
  return result;
}

export function utf8(text: string) {
  return new TextEncoder().encode(text);
}

export function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
