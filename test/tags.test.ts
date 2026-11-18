import { describe, expect, it } from 'vitest'
import { colocated, tagOf } from '../src/scan/tags.js'
import { primaryOf, slotOf } from '../src/slot/slot.js'

describe('tagOf', () => {
  it('reads the first non-empty tag and treats placeholders as opaque', () => {
    expect(tagOf('a:{${id}}:x')).toBe('${id}')
    expect(tagOf('{u:${a}}:y')).toBe('u:${a}')
    expect(tagOf('plain:${id}')).toBeNull()
    expect(tagOf('x{}y{z}')).toBeNull()
  })
})

describe('colocated', () => {
  it('needs the same literal tag, or the same key', () => {
    expect(colocated(['{a}x', '{a}y'])).toBe(true)
    expect(colocated(['{a}x', '{b}y'])).toBe(false)
    expect(colocated(['k:${id}', 'k:${id}'])).toBe(true)
    expect(colocated(['k:${a}', 'k:${b}'])).toBe(false)
  })

  it('never trusts a tag that depends on the list element', () => {
    expect(colocated(['{u:${*}}:x'])).toBe(false)
    expect(colocated(['{u:${id}}:x'], true)).toBe(false)
    expect(colocated(['{u}:x'], true)).toBe(true)
  })
})

describe('primaryOf', () => {
  it('follows the even three-way split of the slot range', () => {
    expect([0, 5460, 5461, 10922, 10923, 16383].map(primaryOf)).toEqual([0, 0, 1, 1, 2, 2])
    expect(primaryOf(slotOf('foo'))).toBe(2)
  })
})
