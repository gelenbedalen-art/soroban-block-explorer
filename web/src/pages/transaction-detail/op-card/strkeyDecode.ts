/** SEP-23 strkey encoding: version byte + 32-byte payload + CRC16-XModem
 *  (little-endian), base32 without padding. Version bytes are the base32
 *  index of the leading letter shifted left by 3 — G (account) = 6<<3,
 *  C (contract) = 2<<3, L (liquidity pool) = 11<<3, W (muxed contract,
 *  CAP-0084) = 22<<3. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const STRKEY_VERSION = {
  contract: 2 << 3,
  account: 6 << 3,
  pool: 11 << 3,
} as const;

function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function base32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** Encode 32 raw bytes (base64) as a strkey with the given version byte.
 *  Total: ANY 32 bytes yield a checksum-valid strkey — a successful
 *  decode proves nothing by itself, so never decode blindly. */
export function strkeyFromBase64(b64: string, version: number): string | null {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  if (bin.length !== 32) return null;
  const payload = new Uint8Array(35);
  payload[0] = version;
  for (let i = 0; i < 32; i++) payload[i + 1] = bin.charCodeAt(i);
  const crc = crc16xmodem(payload.subarray(0, 33));
  payload[33] = crc & 0xff;
  payload[34] = crc >> 8;
  return base32(payload);
}

/** The `C…` contract a `W…` names: a contract with a sub-account id
 *  (CAP-0084, version byte 22<<3, payload = 32-byte contract id + 8-byte
 *  id). `null` unless the whole key decodes and its checksum holds. */
export function contractOfMuxed(w: string): string | null {
  // 1 version byte + 40 payload bytes + 2 checksum bytes = 43 bytes = 69 chars.
  if (w.length !== 69 || w[0] !== 'W') return null;
  const bytes = new Uint8Array(43);
  let buffer = 0;
  let bits = 0;
  let n = 0;
  for (const ch of w) {
    const v = BASE32_ALPHABET.indexOf(ch);
    if (v < 0) return null;
    buffer = ((buffer << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes[n++] = (buffer >> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  if (bytes[0] !== 22 << 3) return null;
  const crc = crc16xmodem(bytes.subarray(0, 41));
  if (bytes[41] !== (crc & 0xff) || bytes[42] !== crc >> 8) return null;
  const contract = new Uint8Array(35);
  contract[0] = STRKEY_VERSION.contract;
  contract.set(bytes.subarray(1, 33), 1);
  const contractCrc = crc16xmodem(contract.subarray(0, 33));
  contract[33] = contractCrc & 0xff;
  contract[34] = contractCrc >> 8;
  return base32(contract);
}
