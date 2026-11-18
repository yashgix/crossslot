import type { Ctx } from '../diff/ctx.js'
import type { Rng } from '../diff/rng.js'
import type { Driver, Selector, Step, Values } from '../diff/types.js'
import { episodes, pairsToObject } from './kit.js'

const FILE = 'apps/realtime/src/handlers/file-doc-store.ts'
const sel = (script: string): Selector => ({ file: FILE, script })
const SEED = sel('SEED_IF_EMPTY_SCRIPT')
const APPEND = sel('APPEND_UPDATE_SCRIPT')
const APPEND_CLIENT = sel('APPEND_CLIENT_UPDATE_SCRIPT')
const ADOPT = sel('ADOPT_GENERATION_SCRIPT')
const INVALIDATE = sel('INVALIDATE_DOCUMENT_SCRIPT')
const RETIRE = sel('RETIRE_DOCUMENT_SCRIPT')
const VERSION = sel('SET_VERSION_IF_NEWER_SCRIPT')
const SNAPSHOT = sel('APPEND_SNAPSHOT_SCRIPT')
const REFRESH = sel('REFRESH_DOCUMENT_TTLS_SCRIPT')
const RELEASE = sel('RELEASE_LOCK_SCRIPT')
const SITES = [
  SEED,
  APPEND,
  APPEND_CLIENT,
  ADOPT,
  INVALIDATE,
  RETIRE,
  VERSION,
  SNAPSHOT,
  REFRESH,
  RELEASE,
]

const TTL_SECONDS = 600
/** Positions in the declared key lists, as the corpus orders them. */
const KEY = { stream: 0, generation: 1, syncver: 2, updates: 3 }

interface Doc {
  name: string
  generation: string
  next: string
}

function base(doc: Doc, n: number, generation: string): Values {
  return {
    name: doc.name,
    key: `ctl:seedlock:${doc.name}`,
    token: `token-${n}`,
    docId: generation,
    encoded: Buffer.from(`update-${doc.name}-${n}`).toString('base64'),
    snapshot: Buffer.from(`snapshot-${doc.name}-${n}`).toString('base64'),
    marker: n % 3 === 0 ? 'a' : '',
    expectedGeneration: generation,
    generation,
    retiredDocId: generation,
    replacementDocId: doc.next,
    upTo: '0',
    dedupeMember: `member-${doc.name}-${n}`,
    'String(STREAM_TTL_SEC)': TTL_SECONDS,
    'String(CLIENT_UPDATE_DEDUPE_CAPACITY)': 16384,
    'String(version)': 1000 + n,
    "strictGeneration ? '1' : '0'": n % 2,
    "editor?.userId ?? ''": 'user-1',
    "editor?.connectionId ?? ''": 'conn-1',
    "room.generation ?? ''": generation,
    "editCursor?.editor?.userId ?? ''": '',
    "editCursor?.editor?.connectionId ?? ''": '',
    "editCursor?.id ?? ''": '',
  }
}

/** Stream ids come from the server clock, so they are replaced by their order of appearance. */
function normalize(c: Ctx, name: string, reply: unknown): unknown {
  if (typeof reply === 'string' && /^\d+-\d+$/.test(reply))
    return `id#${c.side.ordinal(name, reply)}`
  return reply
}

function episode(rng: Rng, seed: string, index: number): Step[] {
  const name = `doc${seed}-${index}`
  const doc: Doc = { name, generation: `gen-${name}-1`, next: `gen-${name}-2` }
  const run = (script: Selector, v: Values): Step => ({
    ents: [name],
    run: async (c) => normalize(c, name, await c.eval(script, v)),
  })
  const stale = { ...base(doc, 0, 'stale-generation') }
  const menu = (n: number): Step[] => [
    run(APPEND, base(doc, n, doc.generation)),
    run(APPEND_CLIENT, base(doc, n, doc.generation)),
    run(ADOPT, base(doc, n, doc.generation)),
    run(VERSION, base(doc, n, doc.generation)),
    run(SNAPSHOT, base(doc, n, doc.generation)),
    run(REFRESH, base(doc, n, doc.generation)),
    run(INVALIDATE, base(doc, n, doc.next)),
    run(RETIRE, base(doc, n, doc.generation)),
    run(APPEND, { ...stale, name }),
    {
      ents: [name],
      run: async (c) => {
        const key = `ctl:seedlock:${name}`
        await c.run('SET', c.key('${key}', { key }), `token-${n}`, 'NX', 'PX', 30_000)
        return c.eval(RELEASE, base(doc, n, doc.generation))
      },
    },
  ]
  const start = rng.int(0, 9)
  const picks = [0, 1, 2].map((k) => menu(index + k)[(start + k * 3) % 10] as Step)
  return [run(SEED, base(doc, index, doc.generation)), ...picks]
}

export const fileDocStore: Driver = {
  name: 'file-doc-store',
  controls: false,
  client: 'node-redis',
  sites: SITES,
  plan: (rng, ops, seed) => ({
    steps: episodes(ops, (i) => episode(rng, seed, i)),
    observe: async (c, name) => {
      const v = { name }
      const key = (i: number) => c.siteKey(INVALIDATE, i, v)
      const entries = (await c.conn.run(['XRANGE', key(KEY.stream), '-', '+'])) as Array<
        [string, string[]]
      >
      const stream = entries.map(([id, fields]) => [
        c.side.ordinal(name, id),
        pairsToObject(fields),
      ])
      return [
        stream,
        await c.run('GET', key(KEY.generation)),
        await c.run('GET', key(KEY.syncver)),
        await c.run('ZRANGE', key(KEY.updates), 0, -1),
        await c.ttlState(key(KEY.stream), TTL_SECONDS * 1000),
        await c.ttlState(key(KEY.generation), TTL_SECONDS * 1000),
      ]
    },
  }),
}
