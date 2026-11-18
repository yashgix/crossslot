/** Finds key arguments in a Lua script that are not declared through KEYS. */

interface Token {
  kind: 'id' | 'str' | 'num' | 'op'
  text: string
}

export interface UndeclaredCall {
  command: string
  /** ARGV indices (1-based) that feed the undeclared key expression. */
  argv: number[]
}

const NO_KEY = new Set(
  'time ping publish spublish eval evalsha script select info echo randomkey dbsize scan keys config client command cluster auth acl function xread xreadgroup'.split(
    ' '
  )
)
const ALL_KEYS = new Set(
  'del unlink exists mget sunion sinter sdiff sunionstore sinterstore sdiffstore rename renamenx rpoplpush pfmerge pfcount watch touch'.split(
    ' '
  )
)
const FIRST_TWO = new Set(['smove', 'lmove', 'blmove'])

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i] as string
    if (/\s/.test(c)) i++
    else if (src.startsWith('--', i)) i = skipComment(src, i)
    else if (c === '"' || c === "'") {
      let j = i + 1
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1
      out.push({ kind: 'str', text: src.slice(i + 1, j) })
      i = j + 1
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)) as RegExpExecArray
      out.push({ kind: 'id', text: m[0] })
      i += m[0].length
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9][0-9.]*/.exec(src.slice(i)) as RegExpExecArray
      out.push({ kind: 'num', text: m[0] })
      i += m[0].length
    } else if (src.startsWith('..', i)) {
      out.push({ kind: 'op', text: '..' })
      i += 2
    } else {
      out.push({ kind: 'op', text: c })
      i++
    }
  }
  return out
}

function skipComment(src: string, at: number): number {
  const long = /^--\[(=*)\[/.exec(src.slice(at))
  if (long) {
    const end = src.indexOf(`]${long[1]}]`, at)
    return end < 0 ? src.length : end + long[1]!.length + 2
  }
  const nl = src.indexOf('\n', at)
  return nl < 0 ? src.length : nl
}

/** Splits the tokens after an opening parenthesis into top-level arguments. */
function splitArgs(tokens: Token[], open: number): Token[][] {
  const args: Token[][] = [[]]
  let depth = 0
  for (let i = open + 1; i < tokens.length; i++) {
    const t = tokens[i] as Token
    if (t.kind === 'op' && '([{'.includes(t.text)) depth++
    if (t.kind === 'op' && ')]}'.includes(t.text)) {
      if (depth === 0) break
      depth--
    }
    if (depth === 0 && t.kind === 'op' && t.text === ',') args.push([])
    else args[args.length - 1]?.push(t)
  }
  return args.filter((a) => a.length > 0)
}

function keyArgIndexes(command: string, count: number): number[] {
  const all = Array.from({ length: count }, (_, i) => i)
  if (NO_KEY.has(command)) return []
  if (ALL_KEYS.has(command)) return all
  if (FIRST_TWO.has(command)) return all.slice(0, 2)
  if (command === 'mset' || command === 'msetnx') return all.filter((i) => i % 2 === 0)
  if (command === 'blpop' || command === 'brpop') return all.slice(0, -1)
  return count > 0 ? [0] : []
}

/** Token ranges of Lua functions that take a parameter named KEYS: inside, KEYS is not the script's. */
function shadowRanges(tokens: Token[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  tokens.forEach((t, i) => {
    if (t.kind !== 'id' || t.text !== 'function' || !parameterNames(tokens, i).includes('KEYS'))
      return
    let depth = 0
    for (let j = i; j < tokens.length; j++) {
      const word = tokens[j]?.kind === 'id' ? tokens[j]?.text : ''
      if (['function', 'if', 'do', 'repeat'].includes(word as string)) depth++
      if (word === 'end' || word === 'until') depth--
      if (depth === 0) {
        ranges.push([i, j])
        return
      }
    }
    ranges.push([i, tokens.length])
  })
  return ranges
}

const within = (ranges: Array<[number, number]>, at: number) =>
  ranges.some(([a, b]) => at >= a && at <= b)

/** True for exactly `KEYS[<index>]`, where the index is a number, a name, or a name plus or minus a number. */
function isKeysSubscript(tokens: Token[]): boolean {
  if (
    tokens[0]?.text !== 'KEYS' ||
    tokens[1]?.text !== '[' ||
    tokens[tokens.length - 1]?.text !== ']'
  ) {
    return false
  }
  const inner = tokens.slice(2, -1)
  const simple = (t?: Token) => t?.kind === 'id' || t?.kind === 'num'
  const shaped =
    (inner.length === 1 && simple(inner[0])) ||
    (inner.length === 3 &&
      inner[0]?.kind === 'id' &&
      '+-'.includes(inner[1]?.text ?? ' ') &&
      inner[2]?.kind === 'num')
  return shaped
}

function isDeclared(arg: Token[], keyLocals: Set<string>, keysShadowed: boolean): boolean {
  const first = arg[0]
  if (!first) return false
  if (arg.length === 1) return first.kind === 'id' && keyLocals.has(first.text)
  return !keysShadowed && isKeysSubscript(arg)
}

function argvFeeding(arg: Token[]): number[] {
  const found: number[] = []
  arg.forEach((t, i) => {
    if (t.text === 'ARGV' && arg[i + 1]?.text === '[' && arg[i + 2]?.kind === 'num') {
      found.push(Number(arg[i + 2]?.text))
    }
  })
  return found
}

/** Loop variables of `for _, k in ipairs(KEYS)`. */
function loopKeyNames(
  tokens: Token[],
  at: number,
  shadows: Array<[number, number]>,
  good: Set<string>,
  bad: Set<string>
): void {
  let j = at + 1
  const vars: string[] = []
  for (; j < tokens.length && tokens[j]?.text !== 'in' && tokens[j]?.text !== '='; j++) {
    if (tokens[j]?.kind === 'id') vars.push((tokens[j] as Token).text)
  }
  const [iter, open, source] = [tokens[j + 1]?.text, tokens[j + 2]?.text, tokens[j + 3]?.text]
  if (
    (iter === 'ipairs' || iter === 'pairs') &&
    open === '(' &&
    source === 'KEYS' &&
    !within(shadows, at)
  ) {
    vars.forEach((v) => good.add(v))
  } else {
    vars.forEach((v) => bad.add(v))
  }
}

/** Names on the left of the `=` at `at`: one for `x =`, several for `a, b =`. */
function assignedNames(tokens: Token[], at: number): string[] {
  const names: string[] = []
  for (let j = at - 1; j >= 0 && tokens[j]?.kind === 'id'; j -= 2) {
    names.push((tokens[j] as Token).text)
    if (tokens[j - 1]?.text !== ',') break
  }
  return names
}

/** True when the expression starting at `from` is exactly one `KEYS[i]` and nothing more. */
function isExactKeysAt(tokens: Token[], from: number): boolean {
  if (tokens[from]?.text !== 'KEYS' || tokens[from + 1]?.text !== '[') return false
  let depth = 0
  let end = from + 1
  for (; end < tokens.length; end++) {
    if (tokens[end]?.text === '[') depth++
    if (tokens[end]?.text === ']' && --depth === 0) break
  }
  const next = tokens[end + 1]
  const continues =
    (next?.kind === 'op' && next.text !== ';') || ['and', 'or'].includes(next?.text ?? '')
  return !continues && isKeysSubscript(tokens.slice(from, end + 1))
}

/** Parameter names of the Lua function that starts at `at`: they shadow any local of the same name. */
function parameterNames(tokens: Token[], at: number): string[] {
  let j = at + 1
  while (j < tokens.length && tokens[j]?.text !== '(') j++
  const names: string[] = []
  for (j++; j < tokens.length && tokens[j]?.text !== ')'; j++) {
    if (tokens[j]?.kind === 'id') names.push((tokens[j] as Token).text)
  }
  return names
}

/**
 * Names that hold a declared key: every assignment to them is exactly `KEYS[i]`. One later
 * assignment of anything else, or a multiple assignment, takes the name out.
 */
function keyLocalNames(tokens: Token[], shadows: Array<[number, number]>): Set<string> {
  const good = new Set<string>()
  const bad = new Set<string>()
  tokens.forEach((t, i) => {
    if (t.text === 'for' && t.kind === 'id') loopKeyNames(tokens, i, shadows, good, bad)
    if (t.text === 'function' && t.kind === 'id')
      parameterNames(tokens, i).forEach((n) => bad.add(n))
    const isAssign =
      t.text === '=' &&
      tokens[i + 1]?.text !== '=' &&
      !['=', '~', '<', '>'].includes(tokens[i - 1]?.text ?? '')
    if (!isAssign) return
    const names = assignedNames(tokens, i)
    const exact = names.length === 1 && !within(shadows, i) && isExactKeysAt(tokens, i + 1)
    for (const name of names) (exact ? good : bad).add(name)
  })
  for (const name of bad) good.delete(name)
  return good
}

export function undeclaredCalls(script: string): UndeclaredCall[] {
  const tokens = tokenize(script)
  const shadows = shadowRanges(tokens)
  const keyLocals = keyLocalNames(tokens, shadows)
  const found: UndeclaredCall[] = []
  tokens.forEach((t, i) => {
    const isCall =
      t.text === 'redis' &&
      tokens[i + 1]?.text === '.' &&
      ['call', 'pcall'].includes(tokens[i + 2]?.text ?? '') &&
      tokens[i + 3]?.text === '('
    if (!isCall) return
    const [name, ...args] = splitArgs(tokens, i + 3)
    if (name?.length !== 1 || name[0]?.kind !== 'str') return
    const command = (name[0] as Token).text.toLowerCase()
    for (const index of keyArgIndexes(command, args.length)) {
      const arg = args[index] as Token[]
      if (!isDeclared(arg, keyLocals, within(shadows, i)))
        found.push({ command, argv: argvFeeding(arg) })
    }
  })
  return found
}
