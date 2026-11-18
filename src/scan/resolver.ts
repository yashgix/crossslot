import ts from 'typescript'
import type { Program } from './program.js'

/** Parameter node to the template that replaces it while a helper body is read. */
export type Env = Map<ts.Node, string>

export interface Listing {
  items: string[]
  /** True when the real list can be longer, as after `.map` over a variable-length array. */
  open: boolean
}

type Decl =
  | { kind: 'var'; init: ts.Expression | undefined }
  | { kind: 'fn'; node: ts.FunctionLikeDeclaration }
  | { kind: 'param'; node: ts.ParameterDeclaration }
  | { kind: 'other' }
  | { kind: 'mutable' }

const MAX_DEPTH = 14
export const STAR = '${*}'

export function placeholder(node: ts.Node): string {
  return `\${${node.getText().replace(/\s+/g, ' ')}}`
}

export function unwrap(e: ts.Expression): ts.Expression {
  let cur = e
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isAwaitExpression(cur)
  ) {
    cur = cur.expression
  }
  return cur
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : bindingNames(el.name)))
}

function isFunctionExpression(
  e: ts.Expression | undefined
): e is ts.ArrowFunction | ts.FunctionExpression {
  return !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e))
}

export class Resolver {
  /** Set when a template had to leave a `let` or `var` variable as a placeholder. */
  mutableHit = false

  constructor(private readonly program: Program) {}

  lookup(id: ts.Identifier): Decl | null {
    const decl = this.find(id)
    if (decl?.kind === 'mutable') this.mutableHit = true
    return decl
  }

  private find(id: ts.Identifier): Decl | null {
    const name = id.text
    for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
      if (ts.isFunctionLike(n)) {
        const param = n.parameters.find((p) => bindingNames(p.name).includes(name))
        if (param) return { kind: 'param', node: param }
      }
      if (ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isForStatement(n)) {
        const init = n.initializer
        if (init && ts.isVariableDeclarationList(init)) {
          if (init.declarations.some((d) => bindingNames(d.name).includes(name)))
            return { kind: 'other' }
        }
      }
      if (ts.isCatchClause(n) && n.variableDeclaration?.name.getText() === name)
        return { kind: 'other' }
      if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n)) {
        const found = this.inStatements(n.statements, name, n)
        if (found) return found
      }
    }
    return null
  }

  private inStatements(
    statements: ts.NodeArray<ts.Statement>,
    name: string,
    scope: ts.Node
  ): Decl | null {
    for (const st of statements) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!bindingNames(d.name).includes(name)) continue
          // Only `const` is trusted: a `let` or `var` may hold something else when the call runs.
          const immutable = (st.declarationList.flags & ts.NodeFlags.Const) !== 0
          if (!immutable) return { kind: 'mutable' }
          return ts.isIdentifier(d.name) ? { kind: 'var', init: d.initializer } : { kind: 'other' }
        }
      } else if (ts.isFunctionDeclaration(st) && st.name?.text === name) {
        return { kind: 'fn', node: st }
      } else if (ts.isImportDeclaration(st) && ts.isSourceFile(scope)) {
        const imported = this.fromImport(st, name, scope)
        if (imported) return imported
      }
    }
    return null
  }

  private fromImport(st: ts.ImportDeclaration, name: string, sf: ts.SourceFile): Decl | null {
    const bindings = st.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) return null
    const spec = bindings.elements.find((el) => el.name.text === name)
    if (!spec || !ts.isStringLiteral(st.moduleSpecifier)) return null
    const target = this.program.resolveModule(st.moduleSpecifier.text, sf.fileName)
    if (!target) return { kind: 'other' }
    const wanted = (spec.propertyName ?? spec.name).text
    return this.inStatements(target.statements, wanted, target) ?? { kind: 'other' }
  }

  num(e: ts.Expression, env: Env, depth = 0): number | null {
    const x = unwrap(e)
    if (ts.isNumericLiteral(x)) return Number(x.text)
    if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.MinusToken) {
      const v = this.num(x.operand, env, depth)
      return v === null ? null : -v
    }
    if (ts.isBinaryExpression(x)) {
      const l = this.num(x.left, env, depth)
      const r = this.num(x.right, env, depth)
      if (l === null || r === null) return null
      const ops: Partial<Record<ts.SyntaxKind, number>> = {
        [ts.SyntaxKind.PlusToken]: l + r,
        [ts.SyntaxKind.MinusToken]: l - r,
        [ts.SyntaxKind.AsteriskToken]: l * r,
        [ts.SyntaxKind.SlashToken]: r === 0 ? undefined : l / r,
      }
      return ops[x.operatorToken.kind] ?? null
    }
    if (ts.isIdentifier(x)) {
      const text = this.str(x, env, depth)
      return text !== null && /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null
    }
    return null
  }

  /** Template text for an expression, or null when nothing static is known about it. */
  str(e: ts.Expression, env: Env, depth = 0): string | null {
    if (depth > MAX_DEPTH) return null
    const x = unwrap(e)
    if (ts.isStringLiteralLike(x)) return x.text
    if (ts.isNumericLiteral(x)) return x.text
    if (ts.isTemplateExpression(x)) return this.template(x, env, depth)
    if (ts.isIdentifier(x)) return this.identifier(x, env, depth)
    if (ts.isBinaryExpression(x)) return this.binary(x, env, depth)
    if (ts.isCallExpression(x)) return this.callValue(x, env, depth)
    if (ts.isPropertyAccessExpression(x)) return this.property(x, env, depth)
    return null
  }

  part(e: ts.Expression, env: Env, depth: number): string {
    return this.str(e, env, depth + 1) ?? placeholder(e)
  }

  private template(x: ts.TemplateExpression, env: Env, depth: number): string {
    return (
      x.head.text +
      x.templateSpans.map((s) => this.part(s.expression, env, depth) + s.literal.text).join('')
    )
  }

  private identifier(x: ts.Identifier, env: Env, depth: number): string | null {
    const decl = this.lookup(x)
    if (!decl) return null
    if (decl.kind === 'param') return env.get(decl.node) ?? null
    if (decl.kind === 'var' && decl.init) return this.str(decl.init, env, depth + 1)
    return null
  }

  private binary(x: ts.BinaryExpression, env: Env, depth: number): string | null {
    const n = this.num(x, env, depth)
    if (n !== null) return String(n)
    if (x.operatorToken.kind !== ts.SyntaxKind.PlusToken) return null
    const l = this.str(x.left, env, depth + 1)
    const r = this.str(x.right, env, depth + 1)
    const stringy = (side: ts.Expression): boolean => {
      const inner = unwrap(side)
      if (ts.isStringLiteralLike(inner) || ts.isTemplateExpression(inner)) return true
      return (
        ts.isBinaryExpression(inner) &&
        inner.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        (stringy(inner.left) || stringy(inner.right))
      )
    }
    if (!stringy(x.left) && !stringy(x.right)) return null
    return (l ?? placeholder(x.left)) + (r ?? placeholder(x.right))
  }

  private property(x: ts.PropertyAccessExpression, env: Env, depth: number): string | null {
    const obj = this.objectLiteral(x.expression)
    const prop = obj?.properties.find(
      (p) => ts.isPropertyAssignment(p) && p.name.getText() === x.name.text
    )
    return prop && ts.isPropertyAssignment(prop) ? this.str(prop.initializer, env, depth + 1) : null
  }

  private objectLiteral(e: ts.Expression): ts.ObjectLiteralExpression | null {
    const x = unwrap(e)
    if (ts.isObjectLiteralExpression(x)) return x
    if (!ts.isIdentifier(x)) return null
    const decl = this.lookup(x)
    return decl?.kind === 'var' && decl.init ? this.objectLiteral(decl.init) : null
  }

  /** The function a call invokes, when it can be read statically. */
  callee(call: ts.CallExpression): ts.FunctionLikeDeclaration | null {
    return this.fnRef(call.expression)
  }

  /** The function an expression names: an identifier or a property of a const object. */
  fnRef(e: ts.Expression): ts.FunctionLikeDeclaration | null {
    const f = unwrap(e)
    if (isFunctionExpression(f)) return f
    if (ts.isIdentifier(f)) return this.fnOf(this.lookup(f))
    if (!ts.isPropertyAccessExpression(f)) return null
    if (f.expression.kind === ts.SyntaxKind.ThisKeyword) return this.method(f)
    const obj = this.objectLiteral(f.expression)
    const prop = obj?.properties.find((p) => p.name?.getText() === f.name.text)
    if (!prop) return null
    if (ts.isMethodDeclaration(prop)) return prop
    return ts.isPropertyAssignment(prop) && isFunctionExpression(unwrap(prop.initializer))
      ? (unwrap(prop.initializer) as ts.ArrowFunction)
      : null
  }

  private fnOf(decl: Decl | null): ts.FunctionLikeDeclaration | null {
    if (decl?.kind === 'fn') return decl.node
    if (decl?.kind === 'var' && decl.init) {
      const init = unwrap(decl.init)
      return isFunctionExpression(init) ? init : null
    }
    return null
  }

  private method(f: ts.PropertyAccessExpression): ts.FunctionLikeDeclaration | null {
    for (let n: ts.Node | undefined = f.parent; n; n = n.parent) {
      if (!ts.isClassLike(n)) continue
      const m = n.members.find(
        (mem) => ts.isMethodDeclaration(mem) && mem.name.getText() === f.name.text
      )
      return (m as ts.MethodDeclaration | undefined) ?? null
    }
    return null
  }

  /** Binds a helper's parameters to the call's argument templates. */
  bind(fn: ts.FunctionLikeDeclaration, args: readonly ts.Expression[], env: Env, depth = 0): Env {
    const inner: Env = new Map(env)
    fn.parameters.forEach((p, i) => {
      const arg = args[i]
      if (arg) inner.set(p, this.part(arg, env, depth))
      else if (p.initializer) inner.set(p, this.part(p.initializer, env, depth))
    })
    return inner
  }

  /** The expression a function returns, when it has one top-level return or an expression body. */
  returned(fn: ts.FunctionLikeDeclaration): ts.Expression | null {
    const body = fn.body
    if (!body) return null
    if (!ts.isBlock(body)) return body
    const last = [...body.statements].reverse().find(ts.isReturnStatement)
    return last?.expression ?? null
  }

  private callValue(x: ts.CallExpression, env: Env, depth: number): string | null {
    const fn = this.callee(x)
    const ret = fn && this.returned(fn)
    if (!fn || !ret) return null
    return this.str(ret, this.bind(fn, x.arguments, env, depth + 1), depth + 1)
  }

  /** The element template of `list.map(callback)`, with the element written `${*}`. */
  mapped(call: ts.CallExpression, env: Env, depth: number): string | null {
    const cb = call.arguments[0]
    if (!cb) return null
    const fn = this.fnRef(cb)
    const ret = fn && this.returned(fn)
    if (!fn || !ret) return null
    const inner: Env = new Map(env)
    const first = fn.parameters[0]
    if (first) inner.set(first, STAR)
    this.starDestructured(first, inner)
    return this.elementValue(ret, inner, depth + 1)
  }

  private starDestructured(p: ts.ParameterDeclaration | undefined, env: Env): void {
    if (!p || ts.isIdentifier(p.name)) return
    for (const el of p.name.elements) if (!ts.isOmittedExpression(el)) env.set(el, STAR)
  }

  /** An array element: a key template, or the `key` field of a stream descriptor object. */
  private item(el: ts.Expression, env: Env, depth: number): string {
    const x = unwrap(el)
    if (ts.isObjectLiteralExpression(x)) {
      const key = x.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'key')
      if (key && ts.isPropertyAssignment(key)) return this.part(key.initializer, env, depth)
    }
    return this.part(el, env, depth)
  }

  /** A map callback may return a key string or an object whose `key` field is the key. */
  private elementValue(e: ts.Expression, env: Env, depth: number): string | null {
    const x = unwrap(e)
    if (ts.isObjectLiteralExpression(x)) {
      const key = x.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'key')
      return key && ts.isPropertyAssignment(key) ? this.str(key.initializer, env, depth) : null
    }
    return this.str(x, env, depth)
  }

  list(e: ts.Expression, env: Env, depth = 0): Listing | null {
    if (depth > MAX_DEPTH) return null
    const x = unwrap(e)
    if (ts.isArrayLiteralExpression(x)) return this.arrayLiteral(x, env, depth)
    if (ts.isIdentifier(x)) {
      const decl = this.lookup(x)
      return decl?.kind === 'var' && decl.init ? this.list(decl.init, env, depth + 1) : null
    }
    if (!ts.isCallExpression(x)) return null
    const f = unwrap(x.expression)
    if (ts.isPropertyAccessExpression(f) && f.name.text === 'map') {
      const item = this.mapped(x, env, depth)
      return item === null ? null : { items: [item], open: true }
    }
    const fn = this.callee(x)
    const ret = fn && this.returned(fn)
    return fn && ret ? this.list(ret, this.bind(fn, x.arguments, env, depth + 1), depth + 1) : null
  }

  private arrayLiteral(x: ts.ArrayLiteralExpression, env: Env, depth: number): Listing | null {
    const items: string[] = []
    let open = false
    for (const el of x.elements) {
      if (ts.isSpreadElement(el)) {
        const inner = this.list(el.expression, env, depth + 1)
        if (!inner) return null
        items.push(...inner.items)
        open ||= inner.open
      } else {
        items.push(this.item(el, env, depth))
      }
    }
    return { items, open }
  }

  /** Template of a named helper: a function or const arrow in a file, or `OBJECT.name` on a const object. */
  helper(sf: ts.SourceFile, name: string): string | null {
    const [owner, member] = name.includes('.')
      ? (name.split('.') as [string, string])
      : [null, name]
    const imported = owner ? null : this.fnOf(this.inStatements(sf.statements, member, sf))
    const importedReturn = imported && this.returned(imported)
    if (importedReturn) return this.str(importedReturn, new Map())
    let found: string | null = null
    const visit = (n: ts.Node): void => {
      if (found !== null) return
      const target = this.namedFunction(n, owner, member)
      const ret = target && this.returned(target)
      if (ret) found = this.str(ret, new Map())
      else ts.forEachChild(n, visit)
    }
    visit(sf)
    return found
  }

  private namedFunction(
    n: ts.Node,
    owner: string | null,
    member: string
  ): ts.FunctionLikeDeclaration | null {
    if (owner) {
      if (!ts.isVariableDeclaration(n) || n.name.getText() !== owner || !n.initializer) return null
      const prop = this.objectLiteral(n.initializer)?.properties.find(
        (p) => p.name?.getText() === member
      )
      return prop && ts.isPropertyAssignment(prop) ? this.fnRef(prop.initializer) : null
    }
    if (ts.isFunctionDeclaration(n) && n.name?.text === member) return n
    const isNamed = ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === member
    return isNamed && n.initializer ? this.fnRef(n.initializer) : null
  }
}
