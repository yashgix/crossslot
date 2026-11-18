import { usage } from '../errors.js'

interface Hunk {
  oldStart: number
  lines: string[]
}

export interface FilePatch {
  path: string
  hunks: Hunk[]
}

/** A patch path must stay inside the tree: relative, no `..`. */
function safePath(raw: string): string {
  const path = raw.replace(/^[ab]\//, '')
  if (path === '' || path.startsWith('/') || path.split('/').includes('..')) {
    throw usage(`patch path leaves the tree: ${raw}`)
  }
  return path
}

export function parsePatch(text: string): FilePatch[] {
  const files: FilePatch[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (line.startsWith('--- ')) {
      const target = lines[++i]
      if (!target?.startsWith('+++ ')) throw usage('patch: expected +++ after ---')
      if (line.includes('/dev/null') || target.includes('/dev/null')) throw usage('patch: creating or deleting files is not supported')
      files.push({ path: safePath(target.slice(4).split('\t')[0] as string), hunks: [] })
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line)
      const file = files[files.length - 1]
      if (!m || !file) throw usage(`patch: bad hunk header: ${line}`)
      const hunk: Hunk = { oldStart: Number(m[1]), lines: [] }
      let old = m[2] === undefined ? 1 : Number(m[2])
      let fresh = m[3] === undefined ? 1 : Number(m[3])
      while (old > 0 || fresh > 0) {
        const next = lines[++i]
        if (next === undefined) throw usage('patch: hunk is shorter than its header says')
        if (next.startsWith('\\')) continue
        if (next[0] !== '+') old--
        if (next[0] !== '-') fresh--
        hunk.lines.push(next)
      }
      file.hunks.push(hunk)
    }
  }
  if (files.length === 0) throw usage('patch: no files in patch')
  return files
}

/** Applies hunks with exact context at the stated line, no fuzz and no offset search. */
export function applyHunks(path: string, source: string, hunks: Hunk[]): string {
  const out = source.split('\n')
  let delta = 0
  for (const hunk of hunks) {
    const at = hunk.oldStart - 1 + delta
    const old = hunk.lines.filter((l) => l[0] !== '+').map((l) => l.slice(1))
    const fresh = hunk.lines.filter((l) => l[0] !== '-').map((l) => l.slice(1))
    if (old.some((l, k) => out[at + k] !== l)) throw usage(`patch does not apply cleanly: ${path} near line ${hunk.oldStart}`)
    out.splice(at, old.length, ...fresh)
    delta += fresh.length - old.length
  }
  return out.join('\n')
}
