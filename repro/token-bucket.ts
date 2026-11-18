import type { Cluster, Redis } from 'ioredis'
import { RedisTokenBucket } from '../data/sim/apps/sim/lib/core/rate-limiter/storage/redis-token-bucket.ts'
import {
  check,
  header,
  ioCluster,
  ioStandalone,
  main,
  message,
  printSlots,
  simSource,
} from './common.ts'

const ADMISSION = 'apps/sim/lib/core/rate-limiter/provider-admission.ts'
const source = simSource(ADMISSION)

/** Evaluates the template literal that `providerKey` returns (provider-admission.ts:199-201). */
function providerKey(identity: Record<string, string>): string {
  const template = /function providerKey[^{]*\{\s*return `([^`]+)`/.exec(source)?.[1]
  if (!template) throw new Error('providerKey template not found')
  return template.replace(/\$\{identity\.(\w+)\}/g, (_, name: string) => identity[name] ?? '')
}

/** The four key suffixes Sim appends at provider-admission.ts:111, 121 and 152. */
function expectSuffixes(): void {
  for (const text of [
    '${bucketKey}:tokens',
    '${bucketKey}:requests',
    '${key}:cooldown',
    '${key}:quota',
  ])
    if (!source.includes('`' + text + '`')) throw new Error(`Sim no longer builds ${text}`)
}

expectSuffixes()
const key = providerKey({
  providerId: 'openai',
  credentialFingerprint: '3f9a1c2b7d40',
  operation: 'embedding',
})

// Embedding request, not bulk, 1500 input tokens, default budgets (provider-admission.ts:80-92, 41-43).
const reservations = [
  {
    key: `${key}:tokens`,
    cost: 1500,
    config: { maxTokens: 600_000, refillRate: 10_000, refillIntervalMs: 1000 },
  },
  {
    key: `${key}:requests`,
    cost: 1,
    config: { maxTokens: 64, refillRate: 10, refillIntervalMs: 1000 },
  },
]
const cooldownKeys = [`${key}:cooldown`, `${key}:quota`]
const stored = [...cooldownKeys, ...reservations.map((r) => r.key)].map((k) => `ratelimit:tb:${k}`)

header('token bucket: RedisTokenBucket.consumeTokensAtomically', [
  'redis-token-bucket.ts:166-187 (one EVAL over 4 keys), the real Sim class, no stubs',
  'keys built as provider-admission.ts:104-156 and prefixed at redis-token-bucket.ts:172-175',
])

async function attempt(client: Redis | Cluster) {
  try {
    const bucket = new RedisTokenBucket(client as Redis)
    return await bucket.consumeTokensAtomically(reservations, {
      cooldownKeys,
      deadlineAt: Date.now() + 60_000,
    })
  } catch (error) {
    return error
  }
}

const standalone = ioStandalone()
const cluster = ioCluster()
await main(async () => {
  try {
    await printSlots(cluster, stored)
    await standalone.del(...stored)
    const ok = await attempt(standalone)
    check(
      'standalone Redis 7100',
      !(ok instanceof Error) && ok.allowed === true,
      ok instanceof Error ? message(ok) : `allowed ${JSON.stringify(ok)}`
    )
    const refused = await attempt(cluster)
    check(
      'cluster 7001-7006',
      refused instanceof Error &&
        refused.name === 'ReplyError' &&
        /^CROSSSLOT /.test(refused.message),
      refused instanceof Error ? message(refused) : `unexpected success ${JSON.stringify(refused)}`
    )
  } finally {
    await standalone.del(...stored)
    standalone.disconnect()
    cluster.disconnect()
  }
})
