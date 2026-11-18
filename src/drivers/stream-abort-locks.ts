import type { Ctx } from '../diff/ctx.js'
import type { Rng } from '../diff/rng.js'
import type { Driver, Selector, Step } from '../diff/types.js'
import { episodes } from './kit.js'

const FILE = 'apps/sim/lib/mothership/request/session/abort.ts'
const READ: Selector = { file: FILE, fn: 'getChatStreamLockOwners' }
const TTL_MS = 600_000

const lockKey = (c: Ctx, chatId: string) => c.helperKey(FILE, 'chatStreamLockKey', { chatId })

function episode(rng: Rng, seed: string, index: number): Step[] {
  const chats = Array.from({ length: rng.int(5, 50) }, (_, n) => `chat${seed}-${index}-${n}`)
  const owned = chats.filter(() => rng.chance(0.6))
  const set: Step = {
    ents: chats,
    run: async (c) => {
      for (const chat of owned)
        await c.run('SET', lockKey(c, chat), `owner-${chat}`, 'EX', TTL_MS / 1000)
    },
  }
  const read: Step = {
    ents: chats,
    run: (c) =>
      c.multikey(
        READ,
        chats.map((chat) => lockKey(c, chat)),
        chats.map((chat) => ({ chatId: chat, key: lockKey(c, chat) }))
      ),
  }
  const clear: Step = {
    ents: chats,
    run: async (c) => {
      for (const chat of owned.slice(0, 3)) await c.run('DEL', lockKey(c, chat))
    },
  }
  return [set, read, clear, read]
}

export const streamAbortLocks: Driver = {
  name: 'stream-abort-locks',
  controls: false,
  client: 'ioredis',
  sites: [READ],
  plan: (rng, ops, seed) => ({
    steps: episodes(ops, (i) => episode(rng, seed, i)),
    observe: async (c, chatId) => {
      const key = lockKey(c, chatId)
      return [await c.run('GET', key), await c.ttlState(key, TTL_MS)]
    },
  }),
}
