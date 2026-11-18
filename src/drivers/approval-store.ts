import { allDone } from '../diff/settle.js'
import type { Rng } from '../diff/rng.js'
import type { Driver, Selector, Step, Values } from '../diff/types.js'
import { type Ctx } from '../diff/ctx.js'
import { episodes, sha256Hex } from './kit.js'

const FILE = 'apps/sim/lib/cli-auth/approval-store.ts'
const COMPLETE: Selector = { file: FILE, fn: 'completeApproval' }
const TTL_MS = 120_000

const params = (requestId: string): Values => ({
  requestId,
  'sha256Hex(requestId)': sha256Hex(requestId),
})
const approvalKey = (c: Ctx, requestId: string) =>
  c.helperKey(FILE, 'approvalKey', params(requestId))
const mintKey = (c: Ctx, requestId: string) => c.helperKey(FILE, 'mintLockKey', params(requestId))

function episode(rng: Rng, seed: string, index: number): Step[] {
  const requestId = `req${seed}-${index}`
  const ents = [requestId]
  const record = JSON.stringify({
    challenge: 'c',
    userId: `user-${requestId}`,
    scope: 'copilot',
    createdAt: 1700000000000,
  })
  const create: Step = {
    ents,
    run: (c) => c.run('SET', approvalKey(c, requestId), record, 'PX', TTL_MS),
  }
  const mint: Step = {
    ents,
    run: (c) => c.run('SET', mintKey(c, requestId), '1', 'PX', TTL_MS, 'NX'),
  }
  const complete: Step = {
    ents,
    run: (c) => c.multikeyAt(COMPLETE, params(requestId)),
    repair: async (c) => {
      await c.run('DEL', approvalKey(c, requestId))
      await c.run('DEL', mintKey(c, requestId))
    },
  }
  const release: Step = { ents, run: (c) => c.run('DEL', mintKey(c, requestId)) }
  return [create, mint, rng.chance(0.7) ? complete : release, rng.chance(0.5) ? complete : mint]
}

export const approvalStore: Driver = {
  name: 'approval-store',
  controls: false,
  client: 'ioredis',
  sites: [COMPLETE],
  plan: (rng, ops, seed) => ({
    steps: episodes(ops, (i) => episode(rng, seed, i)),
    observe: async (c, requestId) =>
      allDone(
        [approvalKey(c, requestId), mintKey(c, requestId)].map(async (k) => [
          await c.run('GET', k),
          await c.ttlState(k, TTL_MS),
        ])
      ),
  }),
}
