import type { Rng } from '../diff/rng.js'
import type { Driver, Selector, Step } from '../diff/types.js'
import { episodes } from './kit.js'

const FILE = 'apps/sim/lib/core/config/redis.ts'
const RELEASE: Selector = { file: FILE, fn: 'releaseLock' }
const EXTEND: Selector = { file: FILE, fn: 'extendLock' }
const TTL_SECONDS = 600

function episode(rng: Rng, seed: string, index: number): Step[] {
  const lockKey = `ctl:lock:${seed}:${index}`
  const ents = [lockKey]
  const acquire: Step = {
    ents,
    run: async (c) =>
      c.run('SET', c.siteKey(RELEASE, 0, { lockKey }), 'owner', 'NX', 'EX', TTL_SECONDS),
  }
  const token = () => (rng.chance(0.5) ? 'owner' : 'intruder')
  const release = (value: string): Step => ({
    ents,
    run: (c) => c.eval(RELEASE, { lockKey, value }),
  })
  const extend = (value: string): Step => ({
    ents,
    run: (c) => c.eval(EXTEND, { lockKey, value, expirySeconds: TTL_SECONDS }),
  })
  const middle = Array.from({ length: 2 }, () =>
    rng.chance(0.5) ? extend(token()) : release(token())
  )
  return [acquire, ...middle, release('owner')]
}

export const lock: Driver = {
  name: 'lock',
  controls: true,
  client: 'ioredis',
  sites: [RELEASE, EXTEND],
  plan: (rng, ops, seed) => ({
    steps: episodes(ops, (i) => episode(rng, seed, i)),
    observe: async (c, lockKey) => {
      const key = c.siteKey(RELEASE, 0, { lockKey })
      return [await c.run('GET', key), await c.ttlState(key, TTL_SECONDS * 1000)]
    },
  }),
}
