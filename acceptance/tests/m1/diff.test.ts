import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { CLUSTER, CONTROL_DRIVERS, CORPUS, M1_DRIVERS, cli, copyTree, readJson, scanCli, tmp } from '../../helpers'

const CLASSES = ['CROSSSLOT', 'MOVED', 'NONLOCAL_KEY', 'CLIENT_PIPELINE_SLOTS', 'OTHER']

function diff(drivers: string, out: string, extra: string[] = []) {
  const run = cli([
    'diff', '--corpus', CORPUS, '--target', 'cluster', '--seeds', '5', '--ops', '200',
    '--drivers', drivers, '--out', out, ...extra,
  ])
  return { run, report: run.code === 0 || run.code === 1 ? readJson(out) : null }
}

describe.skipIf(!CLUSTER)('differential harness on the original corpus (needs the cluster)', () => {
  const out = join(tmp(), 'before.json')
  let report: any

  beforeAll(() => {
    const r = diff('hosted-queue,realtime-rooms,approval-store,lock,otp,idempotency', out)
    expect([0, 1]).toContain(r.run.code)
    report = r.report
  })

  const driver = (name: string) => report.drivers.find((d: any) => d.name === name)

  it('D-4 the report follows the report schema and error classes', () => {
    expect(report.schema).toBe(1)
    expect(report.redis.mode).toBe('cluster')
    expect(report.seeds).toBe(5)
    expect(report.opsPerSeed).toBe(200)
    for (const d of report.drivers) {
      for (const cls of Object.keys(d.errors)) expect(CLASSES).toContain(cls)
      expect(d.siteIds.length).toBeGreaterThan(0)
    }
    expect(report.totals.drivers).toBe(report.drivers.length)
  })

  it('D-5 control drivers (single-key Sim scripts) report 0 failures', () => {
    for (const name of CONTROL_DRIVERS) {
      const d = driver(name)
      expect(d.controls).toBe(true)
      expect(d).toMatchObject({ failingSeeds: 0, mismatches: 0 })
      expect(Object.values(d.errors).reduce((a: number, b: any) => a + b, 0)).toBe(0)
    }
  })

  it('D-6 hosted-queue and realtime-rooms fail on the original corpus with classified errors', () => {
    for (const name of ['hosted-queue', 'realtime-rooms']) {
      const d = driver(name)
      const errors = Object.values(d.errors).reduce((a: number, b: any) => a + b, 0)
      expect(errors + d.mismatches, name).toBeGreaterThan(0)
      expect(d.failingSeeds).toBeGreaterThan(0)
      expect(d.errors.OTHER ?? 0).toBe(0)
      expect(d.first).toMatchObject({ seed: expect.any(Number), op: expect.any(Number) })
    }
  })

  it('D-6 approval-store del(a, b) fails with CROSSSLOT (or is listed as a scanner false positive)', () => {
    const d = driver('approval-store')
    expect(d.errors.CROSSSLOT ?? 0).toBeGreaterThan(0)
  })

  it('D-3 each driver covers all three primaries and at least 200 distinct entities', () => {
    for (const d of report.drivers) {
      expect(d.primariesCovered).toBe(3)
      expect(d.distinctEntities).toBeGreaterThanOrEqual(200)
    }
  })

  it('D-1 the same seeds give an identical report', () => {
    const again = join(tmp(), 'again.json')
    diff('hosted-queue,realtime-rooms,approval-store,lock,otp,idempotency', again)
    expect(readFileSync(again, 'utf8')).toBe(readFileSync(out, 'utf8'))
  })

  it('D-5 --fail-on-failure exits 1 when a non-control driver fails and 0 for controls only', () => {
    const bad = diff('hosted-queue', join(tmp(), 'b.json'), ['--fail-on-failure'])
    expect(bad.run.code).toBe(1)
    const ok = diff('lock,otp,idempotency', join(tmp(), 'c.json'), ['--fail-on-failure'])
    expect(ok.run.code).toBe(0)
  })

  it('D-1 --drivers all includes every M1 driver', () => {
    const all = diff('all', join(tmp(), 'all.json'))
    const names = all.report.drivers.map((d: any) => d.name)
    for (const name of M1_DRIVERS) expect(names).toContain(name)
  })

  it('D-9 the reference never errors and every listed site executes at least 10 times', () => {
    const all = diff('all', join(tmp(), 'sites.json')).report
    for (const d of all.drivers) {
      expect(d.referenceErrors, d.name).toBe(0)
      expect(d.sites.map((s: any) => s.id).sort()).toEqual([...d.siteIds].sort())
      for (const s of d.sites) {
        expect(s.executed, `${d.name} ${s.id}`).toBeGreaterThanOrEqual(10)
        expect(s.failed).toBeLessThanOrEqual(s.executed)
      }
    }
  })

  it('D-9 failingSites counts only sites with an observed failure', () => {
    const r = diff('hosted-queue,lock', join(tmp(), 'f.json')).report
    const failed = new Set<string>()
    const executed = new Set<string>()
    for (const d of r.drivers) {
      for (const s of d.sites) {
        if (s.failed > 0) failed.add(s.id)
        if (s.executed > 0) executed.add(s.id)
      }
    }
    expect(r.totals.failingSites).toBe(failed.size)
    expect(r.totals.executedSites).toBe(executed.size)
    const all = new Set(r.drivers.flatMap((d: any) => d.siteIds))
    expect(r.totals.unexecutedSites).toBe(all.size - executed.size)
    const lock = r.drivers.find((d: any) => d.name === 'lock')
    expect(lock.sites.every((s: any) => s.failed === 0)).toBe(true)
  })

  it('D-2 hand-editing only key literals changes the hosted-queue outcome with no driver change', () => {
    const edited = copyTree(CORPUS)
    const file = join(edited, 'apps/sim/lib/core/rate-limiter/hosted-key/queue.ts')
    const src = readFileSync(file, 'utf8')
      .replaceAll('hosted-queue-tkt:', '{hq}:hosted-queue-tkt:')
      .replaceAll('hosted-queue:', '{hq}:hosted-queue:')
    writeFileSync(file, src)
    const before = diff('hosted-queue', join(tmp(), 'o.json')).report.drivers[0]
    const out = join(tmp(), 'e.json')
    const run = cli(['diff', '--corpus', edited, '--target', 'cluster', '--seeds', '5', '--ops', '200', '--drivers', 'hosted-queue', '--out', out])
    expect([0, 1]).toContain(run.code)
    const after = readJson(out).drivers[0]
    expect(before.failingSeeds).toBeGreaterThan(0)
    expect(after).toMatchObject({ failingSeeds: 0, mismatches: 0 })
  })

  it('D-10 a run leaves every node with the key count it had before and never flushes', async () => {
    const { Cluster } = await import('ioredis')
    const [host, port] = (process.env.CROSSSLOT_CLUSTER_SEEDS ?? '127.0.0.1:7001').split(',')[0].split(':')
    const cluster = new Cluster([{ host, port: Number(port) }])
    const count = async () => (await Promise.all(cluster.nodes('master').map((n) => n.dbsize()))).reduce((a, b) => a + b, 0)
    try {
      await cluster.set('unrelated:sentinel', 'keep')
      const before = await count()
      diff('hosted-queue,approval-store,lock', join(tmp(), 'k.json'))
      expect(await count()).toBe(before)
      expect(await cluster.get('unrelated:sentinel')).toBe('keep')
    } finally {
      await cluster.del('unrelated:sentinel')
      cluster.disconnect()
    }
  })
})

describe('differential harness input checks (no cluster needed)', () => {
  it('R-5 a non-loopback Redis URL is refused before any connection', () => {
    const r = cli(
      ['diff', '--corpus', CORPUS, '--target', 'standalone', '--seeds', '1', '--ops', '1', '--drivers', 'lock', '--out', join(tmp(), 'n.json')],
      { CROSSSLOT_STANDALONE_URL: 'redis://192.0.2.1:6379' },
      30_000
    )
    expect(r.code).toBe(2)
  })

  it('D-2 editing key literals in queue.ts changes the scanned key patterns', () => {
    const edited = copyTree(CORPUS)
    const file = join(edited, 'apps/sim/lib/core/rate-limiter/hosted-key/queue.ts')
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('hosted-queue:', '{hq}:hosted-queue:'))
    const site = scanCli(edited, ['--alias', '@/=apps/sim']).result.sites.find((s: any) => s.line === 138)
    expect(site.keyPatterns[0]).toMatch(/^\{hq\}:hosted-queue:/)
  })

  it('D-1 an unknown driver name or a missing corpus is a usage error', () => {
    const out = join(tmp(), 'x.json')
    expect(cli(['diff', '--corpus', CORPUS, '--target', 'cluster', '--seeds', '1', '--ops', '1', '--drivers', 'nope', '--out', out]).code).toBe(2)
    expect(cli(['diff', '--corpus', '/nonexistent-crossslot', '--target', 'cluster', '--seeds', '1', '--ops', '1', '--drivers', 'all', '--out', out]).code).toBe(2)
  })
})
