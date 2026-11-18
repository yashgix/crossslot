import type { Ctx } from '../diff/ctx.js'
import type { Rng } from '../diff/rng.js'
import type { Driver, Selector, Step } from '../diff/types.js'
import { episodes } from './kit.js'

const FILE = 'apps/sim/lib/core/outbox/retention.ts'
const READ: Selector = { file: FILE, fn: 'readPruneCursors' }
const WRITE: Selector = { file: FILE, fn: 'savePruneCursors' }
const TTL_MS = 3_600_000

const cursorKey = (c: Ctx, eventType: string) => c.helperKey(FILE, 'pruneCursorKey', { eventType })
const cursor = (eventType: string) =>
  JSON.stringify({ createdAt: '2026-01-01 00:00:00', id: eventType, passStartedAt: 1700000000000 })

function episode(rng: Rng, seed: string, index: number): Step[] {
  const types = Array.from({ length: rng.int(4, 12) }, (_, n) => `evt${seed}-${index}-${n}`)
  const read: Step = {
    ents: types,
    run: (c) =>
      c.multikey(
        READ,
        types.map((t) => cursorKey(c, t)),
        types.map((eventType) => ({ eventType }))
      ),
  }
  const writes = types.map((t) => ({ eventType: t, store: rng.chance(0.7) }))
  const write: Step = {
    ents: types,
    run: (c) => {
      const items = writes.map(({ eventType, store }) => ({
        name: store ? 'set' : 'del',
        values: { eventType, 'JSON.stringify(cursor)': cursor(eventType) },
      }))
      return c.each(WRITE, items)
    },
    repair: async (c) => {
      for (const { eventType, store } of writes) {
        const key = cursorKey(c, eventType)
        await (store ? c.run('SET', key, cursor(eventType), 'EX', 3600) : c.run('DEL', key))
      }
    },
  }
  return [read, write, read]
}

export const outboxPruneCursors: Driver = {
  name: 'outbox-prune-cursors',
  controls: false,
  client: 'ioredis',
  sites: [READ, WRITE],
  plan: (rng, ops, seed) => ({
    steps: episodes(ops, (i) => episode(rng, seed, i)),
    observe: async (c, eventType) => {
      const key = cursorKey(c, eventType)
      return [await c.run('GET', key), await c.ttlState(key, TTL_MS)]
    },
  }),
}
