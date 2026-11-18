import { afterEach, describe, expect, it } from 'vitest'
import { Target } from '../src/diff/conn.js'
import { isSimFailure, isTransport } from '../src/diff/errors.js'
import { EXIT, ExitError } from '../src/errors.js'

describe('error classes', () => {
  it('tells a refusal from a lost connection', () => {
    expect(isSimFailure(new Error('CROSSSLOT Keys in request'))).toBe(true)
    expect(isSimFailure(new Error('connect ECONNREFUSED 127.0.0.1:7001'))).toBe(false)
    expect(isTransport(new Error('connect ECONNREFUSED 127.0.0.1:7001'))).toBe(true)
    expect(isTransport(new TypeError('x is undefined'))).toBe(false)
  })
})

describe('an unreachable node', () => {
  const saved = process.env.CROSSSLOT_STANDALONE_URL
  afterEach(() => {
    if (saved === undefined) delete process.env.CROSSSLOT_STANDALONE_URL
    else process.env.CROSSSLOT_STANDALONE_URL = saved
  })

  it('exits 4 within the deadline for a standalone node, for both client libraries', async () => {
    process.env.CROSSSLOT_STANDALONE_URL = 'redis://127.0.0.1:1'
    const target = Target.standalone(0)
    await expect(target.verify()).rejects.toMatchObject({ code: EXIT.docker })
    await expect(target.conn('node-redis')).rejects.toBeInstanceOf(ExitError)
    await target.close().catch(() => {})
  }, 30_000)
})
