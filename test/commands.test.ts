import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanDetailed } from '../src/scan/index.js'

function scan(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'crossslot-scan-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'a.ts'),
    `import Redis from 'ioredis'\nconst redis = new Redis()\n${source}`
  )
  return scanDetailed(dir).result.sites
}

describe('command grammar', () => {
  it('reads the keys of an ioredis XREAD after STREAMS, not the ids', () => {
    const [site] = scan(
      `export const f = () => redis.xread('COUNT', 1, 'STREAMS', 'a', 'b', '0', '0')`
    )
    expect(site?.keyPatterns).toEqual(['a', 'b'])
  })

  it('counts only numkeys keys after ZUNIONSTORE destination', () => {
    const sites = scan(
      `export const f = () => redis.zunionstore('{t}d', 2, '{t}a', '{t}b', 'WEIGHTS', 1, 2)`
    )
    expect(sites[0]?.keyPatterns).toEqual(['{t}d', '{t}a', '{t}b'])
    expect(sites[0]?.hazards).toEqual([])
  })

  it('does not trust a let binding', () => {
    const [site] = scan(`let k = 'a:{t}'
k = 'other'
export const f = () => redis.eval('return 1', 2, k, 'a:{t}')`)
    expect(site?.keyPatterns?.[0]).toBe('${k}')
  })

  it('marks a key built by an unknown call as unresolved', () => {
    const [site] = scan(`declare function mystery(x: string): string
export const f = (id: string) => redis.eval('return 1', 1, mystery(id))`)
    expect(site?.resolved).toBe(false)
    expect(site?.hazards.map((h) => h.code)).toContain('UNRESOLVED')
  })
})

describe('replacement calls and their conditions', () => {
  const ops = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'crossslot-ops-'))
    writeFileSync(
      join(dir, 'a.ts'),
      `import Redis from 'ioredis'\nconst redis = new Redis()\n${body}`
    )
    return scanDetailed(dir).ops
  }

  it('drops a call that a constant condition rules out', () => {
    expect(
      ops(`export function f(k: string) { if (false) { return redis.get(k) } return null }`)
    ).toEqual([])
    expect(ops(`export function f(k: string) { return true ? null : redis.get(k) }`)).toEqual([])
  })

  it('drops a call in a loop that a constant condition never enters', () => {
    expect(ops(`export function f(k: string) { while (false) { redis.get(k) } }`)).toEqual([])
    expect(ops(`export function f(k: string) { for (; false; ) { redis.get(k) } }`)).toEqual([])
  })

  it('keeps a call in a loop with an unknown condition, marked unknown', () => {
    const [op] = ops(
      `export function f(k: string, n: () => boolean) { while (n()) { redis.get(k) } }`
    )
    expect(op?.guard).toBe('unknown')
  })

  it('keeps a call under a condition it cannot evaluate, marked unknown', () => {
    const [op] = ops(
      `export function f(k: string, on: boolean) { if (on) { return redis.get(k) } return null }`
    )
    expect(op?.guard).toBe('unknown')
  })

  it('marks a call in a local helper that is called under a condition', () => {
    const [op] = ops(`export function f(k: string, on: boolean) {
  const read = () => redis.get(k)
  if (on) return read()
  return null
}`)
    expect(op?.guard).toBe('unknown')
  })

  it('treats an unguarded call as certain', () => {
    expect(ops(`export function f(k: string) { return redis.get(k) }`)[0]?.guard).toBe('none')
  })
})

describe('XREAD with spreads', () => {
  it('flattens a known id list instead of reading it as keys', () => {
    const [site] = scan(`const ids = ['0', '0']
export const f = () => redis.xread('STREAMS', 'a', 'b', ...ids)`)
    expect(site?.keyPatterns).toEqual(['a', 'b'])
  })

  it('reports unknown keys when the spread cannot be flattened', () => {
    const [site] = scan(
      `export const f = (ids: string[]) => redis.xread('STREAMS', 'a', 'b', ...ids)`
    )
    expect(site?.keyPatterns).toBeNull()
    expect(site?.hazards.map((h) => h.code)).toContain('CROSS_SLOT_KEYS')
  })
})

describe('mutable variables', () => {
  it('reports a key read from a property of a mutable object as unresolved', () => {
    const [site] = scan(`export const f = () => {
  let o = { id: 'a' }
  o = { id: 'b' }
  return redis.eval('return 1', 1, \`x:\${o.id}\`)
}`)
    expect(site?.resolved).toBe(false)
    expect(site?.hazards.map((h) => h.code)).toContain('UNRESOLVED')
  })

  it('reports a key taken from a let variable as unresolved', () => {
    const [site] = scan(`export const f = () => {
  let k = 'a'
  k = 'b'
  return redis.eval('return 1', 1, \`x:\${k}\`)
}`)
    expect(site?.resolved).toBe(false)
    expect(site?.hazards.map((h) => h.code)).toContain('UNRESOLVED')
  })
})
