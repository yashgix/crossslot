import type { Ctx } from '../diff/ctx.js'
import type { Rng } from '../diff/rng.js'
import type { Driver, Selector, Step } from '../diff/types.js'
import { episodes, pairsToObject } from './kit.js'

const FILE = 'apps/realtime/src/handlers/file-doc-store.ts'
const READ: Selector = { file: FILE, fn: 'runReader', kind: 'multikey' }
const TTL_MS = 600_000

const streamKey = (c: Ctx, name: string) => c.helperKey(FILE, 'streamKey', { name })
const cursor = (c: Ctx, name: string) => (c.side.memory.get(name) as string | undefined) ?? '0'

function appendTo(name: string, n: number): Step {
  return {
    ents: [name],
    run: (c) => c.run('XADD', streamKey(c, name), '*', 'u', `payload-${name}-${n}`).then(() => n),
  }
}

const MAX_ROUNDS = 60

/**
 * Reads the documents until nothing is left. How many streams one call covers differs between a
 * corpus that reads a batch and one that reads each stream, so the comparison is of what was drained.
 */
function readBatch(rng: Rng, docs: string[]): Step {
  const names = rng.sample(docs, rng.int(2, 8))
  return {
    ents: names,
    run: async (c) => {
      const drained: Record<string, unknown[]> = {}
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const reads = await c.streamReads(READ, names, {
          get: (n) => cursor(c, n),
          set: (n, id) => c.side.memory.set(n, id),
        })
        let any = false
        for (const { name, entries } of reads) {
          for (const e of entries) {
            any = true
            const list = (drained[name] ??= [])
            list.push([c.side.ordinal(name, e.id), pairsToObject(e.fields.flat())])
          }
        }
        if (!any) break
      }
      return Object.fromEntries(Object.entries(drained).sort(([a], [b]) => (a < b ? -1 : 1)))
    },
  }
}

export const fileDocReader: Driver = {
  name: 'file-doc-reader',
  controls: false,
  client: 'node-redis',
  sites: [READ],
  plan: (rng, ops, seed) => {
    const docs = Array.from(
      { length: Math.max(24, Math.ceil(ops / 4)) },
      (_, i) => `rdoc${seed}-${i}`
    )
    const steps = episodes(ops, (i) => {
      const doc = rng.pick(docs)
      return [
        appendTo(doc, i),
        appendTo(rng.pick(docs), i),
        readBatch(rng, docs),
        readBatch(rng, docs),
      ]
    })
    return {
      steps,
      observe: async (c, name) => {
        const entries = (await c.conn.run(['XRANGE', streamKey(c, name), '-', '+'])) as Array<
          [string, string[]]
        >
        const last = c.side.memory.get(name) as string | undefined
        return [
          entries.map(([id, f]) => [c.side.ordinal(name, id), pairsToObject(f)]),
          last ? c.side.ordinal(name, last) : null,
          await c.ttlState(streamKey(c, name), TTL_MS),
        ]
      },
    }
  },
}
