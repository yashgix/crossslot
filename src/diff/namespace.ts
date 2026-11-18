import { randomBytes } from 'node:crypto'
import { crc16 } from '../slot/slot.js'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const SEARCHED = 3

const crcOf = (s: string) => crc16(Buffer.from(s))

function* suffixes(length: number): Generator<string> {
  if (length === 0) return void (yield '')
  for (const c of ALPHABET) for (const rest of suffixes(length - 1)) yield c + rest
}

/**
 * A random id of the same length as `base` with the same CRC16. Redis folds the id into every
 * key's hash the same way, so keys built with either id land in the same slots: invocations stay
 * apart and hash tags and slot layout stay exactly what the configuration alone would give.
 */
export function slotTwin(base: string): string {
  const target = crcOf(base)
  for (;;) {
    const prefix = Array.from(
      randomBytes(base.length - SEARCHED),
      (b) => ALPHABET[b % ALPHABET.length]
    ).join('')
    for (const tail of suffixes(SEARCHED)) if (crcOf(prefix + tail) === target) return prefix + tail
  }
}
