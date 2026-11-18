import { describe, expect, it } from 'vitest'
import { render } from '../src/diff/ctx.js'
import { classify } from '../src/diff/errors.js'
import { Rng } from '../src/diff/rng.js'

describe('render', () => {
  it('fills placeholders, including ones with nested braces', () => {
    expect(render('k:${a}:${f({x})}', { a: 1, 'f({x})': 'y' })).toBe('k:1:y')
  })

  it('refuses a placeholder the driver gave no value for', () => {
    expect(() => render('k:${missing}', {})).toThrow(/no value for/)
  })
})

describe('classify', () => {
  it.each([
    ["CROSSSLOT Keys in request don't hash to the same slot", 'CROSSSLOT'],
    ['ERR Script attempted to access keys that do not hash to the same slot', 'CROSSSLOT'],
    ['MOVED 5812 127.0.0.1:7002', 'MOVED'],
    ['ERR Script attempted to access a non local key in a cluster node script', 'NONLOCAL_KEY'],
    [
      'All keys in the pipeline should belong to the same slots allocation group',
      'CLIENT_PIPELINE_SLOTS',
    ],
    ['WRONGTYPE', 'OTHER'],
  ])('%s', (text, cls) => {
    expect(classify(new Error(text))).toBe(cls)
  })
})

describe('Rng', () => {
  it('gives the same stream for the same seed', () => {
    const draw = (seed: number) =>
      Array.from(
        { length: 5 },
        (
          (r) => () =>
            r.int(0, 1000)
        )(new Rng(seed))
      )
    expect(draw(7)).toEqual(draw(7))
    expect(draw(7)).not.toEqual(draw(8))
  })

  it('samples without repeats', () => {
    expect(new Set(new Rng(1).sample([1, 2, 3, 4, 5], 5)).size).toBe(5)
  })
})
