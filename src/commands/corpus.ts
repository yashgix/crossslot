import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, normalize, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { EXIT, ExitError, usage } from '../errors.js'

const RAW_BASE =
  'https://raw.githubusercontent.com/simstudioai/sim/edf5f0a47da8147466cb893c0a1666058331d42e/'

interface Entry {
  sha256: string
  path: string
}

function readManifest(file: string): Entry[] {
  const text = readFileSync(file, 'utf8')
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line) => {
      const m = /^([0-9a-f]{64}) {2}\.\/(.+)$/.exec(line)
      if (!m) throw usage(`bad manifest line: ${line}`)
      return { sha256: m[1] as string, path: m[2] as string }
    })
}

/** Joins a manifest path under dir and refuses anything that leaves it. */
function inside(dir: string, path: string): string {
  const full = resolve(dir, normalize(path))
  if (path.split('/').includes('..') || !full.startsWith(resolve(dir) + sep)) {
    throw usage(`manifest path escapes the directory: ${path}`)
  }
  return full
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function verify(dir: string, manifest: string): number {
  const entries = readManifest(manifest)
  const targets = entries.map((e) => ({ ...e, full: inside(dir, e.path) }))
  for (const { full, path, sha256: want } of targets) {
    let got: string
    try {
      got = sha256(readFileSync(full))
    } catch {
      throw new ExitError(EXIT.corpus, `missing file: ${path}`)
    }
    if (got !== want) throw new ExitError(EXIT.corpus, `hash mismatch: ${path}`)
  }
  return entries.length
}

async function fetchFile(entry: Entry, dir: string): Promise<void> {
  const full = inside(dir, entry.path)
  const res = await fetch(RAW_BASE + entry.path)
  if (!res.ok) throw new ExitError(EXIT.corpus, `download failed (${res.status}): ${entry.path}`)
  const body = Buffer.from(await res.arrayBuffer())
  if (sha256(body) !== entry.sha256)
    throw new ExitError(EXIT.corpus, `hash mismatch: ${entry.path}`)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, body)
}

export async function corpusCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  const { values } = parseArgs({
    args: rest,
    options: { dir: { type: 'string' }, out: { type: 'string' }, manifest: { type: 'string' } },
  })
  if (!values.manifest) throw usage('corpus needs --manifest FILE')
  if (sub === 'verify') {
    if (!values.dir) throw usage('corpus verify needs --dir DIR')
    console.log(`ok ${verify(values.dir, values.manifest)} files`)
  } else if (sub === 'fetch') {
    if (!values.out) throw usage('corpus fetch needs --out DIR')
    const entries = readManifest(values.manifest)
    for (const e of entries) await fetchFile(e, values.out)
    console.log(`ok ${verify(values.out, values.manifest)} files`)
  } else {
    throw usage('corpus <verify|fetch>')
  }
}
