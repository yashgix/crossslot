import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Redis } from 'ioredis'
import { EXIT, ExitError } from '../errors.js'
import { clusterSeeds } from '../net.js'

const PROJECT = 'crossslot'
const COMPOSE_FILE = fileURLToPath(new URL('../../compose.yaml', import.meta.url))
const UP_TIMEOUT_MS = 90_000

export interface ClusterStatus {
  nodes: number
  primaries: number
  replicas: number
  slotsAssigned: number
  state: string
  image: string
}

function docker(args: string[]): { code: number; out: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8' })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const compose = (args: string[]) => docker(['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...args])

function requireDocker(): void {
  if (docker(['info', '--format', '{{.ServerVersion}}']).code !== 0) {
    throw new ExitError(EXIT.docker, 'Docker is not running')
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function withNode<T>(port: number, fn: (r: Redis) => Promise<T>): Promise<T> {
  const r = new Redis({
    host: '127.0.0.1',
    port,
    lazyConnect: true,
    retryStrategy: () => null,
    maxRetriesPerRequest: 0,
  })
  r.on('error', () => {})
  try {
    await r.connect()
    return await fn(r)
  } finally {
    r.disconnect()
  }
}

async function waitFor(
  what: string,
  check: () => Promise<boolean>,
  deadline: number
): Promise<void> {
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await sleep(500)
  }
  throw new ExitError(EXIT.docker, `timed out waiting for ${what}`)
}

const clusterInfo = async (port: number) =>
  withNode(port, (r) => r.cluster('INFO') as Promise<string>)

async function isFormed(port: number): Promise<boolean> {
  const info = await clusterInfo(port)
  return info.includes('cluster_state:ok') && info.includes('cluster_known_nodes:6')
}

/** Counts the node endpoints CLUSTER SLOTS lists, which includes a replica only once it is usable. */
async function endpointsInSlots(port: number): Promise<number> {
  const ranges = (await withNode(port, (r) => r.cluster('SLOTS'))) as unknown[][]
  return ranges.reduce((total, range) => total + range.length - 2, 0)
}

function createCluster(): void {
  const script =
    'redis-cli --cluster create $(for h in n1 n2 n3 n4 n5 n6; do echo $(getent hosts $h | cut -d" " -f1):700${h#n}; done) --cluster-replicas 1 --cluster-yes'
  const r = compose(['exec', '-T', 'n1', 'sh', '-c', script])
  if (r.code !== 0) throw new ExitError(EXIT.docker, `cluster create failed: ${r.out.slice(-400)}`)
}

export async function clusterUp(): Promise<void> {
  requireDocker()
  const started = compose(['up', '-d'])
  if (started.code !== 0)
    throw new ExitError(EXIT.docker, `compose up failed: ${started.out.slice(-400)}`)
  const deadline = Date.now() + UP_TIMEOUT_MS
  const ports = [1, 2, 3, 4, 5, 6].map((i) => 7000 + i)
  await waitFor(
    'nodes to answer',
    async () => (await Promise.all(ports.map((p) => withNode(p, (r) => r.ping())))).length === 6,
    deadline
  )
  if (!(await isFormed(7001).catch(() => false))) createCluster()
  await waitFor(
    'cluster_state:ok on every node',
    async () => (await Promise.all(ports.map(isFormed))).every(Boolean),
    deadline
  )
  await waitFor('replicas to attach', async () => (await endpointsInSlots(7001)) === 6, deadline)
}

export function clusterDown(): void {
  requireDocker()
  const r = compose(['down', '-v'])
  if (r.code !== 0) throw new ExitError(EXIT.docker, `compose down failed: ${r.out.slice(-400)}`)
}

function imageOfNode(): string {
  const id = compose(['ps', '-q', 'n1']).out.trim()
  const r = docker(['inspect', '--format', '{{.Config.Image}}', id])
  return r.code === 0 ? r.out.trim() : ''
}

export async function status(): Promise<ClusterStatus> {
  const seed = clusterSeeds()[0]
  if (!seed) throw new ExitError(EXIT.docker, 'no cluster seed configured')
  const { info, nodes } = await withNode(seed.port, async (r) => ({
    info: (await r.cluster('INFO')) as string,
    nodes: (await r.cluster('NODES')) as string,
  })).catch(() => {
    throw new ExitError(EXIT.docker, `cluster node ${seed.host}:${seed.port} is not reachable`)
  })
  const lines = nodes.split('\n').filter((l) => l.trim() !== '')
  const fields = new Map(info.split('\r\n').map((l) => l.split(':') as [string, string]))
  const result: ClusterStatus = {
    nodes: lines.length,
    primaries: lines.filter((l) => l.split(' ')[2]?.includes('master')).length,
    replicas: lines.filter((l) => l.split(' ')[2]?.includes('slave')).length,
    slotsAssigned: Number(fields.get('cluster_slots_assigned')),
    state: fields.get('cluster_state') ?? '',
    image: imageOfNode(),
  }
  if (result.state !== 'ok') throw new ExitError(EXIT.docker, `cluster state is ${result.state}`)
  return result
}
