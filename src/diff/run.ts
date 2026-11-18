import { createHash } from 'node:crypto'
import { slotOf, primaryOf } from '../slot/slot.js'
import { scanDetailed } from '../scan/index.js'
import type { Scan } from '../scan/types.js'
import { Ctx, Side, matching } from './ctx.js'
import { Target } from './conn.js'
import { EXIT, ExitError } from '../errors.js'
import { HarnessError, classify, isSimFailure, isTransport } from './errors.js'
import {
  type DiffReport,
  type DriverReport,
  ERROR_CLASSES,
  type ErrorClass,
  type Totals,
} from './report.js'
import { Rng, seedFor } from './rng.js'
import { allDone } from './settle.js'
import { slotTwin } from './namespace.js'
import { type Lease, withRunLock } from './lock.js'
import type { Driver, Plan, Step } from './types.js'

const OBSERVE_EVERY = 25
const OBSERVE_PARALLEL = 64
const SEEDS_PARALLEL = 10
const ALIAS = { '@/': 'apps/sim' }

export interface DiffOptions {
  corpus: string
  referenceCorpus: string
  target: 'cluster' | 'standalone'
  seeds: number
  ops: number
  drivers: Driver[]
}

interface Outcome {
  json: string | null
  error: unknown
  ctx: Ctx
}

/** Running totals for one driver across all its seeds. */
class Tally {
  executed = new Map<string, number>()
  failed = new Map<string, number>()
  errors: Partial<Record<ErrorClass, number>> = {}
  mismatches = 0
  failingSeeds = 0
  referenceErrors = 0
  unverifiable = new Set<string>()
  entities = new Set<string>()
  primaries = new Set<number>()
  first: DriverReport['first'] = null

  bump(map: Map<string, number>, id: string): void {
    map.set(id, (map.get(id) ?? 0) + 1)
  }

  /** Adds a later seed's results; `first` keeps the earliest failure. */
  merge(other: Tally): void {
    for (const [id, n] of other.executed) this.executed.set(id, (this.executed.get(id) ?? 0) + n)
    for (const [id, n] of other.failed) this.failed.set(id, (this.failed.get(id) ?? 0) + n)
    for (const [cls, n] of Object.entries(other.errors) as Array<[ErrorClass, number]>) {
      this.errors[cls] = (this.errors[cls] ?? 0) + n
    }
    this.mismatches += other.mismatches
    this.failingSeeds += other.failingSeeds
    this.referenceErrors += other.referenceErrors
    other.entities.forEach((e) => this.entities.add(e))
    other.unverifiable.forEach((o) => this.unverifiable.add(o))
    other.primaries.forEach((p) => this.primaries.add(p))
    this.first ??= other.first
  }
}

async function exec(step: Step, side: Side): Promise<Outcome> {
  const ctx = new Ctx(side)
  try {
    const value = await step.run(ctx)
    return { json: JSON.stringify(value ?? null), error: null, ctx }
  } catch (error) {
    if (isSimFailure(error)) return { json: null, error, ctx }
    if (isTransport(error))
      throw new ExitError(EXIT.docker, `Redis node unavailable: ${message(error)}`)
    if (error instanceof ExitError || error instanceof HarnessError) throw error
    throw new HarnessError(
      `unexpected error in a driver: ${error instanceof Error ? error.stack : error}`
    )
  }
}

const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200)

class SeedRun {
  private touched: string[] = []
  private readonly tainted = new Set<string>()
  failed = false

  constructor(
    private readonly seed: number,
    private readonly plan: Plan,
    private readonly ref: Side,
    private readonly tgt: Side,
    private readonly tally: Tally,
    private readonly lease: Lease
  ) {}

  async run(): Promise<void> {
    const { steps } = this.plan
    for (const [op, step] of steps.entries()) {
      await this.step(op, step)
      if ((op + 1) % OBSERVE_EVERY === 0) await this.observe(op)
    }
    await this.observe(steps.length - 1)
  }

  private fail(op: number, text: string, ents: string[], sites: string[], isolate = true): void {
    this.failed = true
    if (isolate) ents.forEach((e) => this.tainted.add(e))
    for (const id of sites) this.tally.bump(this.tally.failed, id)
    this.tally.first ??= { seed: this.seed, op, message: text }
  }

  private async step(op: number, step: Step): Promise<void> {
    if (this.lease.lost) throw new HarnessError('the lease on the reference Redis was lost')
    const [ref, tgt] = (await allDone([exec(step, this.ref), exec(step, this.tgt)])) as [
      Outcome,
      Outcome,
    ]
    for (const ent of step.ents) {
      this.tally.entities.add(ent)
      if (!this.touched.includes(ent)) this.touched.push(ent)
    }
    for (const id of tgt.ctx.hits) this.tally.bump(this.tally.executed, id)
    unverifiedIds(ref.ctx, tgt.ctx).forEach((o) => this.tally.unverifiable.add(o))
    if (ref.error) {
      this.tally.referenceErrors++
      step.ents.forEach((e) => this.tainted.add(e))
      this.tally.first ??= {
        seed: this.seed,
        op,
        message: `reference error: ${message(ref.error)}`,
      }
    } else if (tgt.error) {
      const cls = classify(tgt.error)
      this.tally.errors[cls] = (this.tally.errors[cls] ?? 0) + 1
      this.fail(
        op,
        message(tgt.error),
        step.ents,
        tgt.ctx.failures.length > 0 ? tgt.ctx.failures : tgt.ctx.last ? [tgt.ctx.last] : [],
        !step.repair
      )
      await this.repair(step)
    } else if (ref.json !== tgt.json && !step.ents.some((e) => this.tainted.has(e))) {
      this.tally.mismatches++
      this.fail(op, `mismatch: ${ref.json} vs ${tgt.json}`.slice(0, 200), step.ents, tgt.ctx.hits)
    }
  }

  private async repair(step: Step): Promise<void> {
    try {
      await step.repair?.(new Ctx(this.tgt))
    } catch (error) {
      throw new HarnessError(`repair failed: ${message(error)}`)
    }
  }

  private async observe(op: number): Promise<void> {
    const ents = this.touched.filter((e) => !this.tainted.has(e))
    this.touched = []
    for (let i = 0; i < ents.length; i += OBSERVE_PARALLEL) {
      const batch = ents.slice(i, i + OBSERVE_PARALLEL)
      const seen = await allDone(
        batch.map(
          async (ent) =>
            [ent, await this.read(this.ref, ent), await this.read(this.tgt, ent)] as const
        )
      )
      for (const [ent, a, b] of seen.filter(([, a, b]) => a !== b)) {
        this.tally.mismatches++
        this.fail(op, `state mismatch on ${ent}: ${a} vs ${b}`.slice(0, 200), [ent], [])
      }
    }
  }

  private async read(side: Side, ent: string): Promise<string> {
    try {
      return JSON.stringify((await this.plan.observe(new Ctx(side), ent)) ?? null)
    } catch (error) {
      if (isTransport(error)) {
        throw new ExitError(EXIT.docker, `Redis node unavailable: ${message(error)}`)
      }
      throw new HarnessError(`observation of ${ent} failed: ${message(error)}`)
    }
  }
}

/** Replacement calls either side ran under a condition the harness cannot evaluate. */
export function unverifiedIds(...ctxs: Ctx[]): string[] {
  return [...new Set(ctxs.flatMap((c) => [...c.unverified]))]
}

export async function cleanup(side: Side): Promise<void> {
  const keys = [...side.written]
  for (let i = 0; i < keys.length; i += 50) {
    await allDone(keys.slice(i, i + 50).map((k) => side.conn.run(['DEL', k])))
  }
}

/** A driver with a call it could not check is never reported as passing. */
export function driverStatus(failingSeeds: number, unverified: number): DriverReport['status'] {
  if (failingSeeds > 0) return 'failing'
  return unverified > 0 ? 'unverifiable' : 'ok'
}

async function runDriver(
  driver: Driver,
  o: DiffOptions,
  ref: Scan,
  tgt: Scan,
  refT: Target,
  tgtT: Target,
  runId: string,
  lease: Lease
): Promise<{ tally: Tally; report: DriverReport }> {
  const tally = new Tally()
  const runSeed = async (seed: number): Promise<Tally> => {
    const mine = new Tally()
    const plan = driver.plan(new Rng(seedFor(driver.name, seed)), o.ops, `${runId}x${seed}`)
    const refSide = new Side(ref, refT, await refT.conn(driver.client))
    const tgtSide = new Side(tgt, tgtT, await tgtT.conn(driver.client))
    const run = new SeedRun(seed, plan, refSide, tgtSide, mine, lease)
    try {
      await run.run()
    } finally {
      // Once the lease is lost a successor may be using these very keys, so they are left alone.
      if (!lease.lost) await allDone([cleanup(refSide), cleanup(tgtSide)])
    }
    if (run.failed) mine.failingSeeds++
    for (const key of tgtSide.written) mine.primaries.add(primaryOf(slotOf(key)))
    return mine
  }
  const seeds = Array.from({ length: o.seeds }, (_, i) => i + 1)
  for (let i = 0; i < seeds.length; i += SEEDS_PARALLEL) {
    // Every seed of a batch settles before anything is closed or the failure is reported.
    for (const result of await allDone(seeds.slice(i, i + SEEDS_PARALLEL).map(runSeed))) {
      tally.merge(result)
    }
  }
  const siteIds = [...new Set(driver.sites.flatMap((sel) => matching(tgt, sel).map((s) => s.id)))]
  const errors = Object.fromEntries(
    ERROR_CLASSES.filter((c) => tally.errors[c]).map((c) => [c, tally.errors[c]])
  )
  const report: DriverReport = {
    name: driver.name,
    siteIds,
    ops: o.seeds * o.ops,
    failingSeeds: tally.failingSeeds,
    referenceErrors: tally.referenceErrors,
    sites: siteIds.map((id) => ({
      id,
      executed: tally.executed.get(id) ?? 0,
      failed: tally.failed.get(id) ?? 0,
    })),
    errors,
    distinctEntities: tally.entities.size,
    primariesCovered: tally.primaries.size,
    mismatches: tally.mismatches,
    unverifiable: [...tally.unverifiable].sort(),
    status: driverStatus(tally.failingSeeds, tally.unverifiable.size),
    controls: driver.controls,
    first: tally.first,
  }
  return { tally, report }
}

function scannerAccuracy(drivers: DriverReport[], tgt: Scan): DiffReport['scanner'] {
  const sites = drivers.flatMap((d) => d.sites).filter((s) => s.executed > 0)
  const hasError = new Map(
    tgt.sites.map((s) => [s.id, s.hazards.some((h) => h.severity === 'error')])
  )
  const ids = (keep: (failed: boolean, flagged: boolean) => boolean) =>
    sites
      .filter((s) => keep(s.failed > 0, hasError.get(s.id) ?? false))
      .map((s) => s.id)
      .sort()
  return {
    falsePositives: ids((failed, flagged) => flagged && !failed),
    falseNegatives: ids((failed, flagged) => failed && !flagged),
  }
}

function totalsOf(drivers: DriverReport[], tgt: Scan): Totals {
  const listed = new Set(drivers.flatMap((d) => d.siteIds))
  const executed = new Set(
    drivers.flatMap((d) => d.sites.filter((s) => s.executed > 0).map((s) => s.id))
  )
  const failing = new Set(
    drivers.flatMap((d) => d.sites.filter((s) => s.failed > 0).map((s) => s.id))
  )
  const errorSites = tgt.sites.filter(
    (s) => s.resolved && s.hazards.some((h) => h.severity === 'error')
  )
  const covered = errorSites.filter((s) => executed.has(s.id)).length
  return {
    drivers: drivers.length,
    failingDrivers: drivers.filter((d) => d.status === 'failing').length,
    unverifiableDrivers: drivers.filter((d) => d.status === 'unverifiable').length,
    failingSites: failing.size,
    executedSites: executed.size,
    unexecutedSites: listed.size - executed.size,
    ops: drivers.reduce((n, d) => n + d.ops, 0),
    mismatches: drivers.reduce((n, d) => n + d.mismatches, 0),
    coverage: {
      resolvedErrorSites: errorSites.length,
      executedResolvedErrorSites: covered,
      ratio: errorSites.length === 0 ? 0 : Number((covered / errorSites.length).toFixed(4)),
    },
  }
}

/** Names the configuration: the same options always give the same id. */
export function configIdOf(o: DiffOptions): string {
  const config = [
    o.corpus,
    o.referenceCorpus,
    o.target,
    o.seeds,
    o.ops,
    o.drivers.map((d) => d.name),
  ]
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 8)
}

/** Names one invocation: random, so concurrent identical runs never share a key, yet slot-neutral. */
export function invocationIdOf(o: DiffOptions): string {
  return slotTwin(configIdOf(o))
}

/** A connection lost anywhere in the run is an unavailable node, not a harness bug. */
export function atBoundary(error: unknown): unknown {
  if (error instanceof ExitError || error instanceof HarnessError) return error
  if (isTransport(error))
    return new ExitError(EXIT.docker, `Redis node unavailable: ${message(error)}`)
  return error
}

export async function runDiff(o: DiffOptions): Promise<DiffReport> {
  const tgtScan = scanDetailed(o.corpus, { alias: ALIAS })
  const refScan =
    o.referenceCorpus === o.corpus ? tgtScan : scanDetailed(o.referenceCorpus, { alias: ALIAS })
  const refT = Target.standalone(0)
  const tgtT = o.target === 'cluster' ? Target.cluster() : Target.standalone(1)
  const runId = invocationIdOf(o)
  try {
    await allDone([refT.verify(), tgtT.verify()])
    // Drivers use disjoint key names, so they run side by side; reports keep the driver order.
    // Cleanup is per key the run wrote (ctx.ts), never a pattern sweep that could match unrelated keys.
    const drivers = await withRunLock(await refT.conn('ioredis'), async (lease) => {
      const done = await allDone(
        o.drivers.map((d) => runDriver(d, o, refScan, tgtScan, refT, tgtT, runId, lease))
      )
      return done.map((r) => r.report)
    })
    return {
      schema: 1,
      redis: { reference: await refT.version(), target: await tgtT.version(), mode: o.target },
      corpus: o.corpus,
      referenceCorpus: o.referenceCorpus,
      seeds: o.seeds,
      opsPerSeed: o.ops,
      drivers,
      totals: totalsOf(drivers, tgtScan),
      unverifiable: drivers.flatMap((d) => d.unverifiable).sort(),
      scanner: scannerAccuracy(drivers, tgtScan),
    }
  } catch (error) {
    throw atBoundary(error)
  } finally {
    await allDone([refT.close(), tgtT.close()]).catch(() => {})
  }
}
