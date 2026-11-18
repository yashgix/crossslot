import { describe, expect, it } from 'vitest'
import { EXIT, ExitError } from '../src/errors.js'
import {
  atBoundary,
  configIdOf,
  driverStatus,
  invocationIdOf,
  unverifiedIds,
} from '../src/diff/run.js'
import { Ctx, Side, render } from '../src/diff/ctx.js'
import type { Conn } from '../src/diff/conn.js'
import type { Scan } from '../src/scan/types.js'
import { slotOf } from '../src/slot/slot.js'

const OPTIONS = {
  corpus: 'a',
  referenceCorpus: 'a',
  target: 'cluster' as const,
  seeds: 5,
  ops: 200,
  drivers: [],
}

describe('driver status', () => {
  it('is never ok while a replacement call is unchecked', () => {
    expect(driverStatus(0, 2)).toBe('unverifiable')
    expect(driverStatus(0, 0)).toBe('ok')
    expect(driverStatus(3, 2)).toBe('failing')
  })
})

function ctxWith(unverified: string[]): Ctx {
  const scan = { sites: [], ops: [] } as unknown as Scan
  const side = new Side(scan, { loadScript: async () => 'sha' }, {} as Conn)
  const c = new Ctx(side)
  unverified.forEach((o) => c.unverified.add(o))
  return c
}

describe('unverifiable guards', () => {
  it('counts a guard seen only on the baseline side', () => {
    const ids = unverifiedIds(ctxWith(['base-site']), ctxWith([]))
    expect(ids).toEqual(['base-site'])
    expect(driverStatus(0, ids.length)).toBe('unverifiable')
  })

  it('merges both sides without duplicates', () => {
    expect(unverifiedIds(ctxWith(['a', 'b']), ctxWith(['b', 'c'])).sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('invocation id', () => {
  const keys = (id: string) =>
    ['q:{${id}}:list', 'q:{${id}}:t1', 'plain:${id}:a', 'plain:${id}:b'].map((t) =>
      render(t, { id })
    )

  it('differs between identical invocations', () => {
    expect(invocationIdOf(OPTIONS)).not.toBe(invocationIdOf({ ...OPTIONS }))
    expect(invocationIdOf(OPTIONS)).not.toBe(configIdOf(OPTIONS))
  })

  it('gives two identical invocations disjoint keys', () => {
    const [one, two] = [invocationIdOf(OPTIONS), invocationIdOf(OPTIONS)].map(keys) as [
      string[],
      string[],
    ]
    expect(one.some((k) => two.includes(k))).toBe(false)
  })

  it('puts every key in the slot the configuration id alone would give, tags included', () => {
    const base = keys(configIdOf(OPTIONS)).map(slotOf)
    expect(keys(invocationIdOf(OPTIONS)).map(slotOf)).toEqual(base)
    expect(base[0]).toBe(base[1])
  })
})

describe('run id', () => {
  it('is the same for the same configuration and differs for another', () => {
    expect(configIdOf(OPTIONS)).toBe(configIdOf({ ...OPTIONS }))
    expect(configIdOf(OPTIONS)).not.toBe(configIdOf({ ...OPTIONS, seeds: 6 }))
    expect(configIdOf(OPTIONS)).toMatch(/^[0-9a-f]{8}$/)
  })

  it('keeps keys that share a hash tag in one slot, whatever the id', () => {
    const slots = ['aaaaaaaax1', 'bbbbbbbbx9'].map((id) => {
      const keys = ['q:{${id}}:list', 'q:{${id}}:tkt:t1'].map((t) => render(t, { id }))
      return new Set(keys.map(slotOf)).size
    })
    expect(slots).toEqual([1, 1])
  })

  it('leaves keys without a shared tag in separate slots', () => {
    const keys = ['q:${id}:list', 'q:${id}:tkt'].map((t) => render(t, { id: 'aaaaaaaax1' }))
    expect(new Set(keys.map(slotOf)).size).toBe(2)
  })
})

describe('run boundary', () => {
  it('turns a connection reset into node unavailability', () => {
    const error = atBoundary(new Error('read ECONNRESET'))
    expect(error).toBeInstanceOf(ExitError)
    expect((error as ExitError).code).toBe(EXIT.docker)
  })

  it('leaves other errors alone', () => {
    const bug = new TypeError('x is undefined')
    expect(atBoundary(bug)).toBe(bug)
  })
})
