// Stellar StrKey account IDs ("G…"): version byte 6 << 3, the ed25519 public key, CRC16-XModem little-endian,
// all in unpadded RFC 4648 base32
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ACCOUNT_VERSION_BYTE = 6 << 3;

export function encodeStellarAccount(publicKey: Uint8Array) {
  const payload = new Uint8Array([ACCOUNT_VERSION_BYTE, ...publicKey]);
  const checksum = crc16XModem(payload);
  const bytes = [...payload, checksum & 0xff, checksum >> 8];

  let bits = bytes.map((byte) => byte.toString(2).padStart(8, '0')).join('');
  bits += '0'.repeat((5 - (bits.length % 5)) % 5);
  return bits.match(/.{5}/g)!.map((chunk) => BASE32_ALPHABET[parseInt(chunk, 2)]).join('');
}

function crc16XModem(bytes: Uint8Array) {
  let crc = 0;
  bytes.forEach((byte) => {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  });
  return crc;
}
