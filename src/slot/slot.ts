const POLY = 0x1021

const TABLE = Array.from({ length: 256 }, (_, byte) => {
  let crc = byte << 8
  for (let bit = 0; bit < 8; bit++)
    crc = crc & 0x8000 ? ((crc << 1) ^ POLY) & 0xffff : (crc << 1) & 0xffff
  return crc
})

export function crc16(bytes: Uint8Array): number {
  let crc = 0
  for (const b of bytes) crc = ((crc << 8) & 0xffff) ^ (TABLE[((crc >> 8) ^ b) & 0xff] as number)
  return crc
}

/** The text Redis hashes: the first non-empty `{...}` tag, else the whole key. */
function hashPart(key: string): string {
  const open = key.indexOf('{')
  if (open < 0) return key
  const close = key.indexOf('}', open + 1)
  return close > open + 1 ? key.slice(open + 1, close) : key
}

export function slotOf(key: string): number {
  return crc16(Buffer.from(hashPart(key), 'utf8')) % 16384
}

/** Which of the three primaries owns a slot in the even split `redis-cli --cluster create` makes. */
export function primaryOf(slot: number): 0 | 1 | 2 {
  return slot <= 5460 ? 0 : slot <= 10922 ? 1 : 2
}
