import { describe, expect, it } from 'vitest'
import type { Conn } from '../src/diff/conn.js'
import { withRunLock } from '../src/diff/lock.js'

/** Just enough Redis for the lock: SET NX PX and the compare-and-delete or renew scripts. */
function fakeRedis(): Conn {
  const store = new Map<string, string>()
  return {
    run: async (cmd: string[]) => {
      if (store.has(cmd[1] as string)) return null
      store.set(cmd[1] as string, cmd[2] as string)
      return 'OK'
    },
    eval: async (script: string, keys: string[], args: string[]) => {
      if (store.get(keys[0] as string) !== args[0]) return 0
      if (script.includes('del')) store.delete(keys[0] as string)
      return 1
    },
  } as unknown as Conn
}

describe('withRunLock', () => {
  it('lets a second run start only after the first has finished', async () => {
    const conn = fakeRedis()
    const order: string[] = []
    const first = withRunLock(conn, async () => {
      order.push('first start')
      await new Promise((r) => setTimeout(r, 700))
      order.push('first end')
    })
    await new Promise((r) => setTimeout(r, 50))
    const second = withRunLock(conn, async () => void order.push('second start'))
    await Promise.all([first, second])
    expect(order).toEqual(['first start', 'first end', 'second start'])
  })

  it('gives up with a clear error when the other run never finishes', async () => {
    const conn = fakeRedis()
    const held = withRunLock(conn, () => new Promise((r) => setTimeout(r, 1500)))
    await new Promise((r) => setTimeout(r, 50))
    await expect(withRunLock(conn, async () => 1, { waitMs: 600 })).rejects.toThrow(
      /another crossslot run/
    )
    await held
  })
})

describe('lease loss', () => {
  it('flags the lease lost when a renewal finds it taken, and fails the run', async () => {
    const conn = fakeRedis()
    const base = conn.eval
    conn.eval = async (script, keys, args) =>
      script.includes('pexpire') ? 0 : base(script, keys, args)
    let sawLost = false
    const run = withRunLock(
      conn,
      async (lease) => {
        await new Promise((r) => setTimeout(r, 150))
        sawLost = lease.lost
      },
      { leaseMs: 60 }
    )
    await expect(run).rejects.toThrow(/lost its lease/)
    expect(sawLost).toBe(true)
  })

  it('flags the lease lost when a renewal throws', async () => {
    const conn = fakeRedis()
    const base = conn.eval
    conn.eval = async (script, keys, args) => {
      if (script.includes('pexpire')) throw new Error('ECONNRESET')
      return base(script, keys, args)
    }
    const run = withRunLock(conn, () => new Promise((r) => setTimeout(r, 150)), { leaseMs: 60 })
    await expect(run).rejects.toThrow(/lost its lease/)
  })
})
