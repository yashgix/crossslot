import { usage } from './errors.js'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function assertLoopback(host: string, what: string): void {
  if (!LOOPBACK.has(host)) throw usage(`${what} must be a loopback host, got ${host}`)
}

export function standaloneUrl(): URL {
  const url = new URL(process.env.CROSSSLOT_STANDALONE_URL ?? 'redis://127.0.0.1:7100')
  assertLoopback(url.hostname, 'CROSSSLOT_STANDALONE_URL')
  return url
}

export interface Seed {
  host: string
  port: number
}

export function clusterSeeds(): Seed[] {
  const raw = process.env.CROSSSLOT_CLUSTER_SEEDS ?? '127.0.0.1:7001'
  return raw.split(',').map((entry) => {
    const at = entry.lastIndexOf(':')
    const host = entry.slice(0, at)
    const port = Number(entry.slice(at + 1))
    assertLoopback(host, 'CROSSSLOT_CLUSTER_SEEDS')
    if (!Number.isInteger(port)) throw usage(`bad cluster seed: ${entry}`)
    return { host, port }
  })
}
