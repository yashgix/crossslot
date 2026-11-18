import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cli, errorCodes, lineOf, scanCli, writeTree } from '../../helpers'

const HEAD = `import Redis from 'ioredis'\nconst redis = new Redis()\n`

function scanOne(source: string, extra: Record<string, string> = {}) {
  const root = writeTree({ 'a.ts': source, ...extra })
  const { run, result } = scanCli(root)
  expect(run.code).toBe(0)
  return { result, source, root }
}

describe('S-3 S-7 key patterns and the shared hash tag', () => {
  it('S-7 keys that all carry the same hash tag give no hazard', () => {
    const src = `${HEAD}const S = \`return redis.call('GET', KEYS[1]) .. redis.call('GET', KEYS[2])\`
export const f = (id: string) => redis.eval(S, 2, \`{u:\${id}}:a\`, \`{u:\${id}}:b\`)
`
    const { result } = scanOne(src)
    expect(result.sites).toHaveLength(1)
    const s = result.sites[0]
    expect(s).toMatchObject({ id: `a.ts:${lineOf(src, '.eval(')}`, kind: 'eval', keyCount: 2, resolved: true })
    expect(s.keyPatterns).toEqual(['{u:${id}}:a', '{u:${id}}:b'])
    expect(s.hazards).toEqual([])
    expect(s.scriptSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('S-7 different tags, or no tags, on two keys give CROSS_SLOT_KEYS', () => {
    const src = `${HEAD}const S = \`return redis.call('GET', KEYS[1]) .. redis.call('GET', KEYS[2])\`
export const f = () => redis.eval(S, 2, '{a}x', '{b}y')
export const g = (id: string) => redis.eval(S, 2, \`k:\${id}:a\`, \`k:\${id}:b\`)
`
    const { result } = scanOne(src)
    expect(result.sites).toHaveLength(2)
    for (const s of result.sites) expect(errorCodes(s)).toEqual(['CROSS_SLOT_KEYS'])
  })

  it('S-3 key helpers, property access on a const object and map spreads are resolved', () => {
    const src = `${HEAD}const K = { room: (id: string) => \`room:\${id}:users\`, sock: (id: string) => \`socket:\${id}:rooms\` } as const
const eventsKey = (id: string): string => \`events:\${id}\`
const S = \`return 1\`
export const f = (r: string, s: string) => redis.eval(S, 2, K.room(r), K.sock(s))
export const g = (ids: string[]) => redis.eval(S, ids.length, ...ids.map(eventsKey))
`
    const { result } = scanOne(src)
    const [f, g] = result.sites
    expect(f.keyPatterns).toEqual(['room:${r}:users', 'socket:${s}:rooms'])
    expect(f.hazards.map((h: any) => h.code)).toContain('CROSS_SLOT_KEYS')
    expect(g.keyCount).toBe('dynamic')
    expect(g.keyPatterns).toEqual(['events:${*}'])
    expect(errorCodes(g)).toEqual(['CROSS_SLOT_KEYS'])
  })

  it('S-3 node-redis { keys, arguments } calls are read', () => {
    const src = `import { createClient } from 'redis'
const client = createClient()
const S = \`return redis.call('GET', KEYS[1]) .. redis.call('GET', KEYS[2])\`
export const f = (a: string, b: string) => client.eval(S, { keys: [\`x:\${a}\`, \`y:\${b}\`], arguments: ['1'] })
export const g = (a: string) => client.evalSha('abc', { keys: [\`{t:\${a}}:x\`, \`{t:\${a}}:y\`], arguments: [] })
`
    const { result } = scanOne(src)
    const [f, g] = result.sites
    expect(f).toMatchObject({ kind: 'eval', client: 'node-redis', keyCount: 2 })
    expect(errorCodes(f)).toEqual(['CROSS_SLOT_KEYS'])
    expect(g).toMatchObject({ kind: 'evalsha', keyCount: 2 })
    expect(g.hazards.filter((h: any) => h.code === 'CROSS_SLOT_KEYS')).toEqual([])
  })

  it('S-3 keys of a multi are the first argument of every command chained or called on its variable', () => {
    const src = `${HEAD}export async function chained(a: string, b: string) {
  await redis.multi().set(\`k:\${a}\`, '1').set(\`k:\${b}\`, '1').exec()
}
export async function viaVariable(a: string) {
  const p = redis.multi()
  p.rpush(\`{q:\${a}}:list\`, 'x')
  p.expire(\`{q:\${a}}:list\`, 5)
  p.set(\`{q:\${a}}:tkt\`, '1')
  await p.exec()
}
export async function pipe(a: string, b: string) {
  const p = redis.pipeline()
  p.set(\`s:\${a}\`, '1')
  p.set(\`s:\${b}\`, '1')
  await p.exec()
}
`
    const { result } = scanOne(src)
    const [chained, viaVariable, pipe] = result.sites
    expect(chained.kind).toBe('multi')
    expect(errorCodes(chained)).toEqual(['CROSS_SLOT_KEYS'])
    expect(viaVariable.kind).toBe('multi')
    expect(viaVariable.hazards).toEqual([])
    expect(pipe.kind).toBe('pipeline')
    expect(errorCodes(pipe)).toEqual(['CROSS_SLOT_KEYS'])
  })
})

describe('S-3 caller bindings decide tag equality', () => {
  const body = `${HEAD}const tagged = (id: string) => \`{u:\${id}}:x\`
const plain = (id: string) => \`p:\${id}\`
const S = \`return 1\`
export const sameArg = (a: string) => redis.eval(S, 2, tagged(a), \`{u:\${a}}:y\`)
export const otherArg = (a: string, b: string) => redis.eval(S, 2, tagged(a), tagged(b))
export const sameHelper = (a: string, b: string) => redis.eval(S, 2, plain(a), plain(b))
export const listTags = (ids: string[]) => redis.eval(S, ids.length, ...ids.map(tagged))
`

  it('S-3 the same helper with different arguments is not one tag', () => {
    const { result } = scanOne(body)
    const [sameArg, otherArg, sameHelper, listTags] = result.sites
    expect(sameArg.keyPatterns).toEqual(['{u:${a}}:x', '{u:${a}}:y'])
    expect(sameArg.hazards).toEqual([])
    expect(otherArg.keyPatterns).toEqual(['{u:${a}}:x', '{u:${b}}:x'])
    expect(errorCodes(otherArg)).toEqual(['CROSS_SLOT_KEYS'])
    expect(errorCodes(sameHelper)).toEqual(['CROSS_SLOT_KEYS'])
    expect(errorCodes(listTags)).toEqual(['CROSS_SLOT_KEYS'])
  })
})

describe('S-6 xread', () => {
  it('S-6 node-redis xRead over several streams is a multikey site, over one stream it is not', () => {
    const src = `import { createClient } from 'redis'
const client = createClient()
const streamKey = (name: string) => \`stream:\${name}\`
export const many = (a: string, b: string) => client.xRead([{ key: streamKey(a), id: '0' }, { key: streamKey(b), id: '0' }], { COUNT: 1 })
export const batch = (names: string[]) => client.xRead(names.map((n) => ({ key: streamKey(n), id: '0' })))
export const one = (a: string) => client.xRead([{ key: streamKey(a), id: '0' }])
`
    const { result } = scanOne(src)
    expect(result.sites.map((s: any) => [s.kind, s.command])).toEqual([['multikey', 'xread'], ['multikey', 'xread']])
    for (const s of result.sites) expect(errorCodes(s)).toEqual(['CROSS_SLOT_KEYS'])
  })
})

describe('S-4 UNDECLARED_KEY', () => {
  const script = (body: string) => `${HEAD}const S = \`${body}\`\n`

  it('S-4 a key built from ARGV inside the script is UNDECLARED_KEY with severity error', () => {
    const src =
      script(`local head = redis.call('lindex', KEYS[1], 0)
if redis.call('exists', ARGV[1] .. head) == 0 then return 0 end
return 1`) + `export const f = (id: string) => redis.eval(S, 1, \`q:\${id}\`, 'tkt:' + id + ':')\n`
    const { result } = scanOne(src)
    expect(result.sites).toHaveLength(1)
    expect(errorCodes(result.sites[0])).toEqual(['UNDECLARED_KEY'])
  })

  it('S-4 a local assigned directly from KEYS[i] is declared', () => {
    const src =
      script(`local k = KEYS[1]
return redis.call('get', k)`) + `export const f = (id: string) => redis.eval(S, 1, \`q:\${id}\`)\n`
    expect(scanOne(src).result.sites[0].hazards).toEqual([])
  })

  it('S-4 the hazard is info when the declared key and the ARGV prefix carry the same hash tag', () => {
    const src =
      script(`local head = redis.call('lindex', KEYS[1], 0)
return redis.call('exists', ARGV[1] .. head)`) +
      `export const f = (id: string) => redis.eval(S, 1, \`{q:\${id}}:list\`, \`{q:\${id}}:tkt:\`)\n`
    const hazards = scanOne(src).result.sites[0].hazards
    expect(hazards).toHaveLength(1)
    expect(hazards[0]).toMatchObject({ code: 'UNDECLARED_KEY', severity: 'info' })
  })

  it('S-4 commands that take no key (TIME, PUBLISH channel, PING) are not flagged', () => {
    const src =
      script(`local t = redis.call('TIME')
redis.call('PING')
return redis.call('get', KEYS[1])`) + `export const f = () => redis.eval(S, 1, 'k')\n`
    expect(scanOne(src).result.sites[0].hazards).toEqual([])
  })
})

describe('S-2 script resolution and S-7 failure handling', () => {
  it('S-2 an unresolvable script is UNRESOLVED (info), resolved false, and still a site', () => {
    const src = `${HEAD}declare function loadScript(): string
export const f = () => redis.eval(loadScript(), 1, 'k')\n`
    const s = scanOne(src).result.sites[0]
    expect(s.resolved).toBe(false)
    expect(s.scriptSha256).toBeNull()
    expect(s.hazards.map((h: any) => [h.code, h.severity])).toContainEqual(['UNRESOLVED', 'info'])
  })

  it('S-2 ${CONST} interpolation, including one cross-file import, is resolved', () => {
    const files = {
      'frag.ts': "export const FRAGMENT = `redis.call('SET', KEYS[1], ARGV[1])`\n",
    }
    const src = `import { FRAGMENT } from './frag'
${HEAD}const LOCAL = 'return 1'
const S = \`\${FRAGMENT}
\${LOCAL}\`
export const f = () => redis.eval(S, 1, 'k', 'v')\n`
    const { result } = scanOne(src, files)
    const s = result.sites[0]
    expect(s.resolved).toBe(true)
    expect(s.scriptSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('S-7 a file that does not parse is counted and does not abort the scan', () => {
    const src = `${HEAD}export const f = () => redis.eval('return 1', 0)\n`
    const { result } = scanOne(src, { 'broken.ts': 'export const = = (\n' })
    expect(result.filesScanned).toBe(2)
    expect(result.sites).toHaveLength(1)
  })

  it('S-1 a file with no Redis call gives zero sites', () => {
    const { result } = scanOne('export const x = 1\n')
    expect(result.sites).toEqual([])
    expect(result.summary).toMatchObject({ sites: 0, errors: 0 })
  })
})

describe('S-6 multikey commands', () => {
  it('S-6 one plain key is not a site, two keys or a spread or an array is', () => {
    const src = `${HEAD}export async function f(ids: string[]) {
  await redis.del('a')
  await redis.del('a', 'b')
  await redis.del('{t}a', '{t}b')
  await redis.mget(...ids)
  await redis.mget(ids)
  await redis.get('a')
}
`
    const { result } = scanOne(src)
    expect(result.sites.map((s: any) => [s.line, s.kind, s.command])).toEqual([
      [lineOf(src, "del('a', 'b')"), 'multikey', 'del'],
      [lineOf(src, "del('{t}a'"), 'multikey', 'del'],
      [lineOf(src, 'mget(...ids)'), 'multikey', 'mget'],
      [lineOf(src, 'mget(ids)'), 'multikey', 'mget'],
    ])
    const [plain, tagged, spread, array] = result.sites
    expect(errorCodes(plain)).toEqual(['CROSS_SLOT_KEYS'])
    expect(tagged.hazards).toEqual([])
    expect(errorCodes(spread)).toEqual(['CROSS_SLOT_KEYS'])
    expect(errorCodes(array)).toEqual(['CROSS_SLOT_KEYS'])
  })
})

describe('S-8 S-9 CLI behaviour', () => {
  const bad = `${HEAD}export const f = () => redis.eval('return 1', 2, 'a', 'b')\n`
  const good = `${HEAD}export const f = () => redis.eval('return 1', 1, 'a')\n`

  it('S-8 --fail-on-error exits 1 with an error hazard and 0 without', () => {
    const run = (src: string, flag: string[]) => scanCli(writeTree({ 'a.ts': src }), flag).run
    expect(run(bad, ['--fail-on-error']).code).toBe(1)
    expect(run(bad, []).code).toBe(0)
    expect(run(good, ['--fail-on-error']).code).toBe(0)
  })

  it('S-8 the first stdout line is the summary', () => {
    const { run } = scanCli(writeTree({ 'a.ts': bad }))
    expect(run.stdout.split('\n')[0]).toBe('sites=1 errors=1 unresolved=0 files=1')
  })

  it('S-9 the same input gives byte-identical JSON', () => {
    const root = writeTree({ 'a.ts': bad, 'b.ts': good })
    const a = scanCli(root)
    const b = scanCli(root)
    expect(readFileSync(a.json, 'utf8')).toBe(readFileSync(b.json, 'utf8'))
    expect(a.result.sites.map((s: any) => s.file)).toEqual(['a.ts', 'b.ts'])
  })

  it('S-8 a missing root is a usage error', () => {
    expect(cli(['scan', '--root', '/nonexistent-crossslot-dir', '--json', '/tmp/x.json']).code).toBe(2)
    expect(cli(['scan']).code).toBe(2)
  })
})
