import { readFileSync } from 'node:fs'
import { Cluster, Redis } from 'ioredis'

export const SIM_COMMIT = 'edf5f0a47da8147466cb893c0a1666058331d42e'
export const STANDALONE = { host: '127.0.0.1', port: 7100 }
export const SEEDS = [{ host: '127.0.0.1', port: 7001 }]

export const simSource = (file: string) =>
  readFileSync(new URL(`../data/sim/${file}`, import.meta.url), 'utf8')

export function header(title: string, sites: string[]): void {
  console.log(`== ${title}`)
  console.log(`Sim ${SIM_COMMIT}`)
  for (const site of sites) console.log(`  ${site}`)
}

type Slots = [number, number, [string, number]][]

/** Asks the cluster itself (CLUSTER KEYSLOT, CLUSTER SLOTS), so no slot is computed by this script. */
export async function printSlots(cluster: Cluster, keys: string[]): Promise<void> {
  const ranges = (await cluster.cluster('SLOTS')) as Slots
  console.log('  keys, hash slots (CLUSTER KEYSLOT) and the primary that owns each slot:')
  for (const key of keys) {
    const slot = Number(await cluster.cluster('KEYSLOT', key))
    const owner = ranges.find(([from, to]) => slot >= from && slot <= to)?.[2]
    console.log(`    slot ${String(slot).padStart(5)}  ${owner?.[0]}:${owner?.[1]}  ${key}`)
  }
}

export const message = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

export function ioStandalone(): Redis {
  const client = new Redis({ ...STANDALONE, maxRetriesPerRequest: 1 })
  client.on('error', () => {})
  return client
}

export function ioCluster(): Cluster {
  const client = new Cluster(SEEDS, {
    clusterRetryStrategy: () => null,
    redisOptions: { maxRetriesPerRequest: 1 },
  })
  client.on('error', () => {})
  return client
}

let failures = 0

/** Prints one PASS or FAIL line per case and remembers failures for `finish`. */
export function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`)
}

const DEADLINE_MS = 60_000

/** Runs a script body, treating a setup error or a hang as a failure, and sets the exit code. */
export async function main(body: () => Promise<void>): Promise<void> {
  // A client that cannot connect may retry forever, so the whole run has a deadline.
  const deadline = setTimeout(() => {
    check('setup', false, `no result within ${DEADLINE_MS / 1000} s (is every Redis node up?)`)
    process.exit(1)
  }, DEADLINE_MS)
  try {
    await body()
  } catch (error) {
    check('setup', false, message(error))
  } finally {
    clearTimeout(deadline)
  }
  if (failures > 0) {
    process.exitCode = 1
    // A client that cannot connect keeps retrying, so do not wait for it to give up.
    setTimeout(() => process.exit(1), 200).unref()
  }
}
