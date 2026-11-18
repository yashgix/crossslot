import type { Ctx } from '../diff/ctx.js'
import type { Rng } from '../diff/rng.js'
import type { Driver, Selector, Step, Values } from '../diff/types.js'
import { canonical, episodes, pairsToObject } from './kit.js'

const FILE = 'apps/sim/lib/webhooks/slack-stream-sessions.ts'
const REGISTER: Selector = { file: FILE, fn: 'registerSlackStreamSession' }
const UNREGISTER: Selector = { file: FILE, fn: 'unregisterSlackStreamSession' }
const TTL_MS = 86_400_000

function session(seed: string, index: number): Values {
  return {
    credentialId: `cred${seed}-${index}`,
    'target.channel': `C${index}`,
    'target.threadTs': `${seed}.${index}`,
  }
}

function episode(rng: Rng, seed: string, index: number): Step[] {
  const base = session(seed, index)
  const ents = [String(base.credentialId)]
  const executions = Array.from({ length: rng.int(2, 4) }, (_, n) => `exec${seed}-${index}-${n}`)
  const register = (executionId: string): Step => {
    const execution = { executionId, workflowId: 'wf', userId: 'u', workspaceId: 'ws' }
    const v = {
      ...base,
      'execution.executionId': executionId,
      'JSON.stringify(execution)': JSON.stringify(execution),
    }
    return { ents, run: (c) => c.replay(REGISTER, v), repair: (c) => c.replayEach(REGISTER, v) }
  }
  const unregister = (executionId: string): Step => ({
    ents: [...ents, executionId],
    run: (c) => c.eval(UNREGISTER, { ...base, executionId }),
  })
  return [...executions.map(register), ...rng.sample(executions, executions.length).map(unregister)]
}

export const slackStreamSessions: Driver = {
  name: 'slack-stream-sessions',
  controls: false,
  client: 'ioredis',
  sites: [REGISTER, UNREGISTER],
  plan: (rng, ops, seed) => ({
    steps: episodes(ops, (i) => episode(rng, seed, i)),
    observe: async (c: Ctx, credentialId) => {
      if (!credentialId.startsWith('cred')) return null
      const index = Number(credentialId.split('-')[1])
      const key = c.helperKey(FILE, 'getSessionKey', session(seed, index))
      const hash = pairsToObject(await c.run('HGETALL', key))
      return [canonical(hash), await c.run('EXISTS', key), await c.ttlState(key, TTL_MS)]
    },
  }),
}
