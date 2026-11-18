import { describe, expect, it } from 'vitest'
import { allDone } from '../src/diff/settle.js'

describe('allDone', () => {
  it('waits for the slow task before it rethrows the fast failure', async () => {
    let finished = false
    const slow = new Promise<void>((resolve) =>
      setTimeout(() => {
        finished = true
        resolve()
      }, 30)
    )
    await expect(allDone([Promise.reject(new Error('boom')), slow])).rejects.toThrow('boom')
    expect(finished).toBe(true)
  })

  it('returns the values in order', async () => {
    expect(await allDone([Promise.resolve(1), Promise.resolve(2)])).toEqual([1, 2])
  })
})
