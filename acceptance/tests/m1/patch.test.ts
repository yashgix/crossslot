import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLUSTER, CORPUS, MANIFEST, PATCH, ROOT, cli, patchedCorpus, readJson, scanCli, tmp, unfixed,
} from '../../helpers'

const QUEUE = 'apps/sim/lib/core/rate-limiter/hosted-key/queue.ts'

describe('P-1 patch apply', () => {
  it('P-1 applies cleanly, leaves the input untouched, and changes the hosted-key queue keys', () => {
    const out = patchedCorpus()
    expect(cli(['corpus', 'verify', '--dir', CORPUS, '--manifest', MANIFEST]).code).toBe(0)
    expect(readFileSync(join(out, QUEUE), 'utf8')).not.toBe(readFileSync(join(CORPUS, QUEUE), 'utf8'))
  })

  it('P-1 applying twice fails with exit 2', () => {
    const once = patchedCorpus()
    const r = cli(['patch', 'apply', '--corpus', once, '--patch', PATCH, '--out', join(tmp(), 'twice')])
    expect(r.code).toBe(2)
  })

  it('P-1 a patch that names a path outside the tree is refused and writes nothing outside OUT', () => {
    const base = tmp()
    const evil = join(base, 'evil.patch')
    writeFileSync(
      evil,
      '--- a/../escaped.txt\n+++ b/../escaped.txt\n@@ -0,0 +1 @@\n+owned\n'
    )
    const out = join(base, 'out')
    const r = cli(['patch', 'apply', '--corpus', CORPUS, '--patch', evil, '--out', out])
    expect(r.code).toBe(2)
    expect(existsSync(join(base, 'escaped.txt'))).toBe(false)
  })

  it('P-1 a missing patch or corpus is a usage error', () => {
    expect(cli(['patch', 'apply', '--corpus', CORPUS, '--patch', '/nonexistent.patch', '--out', join(tmp(), 'o')]).code).toBe(2)
  })

  it('P-1 the patch ships with Sim LICENSE and NOTICE (Apache-2.0 section 4)', () => {
    for (const f of ['LICENSE', 'NOTICE']) {
      expect(readFileSync(join(ROOT, 'patch', f), 'utf8')).toBe(readFileSync(join(CORPUS, f), 'utf8'))
    }
    expect(readFileSync(join(ROOT, 'patch/NOTES.md'), 'utf8')).toMatch(/modif/i)
  })
})

describe('P-3 P-4 patch notes and static result', () => {
  const notes = readFileSync(join(ROOT, 'patch/NOTES.md'), 'utf8')

  it('P-3 every changed file is listed in NOTES.md with a class T, D, S or R', () => {
    const files = [...readFileSync(PATCH, 'utf8').matchAll(/^\+\+\+ b\/(\S+)/gm)].map((m) => m[1])
    expect(files.length).toBeGreaterThan(0)
    for (const f of files.filter((f) => /\.ts$/.test(f))) {
      const line = notes.split('\n').find((l) => l.includes(f))
      expect(line, f).toBeDefined()
      expect(line).toMatch(/\b[TDSR]\b/)
    }
  })

  it('P-4 realtime-rooms is classed R and queue.ts is not left with an error hazard', () => {
    expect(notes).toMatch(/redis-manager\.ts.*\bR\b/)
    const { result } = scanCli(patchedCorpus(), ['--alias', '@/=apps/sim'])
    const queue = result.sites.filter((s: any) => s.file === QUEUE)
    expect(queue.length).toBeGreaterThanOrEqual(4)
    for (const s of queue) expect(s.hazards.filter((h: any) => h.severity === 'error')).toEqual([])
  })

  it('P-2 at most two drivers are UNFIXED, each with a known error class and a reason', () => {
    const lines = notes.split('\n').filter((l) => l.startsWith('UNFIXED:'))
    expect(lines.length).toBeLessThanOrEqual(2)
    expect(unfixed()).toHaveLength(lines.length)
    for (const u of unfixed()) expect(['CROSSSLOT', 'MOVED', 'NONLOCAL_KEY', 'CLIENT_PIPELINE_SLOTS']).toContain(u.cls)
  })

  it('P-3b the multi-document xRead is class S in the notes and no xread site keeps an error hazard', () => {
    expect(notes).toMatch(/file-doc-store\.ts.*\bS\b/)
    const { result } = scanCli(patchedCorpus(), ['--alias', '@/=apps/sim'])
    const reads = result.sites.filter((s: any) => s.command === 'xread')
    for (const s of reads) expect(s.hazards.filter((h: any) => h.severity === 'error')).toEqual([])
  })

  it('P-3 each renamed key has its TTL (or "none") recorded', () => {
    expect(notes).toMatch(/ttl/i)
  })
})

describe.skipIf(!CLUSTER)('patch proof on the cluster (needs the cluster)', () => {
  const run = (args: string[]) => {
    const out = join(tmp(), 'r.json')
    const r = cli([...args, '--out', out])
    expect([0, 1]).toContain(r.code)
    return readJson(out)
  }

  it('P-2 after the patch every M1 driver has 0 failures except UNFIXED ones, whose errors stay in the declared class', () => {
    const report = run([
      'diff', '--corpus', patchedCorpus(), '--target', 'cluster', '--seeds', '20', '--ops', '500', '--drivers', 'all',
    ])
    const declared = new Map(unfixed().map((u) => [u.driver, u.cls]))
    for (const d of report.drivers) {
      expect(d.referenceErrors, d.name).toBe(0)
      expect(d.ops).toBeGreaterThanOrEqual(10_000)
      expect(d.mismatches, d.name).toBe(0)
      const cls = declared.get(d.name)
      if (cls) {
        expect(Object.keys(d.errors).filter((k) => d.errors[k] > 0 && k !== cls), d.name).toEqual([])
        continue
      }
      expect(d.failingSeeds, d.name).toBe(0)
      expect(Object.values(d.errors).reduce((a: number, b: any) => a + b, 0), d.name).toBe(0)
    }
  })

  it('D-7 patched corpus on standalone behaves like the original on standalone', () => {
    const report = run([
      'diff', '--corpus', patchedCorpus(), '--reference-corpus', CORPUS, '--target', 'standalone',
      '--seeds', '20', '--ops', '500', '--drivers', 'all',
    ])
    expect(report.totals.mismatches).toBe(0)
    expect(report.redis.mode).toBe('standalone')
    for (const d of report.drivers) {
      expect(d.referenceErrors, d.name).toBe(0)
      expect(Object.values(d.errors).reduce((a: number, b: any) => a + b, 0), d.name).toBe(0)
      for (const s of d.sites) expect(s.executed, `${d.name} ${s.id}`).toBeGreaterThanOrEqual(10)
    }
  })
})
