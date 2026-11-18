import { describe, expect, it } from 'vitest'
import { lib } from '../../helpers'

describe('L-1 slotOf matches Redis', () => {
  const cases: Array<[string, number]> = [
    ['foo', 12182],
    ['bar', 5061],
    ['hello', 866],
    ['somekey', 11058],
    ['123456789', 12739],
    ['{user1000}.following', 3443],
    ['{user1000}.followers', 3443],
    ['user1000', 3443],
    ['foo{}{bar}', 8363],
    ['{foo}{bar}', 12182],
    ['foo{bar}{zap}', 5061],
  ]
  for (const [key, slot] of cases) {
    it(`L-1 slotOf(${JSON.stringify(key)}) = ${slot}`, async () => {
      expect((await lib()).slotOf(key)).toBe(slot)
    })
  }

  it('L-1 every slot is within 0..16383 for varied keys', async () => {
    const { slotOf } = await lib()
    for (let i = 0; i < 2000; i++) {
      const s = slotOf(`k:${i}:${'x'.repeat(i % 40)}`)
      expect(Number.isInteger(s) && s >= 0 && s < 16384).toBe(true)
    }
  })

  it('L-1 the hash tag decides the slot, the rest of the key does not', async () => {
    const { slotOf } = await lib()
    expect(slotOf('{t}a')).toBe(slotOf('{t}completely-different'))
    expect(slotOf('pre{t}post')).toBe(slotOf('{t}'))
  })
})
