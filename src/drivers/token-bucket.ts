import { allDone } from '../diff/settle.js'
import type { Ctx } from '../diff/ctx.js'
import type { Rng } from '../diff/rng.js'
import type { Driver, Selector, Step } from '../diff/types.js'
import { episodes, pairsToObject } from './kit.js'

const FILE = 'apps/sim/lib/core/rate-limiter/storage/redis-token-bucket.ts'
const CONSUME: Selector = { file: FILE, fn: 'consumeTokens' }
const ATOMIC: Selector = { file: FILE, fn: 'consumeTokensAtomically' }
const COOLDOWN: Selector = { file: FILE, fn: 'setCooldownUntil' }
const STATUS: Selector = { file: FILE, fn: 'getTokenStatus' }

/** Far in the future, so absolute expiry times stay valid whatever the real clock says. */
const NOW = 4_100_000_000_000
const SUFFIXES = ['requests', 'tokens', 'cooldown', 'quota']
const CONFIG = { maxTokens: 20, refillRate: 2, refillIntervalMs: 1000 }
const TTL_SECONDS = 3600

const bucketKey = (c: Ctx, key: string) => c.siteKey(CONSUME, 0, { key })

function episode(rng: Rng, seed: string, index: number): Step[] {
  const credential = `cred${seed}-${index}`
  const names = Object.fromEntries(SUFFIXES.map((s) => [s, `${credential}:${s}`])) as Record<
    string,
    string
  >
  const ents = [credential]
  let clock = NOW
  const tick = () => (clock += rng.int(100, 4000))
  const consume = (): Step => {
    const now = tick()
    const bucket = rng.pick(['requests', 'tokens'])
    const values = {
      key: names[bucket] as string,
      now,
      tokens: rng.int(1, 8),
      'config.maxTokens': CONFIG.maxTokens,
      'config.refillRate': CONFIG.refillRate,
      'config.refillIntervalMs': CONFIG.refillIntervalMs,
      ttl: TTL_SECONDS,
    }
    return { ents, run: (c) => c.eval(CONSUME, values) }
  }
  const status = (): Step => {
    const values = {
      key: names.requests as string,
      now: tick(),
      ...Object.fromEntries(Object.entries(CONFIG).map(([k, v]) => [`config.${k}`, v])),
    }
    return { ents, run: (c) => c.eval(STATUS, values) }
  }
  const cooldown = (): Step => {
    const until = tick() + rng.int(1000, 30_000)
    return {
      ents,
      run: (c) => c.eval(COOLDOWN, { key: names.cooldown as string, 'until.getTime()': until }),
    }
  }
  const clear: Step = {
    ents,
    run: async (c) => c.run('DEL', bucketKey(c, names.cooldown as string)),
  }
  const atomic = (): Step => {
    const now = tick()
    const reservations = ['requests', 'tokens'].map((s) => ({
      key: names[s] as string,
      cost: rng.int(1, 5),
    }))
    const gates = [names.cooldown as string, names.quota as string]
    return {
      ents,
      run: (c) => {
        const keys = [...gates, ...reservations.map((r) => r.key)].map((k) =>
          c.siteKey(ATOMIC, 0, { '*': k })
        )
        const args = [
          now,
          now + 1_000_000_000,
          gates.length,
          ...reservations.flatMap((r) => [
            r.cost,
            CONFIG.maxTokens,
            CONFIG.refillRate,
            CONFIG.refillIntervalMs,
          ]),
        ]
        return c.eval(ATOMIC, {}, { keys, args })
      },
    }
  }
  const extras = [cooldown(), status(), rng.chance(0.3) ? clear : status()]
  return [consume(), atomic(), rng.pick(extras), atomic()]
}

export const tokenBucket: Driver = {
  name: 'token-bucket',
  controls: false,
  client: 'ioredis',
  sites: [CONSUME, ATOMIC, COOLDOWN, STATUS],
  plan: (rng, ops, seed) => ({
    steps: episodes(ops, (i) => episode(rng, seed, i)),
    observe: async (c, credential) =>
      allDone(
        SUFFIXES.map(async (s) => {
          const key = bucketKey(c, `${credential}:${s}`)
          return [pairsToObject(await c.run('HGETALL', key)), await c.ttlState(key, 4e12)]
        })
      ),
  }),
}
