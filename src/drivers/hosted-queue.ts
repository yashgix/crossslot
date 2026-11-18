import { allDone } from '../diff/settle.js'
import type { Rng } from '../diff/rng.js'
import type { Driver, Selector, Step, Values } from '../diff/types.js'
import { overlapping } from './kit.js'

const FILE = 'apps/sim/lib/core/rate-limiter/hosted-key/queue.ts'
const ENQUEUE: Selector = { file: FILE, fn: 'enqueue' }
const CHECK_HEAD: Selector = { file: FILE, fn: 'checkHead' }
const REFRESH: Selector = { file: FILE, fn: 'refreshHeartbeat' }
const DEQUEUE: Selector = { file: FILE, fn: 'dequeue' }
const PROVIDERS = ['openai', 'anthropic', 'exa', 'firecrawl']

interface Queue {
  ent: string
  provider: string
  billingActorId: string
  tickets: string[]
}

const params = (q: Queue, ticketId: string): Values => ({
  provider: q.provider,
  billingActorId: q.billingActorId,
  ticketId,
})

function steps(rng: Rng, q: Queue, crash: boolean): Step[] {
  const on = (ticketId: string, run: Step['run'], repair?: Step['repair']): Step => ({
    ents: [q.ent, `${q.ent}/${ticketId}`],
    run,
    repair,
  })
  const pipelined = (sel: Selector) => (t: string) =>
    on(
      t,
      (c) => c.replay(sel, params(q, t)),
      (c) => c.replayEach(sel, params(q, t))
    )
  const enqueue = pipelined(ENQUEUE)
  const check = (t: string) => on(t, (c) => c.eval(CHECK_HEAD, params(q, t)))
  const refresh = pipelined(REFRESH)
  const dequeue = pipelined(DEQUEUE)
  const [head, second] = q.tickets as [string, string]
  const out: Step[] = q.tickets.map(enqueue)
  out.push(check(head), check(second), check('ghost'), refresh(second))
  if (crash) {
    out.push(
      on(head, async (c) => c.run('DEL', c.helperKey(FILE, 'heartbeatKey', params(q, head))))
    )
    out.push(check(second), check(second))
  }
  for (const t of rng.sample(q.tickets, q.tickets.length)) out.push(check(t), dequeue(t))
  return out
}

export const hostedQueue: Driver = {
  name: 'hosted-queue',
  controls: false,
  client: 'ioredis',
  sites: [ENQUEUE, CHECK_HEAD, REFRESH, DEQUEUE],
  plan: (rng, ops, seed) => {
    const queues = new Map<string, Queue>()
    const make = (i: number): Step[] => {
      const q: Queue = {
        ent: `q${seed}-${i}`,
        provider: rng.pick(PROVIDERS),
        billingActorId: `ws${seed}x${i}`,
        tickets: Array.from({ length: rng.int(2, 5) }, (_, n) => `ws${seed}x${i}-t${n}`),
      }
      queues.set(q.ent, q)
      return steps(rng, q, i === 0 || rng.chance(0.4))
    }
    return {
      steps: overlapping(rng, ops, 3, make),
      observe: async (c, ent) => {
        const q = queues.get(ent)
        if (!q) return null
        const list = await c.helperKey(FILE, 'queueListKey', params(q, ''))
        const heartbeats = await allDone(
          [...q.tickets, 'ghost'].map(async (t) =>
            c.run('EXISTS', c.helperKey(FILE, 'heartbeatKey', params(q, t)))
          )
        )
        return [await c.run('LRANGE', list, 0, -1), heartbeats]
      },
    }
  },
}
