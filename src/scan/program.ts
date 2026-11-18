import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

export interface Program {
  root: string
  files: Map<string, ts.SourceFile>
  filesScanned: number
  /** Resolves an import specifier written in `from` to a loaded file, or null. */
  resolveModule: (spec: string, from: string) => ts.SourceFile | null
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

function parse(path: string): ts.SourceFile | null {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    kind
  )
  const diagnostics = (sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics
  return diagnostics.length === 0 ? sf : null
}

export function rel(program: Program, sf: ts.SourceFile): string {
  return relative(program.root, sf.fileName).split(sep).join('/')
}

export function loadProgram(root: string, alias: Record<string, string> = {}): Program {
  const absRoot = resolve(root)
  const paths = walk(absRoot)
  const files = new Map<string, ts.SourceFile>()
  for (const path of paths) {
    const sf = parse(path)
    if (sf) files.set(path, sf)
  }
  const candidates = (base: string) => [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]
  const nearestSrc = (from: string): string | null => {
    for (let d = dirname(from); d.startsWith(absRoot) && d !== absRoot; d = dirname(d)) {
      if (d.endsWith(`${sep}src`)) return d
    }
    return null
  }
  const resolveModule = (spec: string, from: string): ts.SourceFile | null => {
    const bases: string[] = []
    if (spec.startsWith('.')) bases.push(resolve(dirname(from), spec))
    for (const [prefix, dir] of Object.entries(alias)) {
      if (spec.startsWith(prefix)) bases.push(join(absRoot, dir, spec.slice(prefix.length)))
    }
    const src = nearestSrc(from)
    if (spec.startsWith('@/') && src) bases.push(join(src, spec.slice(2)))
    for (const base of bases) {
      for (const c of candidates(base)) {
        const sf = files.get(c)
        if (sf && existsSync(c)) return sf
      }
    }
    return null
  }
  return { root: absRoot, files, filesScanned: paths.length, resolveModule }
}
