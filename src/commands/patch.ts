import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { usage } from '../errors.js'
import { applyHunks, parsePatch } from '../patch/unified.js'

/** A corpus is plain files: a symlink could point a write outside the output tree. */
function rejectSymlinks(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const info = lstatSync(path)
    if (info.isSymbolicLink()) throw usage(`corpus contains a symlink: ${path}`)
    if (info.isDirectory()) rejectSymlinks(path)
  }
}

/** The file to write, after its real path is checked to stay inside the output tree. */
function containedTarget(out: string, path: string): string {
  const target = join(out, path)
  if (!existsSync(target)) throw usage(`patch target is missing: ${path}`)
  const root = realpathSync(out) + sep
  if (lstatSync(target).isSymbolicLink() || !realpathSync(target).startsWith(root)) {
    throw usage(`patch target leaves the output tree: ${path}`)
  }
  return target
}

export async function patchCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  const { values } = parseArgs({
    args: rest,
    options: { corpus: { type: 'string' }, patch: { type: 'string' }, out: { type: 'string' } },
  })
  if (sub !== 'apply' || !values.corpus || !values.patch || !values.out) {
    throw usage('patch apply --corpus DIR --patch FILE --out DIR')
  }
  if (!existsSync(values.corpus) || !statSync(values.corpus).isDirectory())
    throw usage(`not a directory: ${values.corpus}`)
  if (!existsSync(values.patch)) throw usage(`no such patch: ${values.patch}`)
  if (existsSync(values.out)) throw usage(`output exists: ${values.out}`)
  const files = parsePatch(readFileSync(values.patch, 'utf8'))
  rejectSymlinks(values.corpus)
  cpSync(values.corpus, values.out, { recursive: true })
  try {
    for (const { path, hunks } of files) {
      const target = containedTarget(values.out, path)
      writeFileSync(target, applyHunks(path, readFileSync(target, 'utf8'), hunks))
    }
  } catch (error) {
    rmSync(values.out, { recursive: true, force: true })
    throw error
  }
  console.log(`patched ${files.length} files into ${values.out}`)
}
