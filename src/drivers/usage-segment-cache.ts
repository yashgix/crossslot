import { allDone } from '../diff/settle.js'
import type { Ctx } from '../diff/ctx.js'
import type { Rng } from '../diff/rng.js'
import type { Driver, Selector, Step } from '../diff/types.js'
import { episodes } from './kit.js'

const FILE = 'apps/sim/lib/billing/core/usage-segment-cache.ts'
const READ: Selector = { file: FILE, fn: 'readStored' }
const WRITE: Selector = { file: FILE, fn: 'writeStored' }
const TTL_MS = 3_600_000
const SEGMENTS = 40

const segmentKey = (c: Ctx, namespace: string, n: number) =>
  c.helperKey(FILE, 'keyOf', { namespace, segmentKey: `2026-01-${String(n).padStart(2, '0')}` })

function episode(rng: Rng, seed: string, index: number): Step[] {
  const namespace = `ns${seed}-${index}`
  const ents = [namespace]
  const written = rng.sample(
    Array.from({ length: SEGMENTS }, (_, n) => n),
    rng.int(3, 30)
  )
  const write: Step = {
    ents,
    run: (c) => {
      const items = written.map((n) => ({
        name: 'set',
        values: {
          key: segmentKey(c, namespace, n),
          value: JSON.stringify({ n, ns: namespace }),
          'jittered(ttlMs)': TTL_MS,
        },
      }))
      return c.each(WRITE, items)
    },
    repair: async (c) => {
      for (const n of written)
        await c.run(
          'SET',
          segmentKey(c, namespace, n),
          JSON.stringify({ n, ns: namespace }),
          'PX',
          TTL_MS
        )
    },
  }
  const read = (): Step => {
    const subset = rng.sample(
      Array.from({ length: SEGMENTS }, (_, n) => n),
      rng.int(2, 25)
    )
    return {
      ents,
      run: (c) =>
        c.multikey(
          READ,
          subset.map((n) => segmentKey(c, namespace, n)),
          subset.map((n) => ({ key: segmentKey(c, namespace, n) }))
        ),
    }
  }
  return [write, read(), read()]
}

export const usageSegmentCache: Driver = {
  name: 'usage-segment-cache',
  controls: false,
  client: 'ioredis',
  sites: [READ, WRITE],
  plan: (rng, ops, seed) => ({
    steps: episodes(ops, (i) => episode(rng, seed, i)),
    observe: async (c, namespace) =>
      allDone(
        Array.from({ length: SEGMENTS }, async (_, n) => {
          const key = segmentKey(c, namespace, n)
          return [await c.run('GET', key), await c.ttlState(key, TTL_MS * 2)]
        })
      ),
  }),
}
