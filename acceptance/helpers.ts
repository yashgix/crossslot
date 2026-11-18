import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
export const CORPUS = resolve(ROOT, process.env.CROSSSLOT_CORPUS ?? 'data/sim')
export const MANIFEST = resolve(ROOT, 'data/MANIFEST.sha256')
export const PATCH = resolve(ROOT, 'patch/crossslot.patch')
export const CLUSTER = process.env.CROSSSLOT_CLUSTER_TESTS === '1'

export interface Run {
  code: number
  stdout: string
  stderr: string
}

export function cli(args: string[], env: Record<string, string> = {}, timeoutMs = 600_000): Run {
  const r = spawnSync('node', [join(ROOT, 'dist/cli.js'), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  })
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

export async function lib(): Promise<{
  slotOf: (key: string) => number
  scanTree: (root: string, opts?: { alias?: Record<string, string> }) => Promise<any>
}> {
  return import(pathToFileURL(join(ROOT, 'dist/index.js')).href)
}

export function tmp(prefix = 'crossslot-acc-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function writeTree(files: Record<string, string>): string {
  const dir = tmp()
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
  return dir
}

export function copyTree(from: string): string {
  const dir = tmp()
  cpSync(from, dir, { recursive: true })
  return dir
}

export function readJson<T = any>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** Scan a directory through the CLI and return the parsed result. */
export function scanCli(root: string, extra: string[] = []): { run: Run; result: any; json: string } {
  const json = join(tmp(), 'sites.json')
  const run = cli(['scan', '--root', root, '--json', json, ...extra])
  return { run, result: existsSync(json) ? readJson(json) : null, json }
}

/** 1-based line of the first line of `src` containing `needle`. */
export function lineOf(src: string, needle: string): number {
  const i = src.split('\n').findIndex((l) => l.includes(needle))
  if (i < 0) throw new Error(`needle not found: ${needle}`)
  return i + 1
}

export function siteAt(result: any, file: string, line: number): any | undefined {
  return result.sites.find((s: any) => s.file === file && s.line === line)
}

export function errorCodes(site: any): string[] {
  return site.hazards.filter((h: any) => h.severity === 'error').map((h: any) => h.code)
}

export const M1_DRIVERS = [
  'hosted-queue',
  'realtime-rooms',
  'token-bucket',
  'approval-store',
  'usage-segment-cache',
  'outbox-prune-cursors',
  'stream-abort-locks',
  'slack-stream-sessions',
  'lock',
  'otp',
  'idempotency',
  'file-doc-store',
  'file-doc-reader',
]
export const CONTROL_DRIVERS = ['lock', 'otp', 'idempotency']

/** Apply the shipped patch to the corpus and return the patched tree. */
export function patchedCorpus(): string {
  const out = join(tmp(), 'patched')
  const r = cli(['patch', 'apply', '--corpus', CORPUS, '--patch', PATCH, '--out', out])
  if (r.code !== 0) throw new Error(`patch apply failed: ${r.stderr}`)
  return out
}

/** UNFIXED lines of patch/NOTES.md: `UNFIXED: <driver> <error class> <reason>`. */
export function unfixed(): Array<{ driver: string; cls: string }> {
  const text = readFileSync(resolve(ROOT, 'patch/NOTES.md'), 'utf8')
  return [...text.matchAll(/^UNFIXED:\s+(\S+)\s+(\S+)\s+\S+/gm)].map((m) => ({ driver: m[1], cls: m[2] }))
}

export function unfixedDrivers(): string[] {
  return unfixed().map((u) => u.driver)
}
