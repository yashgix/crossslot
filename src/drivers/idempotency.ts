import type { Rng } from '../diff/rng.js'
import type { Driver, Selector, Step } from '../diff/types.js'
import { episodes } from './kit.js'

const FILE = 'apps/sim/lib/core/idempotency/service.ts'
const CLAIM: Selector = { file: FILE, script: 'CLAIM_REDIS_LEASE_SCRIPT' }
const STORE: Selector = { file: FILE, script: 'STORE_REDIS_RESULT_IF_OWNER_SCRIPT' }
const DELETE_OWNER: Selector = { file: FILE, script: 'DELETE_REDIS_RESULT_IF_OWNER_SCRIPT' }
const DELETE_VALUE: Selector = { file: FILE, script: 'DELETE_REDIS_RESULT_IF_VALUE_SCRIPT' }
const TTL_SECONDS = 600

const inProgress = (claimToken: string) => JSON.stringify({ claimToken, status: 'in_progress' })
const stored = (claimToken: string) => JSON.stringify({ claimToken, status: 'done', body: 'ok' })

function episode(rng: Rng, seed: string, index: number): Step[] {
  const normalizedKey = `ctl:idem:${seed}:${index}`
  const ents = [normalizedKey]
  const token = () => (rng.chance(0.6) ? 'owner' : 'other')
  const claim = (claimToken: string): Step => ({
    ents,
    run: (c) =>
      c.eval(CLAIM, {
        normalizedKey,
        'JSON.stringify(inProgressResult)': inProgress(claimToken),
        inProgressTtlSeconds: TTL_SECONDS,
      }),
  })
  const store = (claimToken: string): Step => ({
    ents,
    run: (c) =>
      c.eval(STORE, {
        normalizedKey,
        claimToken,
        'this.config.ttlSeconds': TTL_SECONDS,
        'JSON.stringify(storedResult)': stored(claimToken),
      }),
  })
  const deleteOwner = (claimToken: string): Step => ({
    ents,
    run: (c) => c.eval(DELETE_OWNER, { normalizedKey, 'fence.claimToken': claimToken }),
  })
  const deleteValue = (value: string): Step => ({
    ents,
    run: (c) => c.eval(DELETE_VALUE, { normalizedKey, 'fence.observedValue': value }),
  })
  const tail = rng.chance(0.5)
    ? deleteValue(rng.chance(0.5) ? stored('owner') : inProgress('owner'))
    : deleteOwner(token())
  return [
    claim('owner'),
    rng.chance(0.5) ? claim('other') : store(token()),
    tail,
    deleteOwner(token()),
  ]
}

export const idempotency: Driver = {
  name: 'idempotency',
  controls: true,
  client: 'ioredis',
  sites: [CLAIM, STORE, DELETE_OWNER, DELETE_VALUE],
  plan: (rng, ops, seed) => ({
    steps: episodes(ops, (i) => episode(rng, seed, i)),
    observe: async (c, normalizedKey) => {
      const key = c.siteKey(CLAIM, 0, { normalizedKey })
      return [await c.run('GET', key), await c.ttlState(key, TTL_SECONDS * 1000)]
    },
  }),
}
