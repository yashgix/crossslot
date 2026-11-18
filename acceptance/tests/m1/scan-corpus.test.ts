import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { CORPUS, errorCodes, scanCli, siteAt } from '../../helpers'

const PREFIX_KIND = /\.(eval|evalsha|evalSha|multi|pipeline)\(/
const FAMILY_KINDS = new Set(['eval', 'evalsha', 'multi', 'pipeline'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

function grepIds(): string[] {
  const ids: string[] = []
  for (const file of walk(CORPUS)) {
    const rel = relative(CORPUS, file)
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (PREFIX_KIND.test(line)) ids.push(`${rel}:${i + 1}`)
      })
  }
  return ids.sort()
}

let result: any

beforeAll(() => {
  const r = scanCli(CORPUS, ['--alias', '@/=apps/sim'])
  expect(r.run.code).toBe(0)
  result = r.result
})

describe('S-1 recall against an independent counter', () => {
  it('S-1 the independent grep counts 71 lines at the pin', () => {
    expect(grepIds()).toHaveLength(71)
  })

  it('S-1 eval, evalsha, multi and pipeline sites are exactly the grep lines', () => {
    const ids = result.sites.filter((s: any) => FAMILY_KINDS.has(s.kind)).map((s: any) => s.id)
    expect([...ids].sort()).toEqual(grepIds())
  })

  it('S-1 site ids are unique and equal file:line', () => {
    const ids = result.sites.map((s: any) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of result.sites) expect(s.id).toBe(`${s.file}:${s.line}`)
  })
})

describe('S-2 resolution quality', () => {
  it('S-2 at most 9 of the 60 eval-family sites are unresolved and each is explained', () => {
    const evals = result.sites.filter((s: any) => s.kind === 'eval' || s.kind === 'evalsha')
    const unresolved = evals.filter((s: any) => !s.resolved)
    expect(evals.length).toBe(60)
    expect(unresolved.length).toBeLessThanOrEqual(9)
    for (const s of unresolved) {
      expect(s.hazards.some((h: any) => h.code === 'UNRESOLVED' && h.detail.length > 0)).toBe(true)
    }
  })

  it('S-2 the summary counts match the sites', () => {
    const errors = result.sites.filter((s: any) => errorCodes(s).length > 0).length
    expect(result.summary.sites).toBe(result.sites.length)
    expect(result.summary.errors).toBe(errors)
    expect(result.summary.unresolved).toBe(result.sites.filter((s: any) => !s.resolved).length)
  })
})

describe('S-4 S-5 S-6 known sites at the pin', () => {
  it('S-4 the hosted-key CHECK_HEAD script has UNDECLARED_KEY', () => {
    const s = siteAt(result, 'apps/sim/lib/core/rate-limiter/hosted-key/queue.ts', 138)
    expect(s.kind).toBe('eval')
    expect(errorCodes(s)).toContain('UNDECLARED_KEY')
    expect(s.keyPatterns).toEqual(['hosted-queue:${provider}:${billingActorId}'])
  })

  it('S-5 the realtime room script has four keys and CROSS_SLOT_KEYS', () => {
    const s = siteAt(result, 'apps/realtime/src/rooms/redis-manager.ts', 281)
    expect(s).toMatchObject({ kind: 'evalsha', client: 'node-redis', keyCount: 4 })
    expect(s.keyPatterns).toHaveLength(4)
    expect(errorCodes(s)).toContain('CROSS_SLOT_KEYS')
  })

  it('S-5 del(approvalKey, mintLockKey) has CROSS_SLOT_KEYS', () => {
    const s = siteAt(result, 'apps/sim/lib/cli-auth/approval-store.ts', 160)
    expect(s.kind).toBe('multikey')
    expect(errorCodes(s)).toContain('CROSS_SLOT_KEYS')
  })

  it('S-5 the single-key lock scripts have no hazard', () => {
    for (const line of [558, 581]) {
      const s = siteAt(result, 'apps/sim/lib/core/config/redis.ts', line)
      expect(s.keyCount).toBe(1)
      expect(s.hazards).toEqual([])
    }
  })

  it('S-6 the known multikey sites exist with the right command', () => {
    const expected: Array<[string, number, string]> = [
      ['apps/sim/lib/core/outbox/retention.ts', 101, 'mget'],
      ['apps/sim/lib/mothership/request/session/abort.ts', 172, 'mget'],
      ['apps/sim/lib/billing/core/usage-segment-cache.ts', 54, 'mget'],
      ['apps/sim/lib/webhooks/polling/admission-refusals.ts', 49, 'mget'],
      ['apps/sim/lib/mothership/request/session/buffer.ts', 152, 'del'],
      ['apps/realtime/src/rooms/redis-manager.ts', 385, 'del'],
      ['apps/realtime/src/handlers/file-doc-store.ts', 1218, 'xread'],
      ['apps/realtime/src/handlers/file-doc-store.ts', 1227, 'xread'],
    ]
    for (const [file, line, command] of expected) {
      const s = siteAt(result, file, line)
      expect(s, `${file}:${line}`).toBeDefined()
      expect(s).toMatchObject({ kind: 'multikey', command })
    }
  })

  it('S-5 the multi-document xRead reads have CROSS_SLOT_KEYS', () => {
    for (const line of [1218, 1227]) {
      expect(errorCodes(siteAt(result, 'apps/realtime/src/handlers/file-doc-store.ts', line))).toContain('CROSS_SLOT_KEYS')
    }
  })

  it('S-6 single-key del calls are not sites', () => {
    expect(siteAt(result, 'apps/sim/lib/oauth/terminal-errors.ts', 45)).toBeUndefined()
    expect(siteAt(result, 'apps/sim/lib/cli-auth/approval-store.ts', 166)).toBeUndefined()
    expect(siteAt(result, 'apps/sim/lib/core/rate-limiter/storage/redis-token-bucket.ts', 222)).toBeUndefined()
  })
})
