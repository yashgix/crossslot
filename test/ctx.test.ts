import { describe, expect, it } from 'vitest'
import type { Conn } from '../src/diff/conn.js'
import { Ctx, Side } from '../src/diff/ctx.js'
import { cleanup } from '../src/diff/run.js'
import type { OpSite, Scan } from '../src/scan/types.js'

function ctx(existing: string[] = [], ops: OpSite[] = []) {
  const sent: string[][] = []
  const conn = {
    run: async (cmd: string[]) => {
      sent.push(cmd)
      return cmd[0] === 'EXISTS' ? Number(existing.includes(cmd[1] as string)) : 'OK'
    },
  } as unknown as Conn
  const scan = { result: {}, sites: [], ops, helper: () => null } as unknown as Scan
  const side = new Side(scan, { loadScript: async () => 'sha' }, conn)
  return { c: new Ctx(side), side, sent }
}

const SEL = { file: 'f.ts', fn: 'read' }

describe('written keys', () => {
  it('rendering or reading a key does not mark it for deletion', async () => {
    const { c, side } = ctx()
    c.key('k:${id}', { id: 1 })
    await c.run('GET', 'k:1')
    expect(side.written.size).toBe(0)
  })

  it('records a key before the write, so a failed or partial write is still cleaned up', async () => {
    const { c, side } = ctx()
    const conn = side.conn as unknown as { run: (cmd: string[]) => Promise<unknown> }
    conn.run = async () => Promise.reject(new Error('boom'))
    await expect(c.run('SET', 'half', 'v')).rejects.toThrow('boom')
    expect([...side.written]).toEqual(['half'])
  })

  it('records every key of a batch even when one command fails', async () => {
    const { c, side } = ctx()
    await expect(
      c.writing(['a', 'b'], async () => {
        throw new Error('second command failed')
      })
    ).rejects.toThrow()
    expect([...side.written].sort()).toEqual(['a', 'b'])
  })
})

describe('shutdown', () => {
  it('no write happens after a failing batch has been reported', async () => {
    const op: OpSite = {
      id: 'f.ts:3',
      file: 'f.ts',
      line: 3,
      fn: 'read',
      command: 'set',
      args: ['${key}'],
      keys: null,
      guard: 'none',
    }
    const writes: string[] = []
    const { c, side } = ctx([], [op])
    const conn = side.conn as unknown as { run: (cmd: string[]) => Promise<unknown> }
    const base = conn.run
    conn.run = async (cmd) => {
      if (cmd[0] !== 'SET') return base(cmd)
      if (cmd[1] === 'bad') throw new Error('refused')
      await new Promise((r) => setTimeout(r, 30))
      writes.push(String(cmd[1]))
      return 'OK'
    }
    const items = ['bad', 'late'].map((key) => ({ name: 'set', values: { key } }))
    await expect(c.each(SEL, items)).rejects.toThrow('refused')
    const seen = writes.length
    await new Promise((r) => setTimeout(r, 60))
    expect(writes).toHaveLength(seen)
    expect(writes).toEqual(['late'])
  })
})

describe('guards around replacement calls', () => {
  it('reports a call under an unknown condition as unverifiable', async () => {
    const op: OpSite = {
      id: 'f.ts:3',
      file: 'f.ts',
      line: 3,
      fn: 'read',
      command: 'get',
      args: ['${key}'],
      keys: null,
      guard: 'unknown',
    }
    const { c } = ctx([], [op])
    await c.multikey(SEL, ['k'], [{ key: 'k' }])
    expect([...c.unverified]).toEqual(['f.ts:3'])
  })
})

describe('replacement operations come from the corpus', () => {
  it('a missing per-key call is a harness error, not a built-in command', async () => {
    const { c, sent } = ctx()
    await expect(c.multikey(SEL, ['a'], [{ key: 'a' }])).rejects.toThrow(/no get call/)
    await expect(c.each(SEL, [{ name: 'set', values: {} }])).rejects.toThrow(/no set call/)
    expect(sent).toEqual([])
  })

  it('replays the corpus call with its own arguments', async () => {
    const op: OpSite = {
      id: 'f.ts:3',
      file: 'f.ts',
      line: 3,
      fn: 'read',
      command: 'get',
      args: ['x:${key}'],
      keys: null,
      guard: 'none',
    }
    const { c, sent } = ctx([], [op])
    await c.multikey(SEL, ['k'], [{ key: 'k' }])
    expect(sent).toEqual([['GET', 'x:k']])
  })
})

describe('cleanup ownership', () => {
  it('deletes only recorded keys and leaves unrelated keys that contain the configuration id', async () => {
    const store = new Set(['mine:2f45765cx1', 'unrelated:invoice:2f45765cx1:keep'])
    const { c, side } = ctx()
    ;(side.conn as unknown as { run: (cmd: string[]) => Promise<unknown> }).run = async (cmd) => {
      if (cmd[0] === 'DEL') store.delete(cmd[1] as string)
      return 'OK'
    }
    await c.writing(['mine:2f45765cx1'], async () => undefined)
    await cleanup(side)
    expect([...store]).toEqual(['unrelated:invoice:2f45765cx1:keep'])
  })
})
