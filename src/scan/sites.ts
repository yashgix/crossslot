import { createHash } from 'node:crypto'
import ts from 'typescript'
import { undeclaredCalls } from './lua.js'
import { type Program, rel } from './program.js'
import { type Env, type Listing, Resolver, STAR, placeholder, unwrap } from './resolver.js'
import { colocated, tagOf } from './tags.js'
import type { Arg, Client, Command, DetailedSite, Hazard, Kind, OpSite } from './types.js'

const FAMILY: Record<string, Kind> = {
  eval: 'eval',
  evalsha: 'evalsha',
  multi: 'multi',
  pipeline: 'pipeline',
}
const ALL_KEYS = new Set('mget del unlink exists sunion sinter sdiff touch pfcount'.split(' '))
const FIRST_TWO = new Set('rename renamenx smove lmove blmove'.split(' '))
const MULTIKEY = new Set([
  ...ALL_KEYS,
  ...FIRST_TWO,
  'mset',
  'msetnx',
  'blpop',
  'brpop',
  'zunionstore',
  'zinterstore',
  'xread',
])
const NO_KEY_COMMANDS = new Set(
  'exec discard publish spublish ping time eval evalsha script info'.split(' ')
)
/** Single-key commands the harness replays when a fix replaced a multi-key call with these. */
const OP_COMMANDS = new Set(['get', 'set', 'del', 'xread'])
const REDIS_RECEIVER = /redis|^(this\.)?(read|write)$/i
const ARRAY_METHODS = new Set('map filter slice flat flatMap concat sort'.split(' '))

interface Keys {
  patterns: string[] | null
  count: number | 'dynamic'
  open: boolean
}

/** A key placeholder that calls something other than the pure helpers a driver can compute. */
const OPAQUE_CALL = /\$\{(?!(?:sha256Hex|encodeURIComponent|String|JSON\.stringify)\()[^}]*\(/

const NO_ENV: Env = new Map()

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function fnName(node: ts.Node): string {
  for (let p = node.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name)
      return p.name.getText()
    const isFn = ts.isArrowFunction(p) || ts.isFunctionExpression(p)
    if (isFn && ts.isVariableDeclaration(p.parent)) return p.parent.name.getText()
  }
  return ''
}

/** The method or function declaration an expression sits in, however deep its callbacks nest. */
function declaringFn(node: ts.Node): string {
  let found = ''
  for (let p = node.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name)
      found = p.name.getText()
  }
  return found || fnName(node)
}

/** A condition the scanner can evaluate without running anything: true, false, a number, or their negation. */
function constantCondition(e: ts.Expression): boolean | null {
  const x = unwrap(e)
  if (x.kind === ts.SyntaxKind.TrueKeyword) return true
  if (x.kind === ts.SyntaxKind.FalseKeyword) return false
  if (ts.isNumericLiteral(x)) return Number(x.text) !== 0
  if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = constantCondition(x.operand)
    return inner === null ? null : !inner
  }
  return null
}

/** Whether the branch a node sits in runs when its parent's condition is `taken`. */
function branchTaken(parent: ts.Node, child: ts.Node): boolean | 'unknown' | 'always' {
  let condition: ts.Expression | null = null
  let inThen = true
  if (ts.isIfStatement(parent) && child !== parent.expression) {
    condition = parent.expression
    inThen = child === parent.thenStatement
  } else if (ts.isConditionalExpression(parent) && child !== parent.condition) {
    condition = parent.condition
    inThen = child === parent.whenTrue
  } else if (
    ts.isBinaryExpression(parent) &&
    child === parent.right &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(parent.operatorToken.kind)
  ) {
    const left = constantCondition(parent.left)
    if (left === null) return 'unknown'
    const and = parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    return and === left
  } else if (
    (ts.isWhileStatement(parent) && child === parent.statement) ||
    (ts.isForStatement(parent) && child === parent.statement && parent.condition)
  ) {
    condition = ts.isWhileStatement(parent)
      ? parent.expression
      : (parent.condition as ts.Expression)
    const value = constantCondition(condition)
    return value === null ? 'unknown' : value ? 'always' : false
  } else if (ts.isCaseClause(parent) || ts.isDefaultClause(parent) || ts.isCatchClause(parent)) {
    return 'unknown'
  }
  if (!condition) return 'always'
  const value = constantCondition(condition)
  return value === null ? 'unknown' : value === inThen
}

function clientOf(sf: ts.SourceFile): Client {
  const specs = sf.statements
    .filter(ts.isImportDeclaration)
    .map((s) => (s.moduleSpecifier as ts.StringLiteral).text)
  if (specs.includes('redis')) return 'node-redis'
  if (specs.includes('ioredis') || specs.some((s) => s.endsWith('config/redis'))) return 'ioredis'
  return 'unknown'
}

export class SiteFinder {
  private readonly resolver: Resolver
  private readonly byPath = new Map<string, ts.SourceFile>()
  private readonly helpers = new Map<string, string | null>()

  constructor(private readonly program: Program) {
    this.resolver = new Resolver(program)
    for (const sf of program.files.values()) this.byPath.set(rel(program, sf), sf)
  }

  /** Helpers are looked up for every key the harness renders, so each is resolved once. */
  helper(file: string, name: string): string | null {
    const id = `${file}#${name}`
    if (!this.helpers.has(id)) {
      const sf = this.byPath.get(file)
      this.helpers.set(id, sf ? this.resolver.helper(sf, name) : null)
    }
    return this.helpers.get(id) ?? null
  }

  find(): { sites: DetailedSite[]; ops: OpSite[] } {
    const sites: DetailedSite[] = []
    const ops: OpSite[] = []
    for (const sf of this.program.files.values()) {
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const site = this.siteOf(sf, n, n.expression)
          if (site) sites.push(site)
          else this.collectOp(sf, n, n.expression, ops)
        }
        ts.forEachChild(n, visit)
      }
      visit(sf)
    }
    return { sites, ops }
  }

  /**
   * Whether a call runs when its function does. `dead` when a constant condition rules it out,
   * `unknown` under a condition the scanner cannot evaluate, including a call to the local helper
   * that holds it.
   */
  private guardOf(node: ts.Node, depth = 0): 'none' | 'unknown' | 'dead' {
    let result: 'none' | 'unknown' | 'dead' = 'none'
    for (let child = node, p = node.parent; p; child = p, p = p.parent) {
      const taken = branchTaken(p, child)
      if (taken === false) return 'dead'
      if (taken === 'unknown') result = 'unknown'
      if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) break
      const holder = ts.isArrowFunction(p) || ts.isFunctionExpression(p) ? p.parent : null
      if (holder && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) && depth < 3) {
        for (const use of this.callsOf(holder.name.text, holder)) {
          const outer = this.guardOf(use, depth + 1)
          if (outer !== 'none')
            result = outer === 'dead' && result === 'none' ? 'unknown' : 'unknown'
        }
      }
    }
    return result
  }

  private callsOf(name: string, from: ts.Node): ts.CallExpression[] {
    let scope: ts.Node = from
    while (scope.parent && !ts.isFunctionDeclaration(scope) && !ts.isMethodDeclaration(scope))
      scope = scope.parent
    const out: ts.CallExpression[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name)
        out.push(n)
      ts.forEachChild(n, visit)
    }
    visit(scope)
    return out
  }

  private collectOp(
    sf: ts.SourceFile,
    call: ts.CallExpression,
    access: ts.PropertyAccessExpression,
    ops: OpSite[]
  ): void {
    const command = access.name.text.toLowerCase()
    if (!OP_COMMANDS.has(command) || !REDIS_RECEIVER.test(access.expression.getText())) return
    const first = call.arguments[0]
    const keys =
      command === 'xread' && first ? (this.resolver.list(first, NO_ENV)?.items ?? null) : null
    const guard = this.guardOf(call)
    if (guard === 'dead') return
    const line = lineOf(sf, access.name)
    const file = rel(this.program, sf)
    ops.push({
      guard,
      id: `${file}:${line}`,
      file,
      line,
      fn: declaringFn(call),
      command,
      args: call.arguments.map((a) => this.arg(a, NO_ENV)),
      keys,
    })
  }

  private siteOf(sf: ts.SourceFile, call: ts.CallExpression, access: ts.PropertyAccessExpression) {
    const name = access.name.text
    const kind = FAMILY[name.toLowerCase()]
    const command = name.toLowerCase()
    const base = {
      file: rel(this.program, sf),
      line: lineOf(sf, access.name),
      client: clientOf(sf),
      fn: fnName(call),
    }
    this.resolver.mutableHit = false
    const site = this.siteFor(sf, call, kind, command, base)
    if (site && this.resolver.mutableHit) this.markMutable(site)
    return site
  }

  private siteFor(
    sf: ts.SourceFile,
    call: ts.CallExpression,
    kind: Kind | undefined,
    command: string,
    base: Base
  ) {
    if (kind === 'eval' || kind === 'evalsha') return this.evalSite(sf, call, kind, base)
    if (kind === 'multi' || kind === 'pipeline') return this.chainSite(call, kind, base)
    if (MULTIKEY.has(command)) return this.multikeySite(call, command, base)
    return null
  }

  /** A `let` or `var` in a key or argument can hold anything when the call runs. */
  private markMutable(site: DetailedSite): void {
    site.resolved = false
    if (site.hazards.some((h) => h.code === 'UNRESOLVED')) return
    site.hazards.push({
      code: 'UNRESOLVED',
      severity: 'info',
      detail: 'a value comes from a mutable variable',
    })
  }

  // ---- eval and evalsha -------------------------------------------------

  private evalSite(
    sf: ts.SourceFile,
    call: ts.CallExpression,
    kind: Kind,
    base: Base
  ): DetailedSite {
    const r = this.resolver
    const first = call.arguments[0]
    const loaded = first && kind === 'evalsha' ? this.viaScriptLoad(sf, first) : null
    const scriptArg = loaded ?? first
    let script = scriptArg ? r.str(scriptArg, NO_ENV) : null
    if (script?.includes('${')) script = null
    const scriptName =
      scriptArg && ts.isIdentifier(unwrap(scriptArg)) ? unwrap(scriptArg).getText() : null
    const { keys, args } = this.evalKeys(call)
    const hazards: Hazard[] = []
    this.crossSlot(keys, false, hazards)
    if (script !== null) this.undeclared(script, keys, args, hazards)
    const why: string[] = []
    if (script === null) why.push('script text could not be resolved')
    if (keys.patterns === null) why.push('key list could not be resolved')
    if (why.length > 0)
      hazards.push({ code: 'UNRESOLVED', severity: 'info', detail: why.join(' and ') })
    return this.finish(base, kind, null, keys, why.length === 0, hazards, {
      script,
      scriptName,
      args,
      commands: [],
    })
  }

  private viaScriptLoad(sf: ts.SourceFile, ref: ts.Expression): ts.Expression | null {
    const x = unwrap(ref)
    const name = ts.isPropertyAccessExpression(x) ? x.name.text : ts.isIdentifier(x) ? x.text : null
    if (!name) return null
    let found: ts.Expression | null = null
    const visit = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = n.left
        const leftName = ts.isPropertyAccessExpression(left)
          ? left.name.text
          : ts.isIdentifier(left)
            ? left.text
            : null
        const right = unwrap(n.right)
        const isLoad =
          ts.isCallExpression(right) &&
          ts.isPropertyAccessExpression(right.expression) &&
          right.expression.name.text === 'scriptLoad'
        if (leftName === name && isLoad && right.arguments[0]) found = right.arguments[0]
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return found
  }

  private evalKeys(call: ts.CallExpression): { keys: Keys; args: Arg[] | null } {
    const second = call.arguments[1] && unwrap(call.arguments[1])
    if (second && ts.isObjectLiteralExpression(second)) return this.nodeRedisKeys(second)
    return this.ioredisKeys(call.arguments.slice(1))
  }

  private nodeRedisKeys(opts: ts.ObjectLiteralExpression): { keys: Keys; args: Arg[] | null } {
    const field = (name: string) => {
      const p = opts.properties.find((q) => ts.isPropertyAssignment(q) && q.name.getText() === name)
      return p && ts.isPropertyAssignment(p) ? p.initializer : null
    }
    const keyExpr = field('keys')
    const argExpr = field('arguments')
    const listing = keyExpr ? this.resolver.list(keyExpr, NO_ENV) : { items: [], open: false }
    const argList = argExpr ? unwrap(argExpr) : null
    const args =
      argList && ts.isArrayLiteralExpression(argList) && !argList.elements.some(ts.isSpreadElement)
        ? argList.elements.map((e) => this.arg(e, NO_ENV))
        : argExpr
          ? null
          : []
    return { keys: this.keysFrom(listing), args }
  }

  private ioredisKeys(rest: readonly ts.Expression[]): { keys: Keys; args: Arg[] | null } {
    const [numArg, ...after] = rest
    const n = numArg ? this.resolver.num(numArg, NO_ENV) : null
    const spreadAt = after.findIndex(ts.isSpreadElement)
    const keyCount = n ?? (spreadAt >= 0 ? spreadAt + 1 : after.length)
    const keyNodes = n !== null && spreadAt < 0 ? after.slice(0, n) : after.slice(0, keyCount)
    const items: string[] = []
    let open = n === null
    for (const k of keyNodes) {
      if (ts.isSpreadElement(k)) {
        const inner = this.resolver.list(k.expression, NO_ENV)
        if (!inner) return { keys: { patterns: null, count: 'dynamic', open: true }, args: null }
        items.push(...inner.items)
        open = true
      } else {
        items.push(this.resolver.part(k, NO_ENV, 0))
      }
    }
    const tail = after.slice(keyNodes.length)
    const args = tail.some(ts.isSpreadElement) ? null : tail.map((e) => this.arg(e, NO_ENV))
    return { keys: { patterns: items, count: open ? 'dynamic' : items.length, open }, args }
  }

  private keysFrom(listing: Listing | null): Keys {
    if (!listing) return { patterns: null, count: 'dynamic', open: true }
    return {
      patterns: listing.items,
      count: listing.open ? 'dynamic' : listing.items.length,
      open: listing.open,
    }
  }

  private arg(e: ts.Expression, env: Env): Arg {
    const x = unwrap(e)
    if (ts.isObjectLiteralExpression(x)) {
      const fields: Array<[string, string]> = []
      for (const p of x.properties) {
        if (ts.isPropertyAssignment(p))
          fields.push([p.name.getText(), this.resolver.part(p.initializer, env, 0)])
        else if (ts.isShorthandPropertyAssignment(p))
          fields.push([p.name.text, placeholder(p.name)])
      }
      return { fields }
    }
    return this.resolver.part(e, env, 0)
  }

  // ---- multi and pipeline -------------------------------------------------

  private chainSite(call: ts.CallExpression, kind: Kind, base: Base): DetailedSite {
    const calls = [...this.chained(call), ...this.onVariable(call)]
    const commands: Command[] = []
    let varying = false
    for (const c of calls) {
      const access = c.expression as ts.PropertyAccessExpression
      const name = access.name.text.toLowerCase()
      if (NO_KEY_COMMANDS.has(name)) continue
      commands.push({ name, args: c.arguments.map((a) => this.arg(a, NO_ENV)) })
      varying ||= this.inLoop(c, call)
    }
    const patterns = commands.map((c) =>
      typeof c.args[0] === 'string' ? c.args[0] : placeholder(call)
    )
    const keys: Keys = { patterns, count: varying ? 'dynamic' : patterns.length, open: varying }
    const hazards: Hazard[] = []
    this.crossSlot(keys, varying, hazards)
    return this.finish(base, kind, null, keys, true, hazards, {
      script: null,
      scriptName: null,
      args: null,
      commands,
    })
  }

  private chained(call: ts.CallExpression): ts.CallExpression[] {
    const out: ts.CallExpression[] = []
    let cur: ts.Node = call
    for (;;) {
      const access = cur.parent
      const next = access?.parent
      const ok =
        access &&
        ts.isPropertyAccessExpression(access) &&
        access.expression === cur &&
        next &&
        ts.isCallExpression(next) &&
        next.expression === access
      if (!ok) return out
      if (access.name.text === 'exec') return out
      out.push(next)
      cur = next
    }
  }

  private onVariable(call: ts.CallExpression): ts.CallExpression[] {
    const decl = call.parent
    if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return []
    const name = decl.name.text
    let scope: ts.Node = decl
    while (scope.parent && !ts.isFunctionLike(scope)) scope = scope.parent
    const out: ts.CallExpression[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const obj = n.expression.expression
        if (ts.isIdentifier(obj) && obj.text === name && n.expression.name.text !== 'exec')
          out.push(n)
      }
      ts.forEachChild(n, visit)
    }
    visit(scope)
    return out
  }

  /** True when `cmd` runs inside a loop or callback that the multi's own function does not. */
  private inLoop(cmd: ts.Node, multi: ts.Node): boolean {
    const home = this.enclosingFunction(multi)
    for (let p = cmd.parent; p && p !== home; p = p.parent) {
      if (ts.isIterationStatement(p, false) || ts.isArrowFunction(p) || ts.isFunctionExpression(p))
        return true
    }
    return false
  }

  private enclosingFunction(n: ts.Node): ts.Node | undefined {
    let p = n.parent
    while (p && !ts.isFunctionLike(p)) p = p.parent
    return p
  }

  // ---- multi-key commands -------------------------------------------------

  private multikeySite(call: ts.CallExpression, command: string, base: Base): DetailedSite | null {
    const args = [...call.arguments]
    const keys = this.commandKeys(command, args)
    const dynamic = keys === null || keys.open
    const count = keys ? (keys.patterns?.length ?? 0) : 0
    if (!dynamic && count < 2) return null
    const hazards: Hazard[] = []
    this.crossSlot(keys ?? { patterns: null, count: 'dynamic', open: true }, false, hazards)
    const k = keys ?? { patterns: null, count: 'dynamic' as const, open: true }
    const commands: Command[] = [{ name: command, args: args.map((a) => this.arg(a, NO_ENV)) }]
    return this.finish(base, 'multikey', command, k, k.patterns !== null, hazards, {
      script: null,
      scriptName: null,
      args: null,
      commands,
    })
  }

  private commandKeys(command: string, args: ts.Expression[]): Keys | null {
    if (command === 'xread') return this.streamKeys(args)
    if (args.length === 1 && !ts.isSpreadElement(args[0] as ts.Expression)) {
      const only = args[0] as ts.Expression
      if (!this.isArrayish(only))
        return { patterns: [this.resolver.part(only, NO_ENV, 0)], count: 1, open: false }
      return this.keysFrom(this.resolver.list(only, NO_ENV))
    }
    const { picked, countKnown } = this.pickKeyArgs(command, args)
    const items: string[] = []
    let open = !countKnown
    for (const a of picked) {
      if (ts.isSpreadElement(a)) {
        const inner = this.resolver.list(a.expression, NO_ENV)
        if (!inner) return null
        items.push(...inner.items)
        open = true
      } else {
        items.push(this.resolver.part(a, NO_ENV, 0))
      }
    }
    return { patterns: items, count: open ? 'dynamic' : items.length, open }
  }

  private pickKeyArgs(command: string, args: ts.Expression[]) {
    const known = (picked: ts.Expression[]) => ({ picked, countKnown: true })
    if (FIRST_TWO.has(command)) return known(args.slice(0, 2))
    if (command === 'mset' || command === 'msetnx') return known(args.filter((_, i) => i % 2 === 0))
    if (command === 'blpop' || command === 'brpop') return known(args.slice(0, -1))
    if (command === 'zunionstore' || command === 'zinterstore') {
      // ZUNIONSTORE destination numkeys key... [WEIGHTS ...] [AGGREGATE ...]: only numkeys keys follow.
      const n = args[1] ? this.resolver.num(args[1], NO_ENV) : null
      const dest = args[0] as ts.Expression
      if (n !== null) return known([dest, ...args.slice(2, 2 + n)])
      return { picked: [dest, ...args.slice(2)], countKnown: false }
    }
    return known(args)
  }

  /** node-redis `xRead(streams[])` or ioredis `xread(..., 'STREAMS', key..., id...)`. */
  private streamKeys(args: ts.Expression[]): Keys | null {
    const marker = args.findIndex((a) => {
      const x = unwrap(a)
      return ts.isStringLiteralLike(x) && x.text.toLowerCase() === 'streams'
    })
    if (marker >= 0) return this.streamsAfterMarker(args.slice(marker + 1))
    const first = args[0]
    if (!first) return null
    const listing = this.resolver.list(first, NO_ENV)
    if (!listing) return null
    if (listing.items.length < 2 && !listing.open)
      return { patterns: listing.items, count: 1, open: false }
    return this.keysFrom(listing)
  }

  /**
   * The keys are the first half of what follows STREAMS, the ids the second half. Spreads are
   * flattened first, so an id list cannot be taken for keys; one that cannot be flattened leaves
   * the keys unknown.
   */
  private streamsAfterMarker(rest: ts.Expression[]): Keys | null {
    const flat: string[] = []
    for (const arg of rest) {
      if (!ts.isSpreadElement(arg)) {
        flat.push(this.resolver.part(arg, NO_ENV, 0))
        continue
      }
      const inner = this.resolver.list(arg.expression, NO_ENV)
      if (!inner || inner.open) return { patterns: null, count: 'dynamic', open: true }
      flat.push(...inner.items)
    }
    const patterns = flat.slice(0, Math.floor(flat.length / 2))
    return { patterns, count: patterns.length, open: false }
  }

  private isArrayish(e: ts.Expression, depth = 0): boolean {
    const x = unwrap(e)
    if (depth > 6) return false
    if (ts.isArrayLiteralExpression(x)) return true
    if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression))
      return ARRAY_METHODS.has(x.expression.name.text)
    if (!ts.isIdentifier(x)) return false
    const decl = this.resolver.lookup(x)
    if (decl?.kind === 'var') return !!decl.init && this.isArrayish(decl.init, depth + 1)
    if (decl?.kind === 'param') return this.arrayType(decl.node.type)
    return false
  }

  private arrayType(t: ts.TypeNode | undefined): boolean {
    if (!t) return false
    if (ts.isArrayTypeNode(t) || ts.isTupleTypeNode(t)) return true
    if (ts.isTypeOperatorNode(t)) return this.arrayType(t.type)
    return ts.isTypeReferenceNode(t) && ['Array', 'ReadonlyArray'].includes(t.typeName.getText())
  }

  // ---- hazards ------------------------------------------------------------

  private crossSlot(keys: Keys, varying: boolean, out: Hazard[]): void {
    if (keys.patterns === null) {
      out.push({
        code: 'CROSS_SLOT_KEYS',
        severity: 'error',
        detail: 'dynamic key list, no common hash tag can be shown',
      })
      return
    }
    const several = keys.patterns.length >= 2 || keys.open || varying
    if (!several || colocated(keys.patterns, varying || keys.open)) return
    out.push({
      code: 'CROSS_SLOT_KEYS',
      severity: 'error',
      detail: `keys do not share one literal hash tag: ${keys.patterns.join(' | ')}`,
    })
  }

  private undeclared(script: string, keys: Keys, args: Arg[] | null, out: Hazard[]): void {
    const calls = undeclaredCalls(script)
    if (calls.length === 0) return
    const safe = (argv: number[]) => {
      const feeds = argv.map((i) => args?.[i - 1])
      if (argv.length === 0 || feeds.some((f) => typeof f !== 'string') || !keys.patterns)
        return false
      const tags = [...keys.patterns, ...(feeds as string[])].map(tagOf)
      const first = tags[0]
      return !!first && !first.includes(STAR) && tags.every((t) => t === first)
    }
    const allSafe = calls.every((c) => safe(c.argv))
    out.push({
      code: 'UNDECLARED_KEY',
      severity: allSafe ? 'info' : 'error',
      detail: `script touches keys it did not declare: ${calls.map((c) => c.command).join(', ')}`,
    })
  }

  private finish(
    base: Base,
    kind: Kind,
    command: string | null,
    keys: Keys,
    resolved: boolean,
    hazards: Hazard[],
    detail: {
      script: string | null
      scriptName: string | null
      args: Arg[] | null
      commands: Command[]
    }
  ): DetailedSite {
    const { script, ...rest } = detail
    const opaque = keys.patterns?.some((p) => OPAQUE_CALL.test(p)) ?? false
    const known = resolved && !opaque
    if (!known && !hazards.some((h) => h.code === 'UNRESOLVED')) {
      const why = opaque
        ? 'a key is built by a call the scanner cannot read'
        : 'key patterns could not be resolved'
      hazards.push({ code: 'UNRESOLVED', severity: 'info', detail: why })
    }
    return {
      id: `${base.file}:${base.line}`,
      file: base.file,
      line: base.line,
      client: base.client,
      kind,
      command,
      scriptSha256: script === null ? null : createHash('sha256').update(script).digest('hex'),
      keyPatterns: keys.patterns,
      keyCount: keys.count,
      resolved: known,
      hazards: hazards.sort((a, b) => a.code.localeCompare(b.code)),
      fn: base.fn,
      script,
      ...rest,
    }
  }
}

type Base = {
  file: string
  line: number
  client: Client
  fn: string
}
