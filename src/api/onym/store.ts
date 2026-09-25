import {
  clear, createStore, del, get, set,
} from 'idb-keyval';

// Local state is encrypted at rest (Interface.md §8): every value is sealed with AES-256-GCM under a key that is
// generated in this browser, stored non-extractable, and never leaves it
const DB_NAME = 'onym';
const STORE_NAME = 'sealed';
const KEY_ENTRY = 'key';
const IV_BYTES = 12;

const store = createStore(DB_NAME, STORE_NAME);
let keyPromise: Promise<CryptoKey> | undefined;

export async function readSealed<T>(name: string): Promise<T | undefined> {
  const sealed = await get<{ iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer }>(`v:${name}`, store);
  if (!sealed) return undefined;

  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, await getKey(), sealed.data);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

export async function writeSealed(name: string, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, await getKey(), new TextEncoder().encode(JSON.stringify(value)),
  );
  await set(`v:${name}`, { iv, data }, store);
}

export function removeSealed(name: string) {
  return del(`v:${name}`, store);
}

export async function eraseAll() {
  keyPromise = undefined;
  await clear(store);
}

function getKey() {
  keyPromise ??= (async () => {
    const existing = await get<CryptoKey>(KEY_ENTRY, store);
    if (existing) return existing;

    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await set(KEY_ENTRY, key, store);
    return key;
  })();
  return keyPromise;
}
