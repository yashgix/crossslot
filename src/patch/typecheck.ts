import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const require = createRequire(import.meta.url)

function packageDir(name: string): string {
  return dirname(require.resolve(`${name}/package.json`))
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) tsFiles(full, out)
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

/** The files of `patched` whose text differs from the same path in `original`. */
export function changedFiles(original: string, patched: string): string[] {
  return tsFiles(patched).filter((file) => {
    try {
      return readFileSync(join(original, relative(patched, file)), 'utf8') !== readFileSync(file, 'utf8')
    } catch {
      return true
    }
  })
}

function diagnosticsOf(root: string, files: string[]): Map<string, number> {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    baseUrl: root,
    paths: {
      redis: [packageDir('redis')],
      ioredis: [packageDir('ioredis')],
      '@/*': ['apps/sim/*', 'apps/realtime/src/*'],
    },
    types: [],
  }
  const program = ts.createProgram(files.map((f) => join(root, relative(root, f))), options)
  const counts = new Map<string, number>()
  for (const file of files) {
    const sf = program.getSourceFile(join(root, relative(root, file)))
    if (!sf) continue
    const all = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]
    for (const d of all) {
      const text = ts.flattenDiagnosticMessageText(d.messageText, ' ')
      const key = `${relative(root, file)} TS${d.code} ${text}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

/**
 * Type errors the patch adds to the files it changes. Imports the corpus does not contain stay
 * unresolved on both sides, so only the difference between the two trees is reported.
 */
export function introducedTypeErrors(original: string, patched: string): string[] {
  const changed = changedFiles(original, patched).map((f) => resolve(f))
  if (changed.length === 0) return []
  const before = diagnosticsOf(resolve(original), changed.map((f) => join(resolve(original), relative(resolve(patched), f))))
  const after = diagnosticsOf(resolve(patched), changed)
  return [...after].filter(([key, n]) => n > (before.get(key) ?? 0)).map(([key]) => key)
}
