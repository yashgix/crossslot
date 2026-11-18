import type { Cluster, Redis } from 'ioredis'
import { getHostedKeyQueue } from '../data/sim/apps/sim/lib/core/rate-limiter/hosted-key/queue.ts'
import { check, header, ioCluster, ioStandalone, main, printSlots, simSource } from './common.ts'
import { logged } from './stubs/logger.ts'
import { setRedisClient } from './stubs/redis-config.ts'

const QUEUE = 'apps/sim/lib/core/rate-limiter/hosted-key/queue.ts'
const source = simSource(QUEUE)

/** Key formats at queue.ts:24-28. Fails loudly if Sim changes them. */
for (const template of [
  '`hosted-queue:${provider}:${billingActorId}`',
  '`hosted-queue-tkt:${provider}:${billingActorId}:${ticketId}`',
])
  if (!source.includes(template)) throw new Error(`Sim no longer builds ${template}`)
const listKey = (provider: string, actor: string) => `hosted-queue:${provider}:${actor}`
const heartbeatKey = (provider: string, actor: string, ticket: string) =>
  `hosted-queue-tkt:${provider}:${actor}:${ticket}`

// One workspace, one hosted provider, two callers waiting for the same hosted key.
const provider = 'exa'
const actor = 'ws_8c1f2a'
const tickets = ['tkt_a1', 'tkt_b2']

header('hosted-key queue: HostedKeyQueue.enqueue / checkHead / refreshHeartbeat / dequeue', [
  'queue.ts:98 enqueue, :138 checkHead, :166 refreshHeartbeat, :188 dequeue',
  "Sim's real module. Stubbed, none touching Redis: @sim/logger (prints warn lines),",
  '  @sim/utils/errors (toError), and @/lib/core/config/redis (getRedisClient returns the test client)',
])

/** Calls one Sim method and returns what it returned plus what Sim logged during the call. */
async function call(fn: () => Promise<unknown>): Promise<{ value: unknown; logs: string[] }> {
  const before = logged.length
  const value = await fn()
  return { value, logs: logged.slice(before) }
}

const SAME_SLOTS = 'same slots allocation group'
const NON_LOCAL = 'non local key in a cluster node script'

async function run(client: Redis | Cluster, cluster: boolean): Promise<void> {
  setRedisClient(client)
  const queue = getHostedKeyQueue()
  const [first, second] = tickets as [string, string]
  const enqueue = await call(() => queue.enqueue(provider, actor, first))
  await call(() => queue.enqueue(provider, actor, second))
  // Sim's enqueue fails on a cluster, so checkHead is a separately seeded reproduction: one
  // single-key RPUSH (valid on a cluster) puts a head in the list so checkHead's script runs.
  await client.rpush(listKey(provider, actor), first)
  const head = await call(() => queue.checkHead(provider, actor, first))
  const refresh = await call(() => queue.refreshHeartbeat(provider, actor, first))
  const dequeue = await call(() => queue.dequeue(provider, actor, first))
  const logs = (r: { logs: string[] }) => r.logs.join(' | ') || 'no warning'
  const failsWith = (r: { logs: string[] }, text: string) => r.logs.some((l) => l.includes(text))
  if (!cluster) {
    const clean = [enqueue, head, refresh, dequeue].every((r) => r.logs.length === 0)
    const enabled = (enqueue.value as { enabled: boolean }).enabled
    check(
      'standalone Redis 7100',
      clean && enabled && head.value === 'head',
      `enqueue ${JSON.stringify(enqueue.value)}, checkHead ${JSON.stringify(head.value)}, no warnings`
    )
    return
  }
  const cases: [string, { logs: string[] }, string][] = [
    ['cluster enqueue (:98)', enqueue, SAME_SLOTS],
    ['cluster checkHead (:138, seeded)', head, NON_LOCAL],
    ['cluster refreshHeartbeat (:166)', refresh, SAME_SLOTS],
    ['cluster dequeue (:188)', dequeue, SAME_SLOTS],
  ]
  for (const [name, result, text] of cases) check(name, failsWith(result, text), logs(result))
}

const standalone = ioStandalone()
const cluster = ioCluster()
const keys = [listKey(provider, actor), ...tickets.map((t) => heartbeatKey(provider, actor, t))]
await main(async () => {
  try {
    await printSlots(cluster, keys)
    await standalone.del(...keys)
    await run(standalone, false)
    await standalone.del(...keys)
    await run(cluster, true)
    await cluster.del(keys[0] as string)
  } finally {
    await standalone.del(...keys)
    standalone.disconnect()
    cluster.disconnect()
  }
})
