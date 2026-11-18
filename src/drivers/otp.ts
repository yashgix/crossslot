import type { Rng } from '../diff/rng.js'
import type { Driver, Selector, Step } from '../diff/types.js'
import { episodes } from './kit.js'

const FILE = 'apps/sim/lib/core/security/otp.ts'
const RESERVE: Selector = { file: FILE, fn: 'reserveOTPAttempt' }
const CONSUME: Selector = { file: FILE, fn: 'consumeOTP' }
const TTL_MS = 600_000
const CODE = '123456'

function episode(rng: Rng, seed: string, index: number): Step[] {
  const key = `ctl:otp:${seed}:${index}`
  const ents = [key]
  const store: Step = {
    ents,
    run: async (c) => c.run('SET', c.siteKey(RESERVE, 0, { key }), `${CODE}:0`, 'PX', TTL_MS),
  }
  const reserve: Step = { ents, run: (c) => c.eval(RESERVE, { key }) }
  /** Spends every attempt the corpus allows, then one more that must be refused. */
  const exhaust: Step = {
    ents,
    run: async (c) => {
      const limit = Number(c.siteArg(RESERVE, 0, { key }))
      const replies: unknown[] = []
      for (let i = 0; i <= limit; i++) replies.push(await c.eval(RESERVE, { key }))
      return replies
    },
  }
  const consume = (otp: string): Step => ({ ents, run: (c) => c.eval(CONSUME, { key, otp }) })
  const middle = rng.chance(0.6) ? exhaust : reserve
  return [store, middle, consume(rng.chance(0.5) ? CODE : '000000'), consume(CODE)]
}

export const otp: Driver = {
  name: 'otp',
  controls: true,
  client: 'ioredis',
  sites: [RESERVE, CONSUME],
  plan: (rng, ops, seed) => ({
    steps: episodes(ops, (i) => episode(rng, seed, i)),
    observe: async (c, key) => {
      const k = c.siteKey(RESERVE, 0, { key })
      return [await c.run('GET', k), await c.ttlState(k, TTL_MS)]
    },
  }),
}
