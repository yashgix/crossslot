import { describe, expect, it } from 'vitest'
import { undeclaredCalls } from '../src/scan/lua.js'

describe('undeclaredCalls', () => {
  it('accepts KEYS, locals from KEYS and loops over KEYS', () => {
    const script = `local k = KEYS[1]
redis.call('get', k)
redis.call("del", KEYS[2], KEYS[3])
for _, key in ipairs(KEYS) do redis.call('expire', key, ARGV[1]) end`
    expect(undeclaredCalls(script)).toEqual([])
  })

  it('reports a key built from ARGV with the index that feeds it', () => {
    expect(undeclaredCalls(`redis.call('exists', ARGV[1] .. head)`)).toEqual([
      { command: 'exists', argv: [1] },
    ])
  })

  it('ignores commands without keys and keys named in comments or strings', () => {
    const script = `-- redis.call('get', 'x')
redis.call('TIME')
redis.call('publish', 'channel', ARGV[1])
return "redis.call('get', 'y')"`
    expect(undeclaredCalls(script)).toEqual([])
  })

  it('checks every key of a multi-key command', () => {
    expect(undeclaredCalls(`redis.call('del', KEYS[1], 'other')`)).toEqual([
      { command: 'del', argv: [] },
    ])
  })
})

describe('undeclaredCalls, strict KEYS handling', () => {
  it('does not accept KEYS[1] joined with something else', () => {
    expect(undeclaredCalls(`redis.call('get', KEYS[1] .. ARGV[1])`)).toEqual([
      { command: 'get', argv: [1] },
    ])
  })

  it('stops trusting a local that is reassigned', () => {
    const script = `local k = KEYS[1]
k = ARGV[1]
redis.call('get', k)`
    expect(undeclaredCalls(script)).toHaveLength(1)
  })

  it('does not trust a multiple assignment', () => {
    const script = `local a, b = KEYS[1], ARGV[1]
redis.call('get', b)`
    expect(undeclaredCalls(script)).toHaveLength(1)
  })

  it('still trusts a local used in a comparison', () => {
    const script = `local k = KEYS[1]
if k == 'x' then return 0 end
return redis.call('get', k)`
    expect(undeclaredCalls(script)).toEqual([])
  })
})

describe('undeclaredCalls, shadowing', () => {
  it('does not trust a local that a function parameter shadows', () => {
    const script = `local k = KEYS[1]
local function f(k) return redis.call('get', k) end
return f(ARGV[1])`
    expect(undeclaredCalls(script)).toHaveLength(1)
  })

  it('does not trust a name reused as a loop variable', () => {
    const script = `local k = KEYS[1]
for _, k in ipairs(ARGV) do redis.call('get', k) end`
    expect(undeclaredCalls(script)).toHaveLength(1)
  })
})

describe('undeclaredCalls, a parameter named KEYS', () => {
  it('does not trust a loop over a shadowing KEYS parameter', () => {
    const script = `local function f(KEYS) for _, k in ipairs(KEYS) do redis.call('get', k) end end
f(ARGV)`
    expect(undeclaredCalls(script)).toHaveLength(1)
  })

  it('still trusts a loop over the top-level KEYS', () => {
    const script = `for _, k in ipairs(KEYS) do redis.call('get', k) end`
    expect(undeclaredCalls(script)).toEqual([])
  })

  it('does not count KEYS[1] inside a function that takes KEYS as a parameter', () => {
    const script = `local function f(KEYS)
  return redis.call('get', KEYS[1])
end
return f(ARGV)`
    expect(undeclaredCalls(script)).toHaveLength(1)
  })

  it('still counts KEYS[1] after that function ends', () => {
    const script = `local function f(KEYS) return KEYS end
return redis.call('get', KEYS[1])`
    expect(undeclaredCalls(script)).toEqual([])
  })
})
