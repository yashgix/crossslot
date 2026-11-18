import { allDone } from './settle.js'
import { Cluster, Redis } from 'ioredis'
import { createClient, createCluster } from 'redis'
import { EXIT, ExitError } from '../errors.js'
import { type Seed, clusterSeeds, standaloneUrl } from '../net.js'
import { HarnessError } from './errors.js'

const CONNECT_MS = 3000
const VERIFY_MS = 10_000
const retry = (times: number) => (times > 3 ? null : 200)
const nodeRetry = (times: number) => (times > 3 ? new Error('node unreachable') : 200)

export type Cmd = string[]

export interface StreamRead {
  key: string
  entries: Array<{ id: string; fields: Array<[string, string]> }>
}

/** What a driver may ask of a client library, the same for ioredis and node-redis. */
export interface Conn {
  eval: (script: string, keys: string[], args: string[]) => Promise<unknown>
  evalsha: (sha: string, keys: string[], args: string[]) => Promise<unknown>
  run: (cmd: Cmd) => Promise<unknown>
  transaction: (cmds: Cmd[]) => Promise<unknown[]>
  pipeline: (cmds: Cmd[]) => Promise<unknown[]>
  xread: (
    streams: Array<{ key: string; id: string }>,
    opts: { count: number }
  ) => Promise<StreamRead[] | null>
}

/** ioredis batches address commands by their lower-case method names. */
const methodNames = (cmds: Cmd[]) =>
  cmds.map(([name, ...args]) => [(name as string).toLowerCase(), ...args])

function settle(results: Array<[Error | null, unknown]> | null): unknown[] {
  if (!results) throw new HarnessError('transaction aborted')
  return results.map(([err, value]) => {
    if (err) throw err
    return value
  })
}

class IoConn implements Conn {
  constructor(private readonly r: Redis | Cluster) {}

  eval(script: string, keys: string[], args: string[]) {
    return this.r.eval(script, keys.length, ...keys, ...args)
  }

  evalsha(sha: string, keys: string[], args: string[]) {
    return this.r.evalsha(sha, keys.length, ...keys, ...args)
  }

  run([name, ...args]: Cmd) {
    return this.r.call(name as string, ...args)
  }

  async transaction(cmds: Cmd[]) {
    return settle(await this.r.multi(methodNames(cmds)).exec())
  }

  async pipeline(cmds: Cmd[]) {
    return settle(await this.r.pipeline(methodNames(cmds)).exec())
  }

  async xread(streams: Array<{ key: string; id: string }>, opts: { count: number }) {
    const args: string[] = ['COUNT', String(opts.count)]
    const raw = (await this.r.call(
      'XREAD',
      ...args,
      'STREAMS',
      ...streams.map((s) => s.key),
      ...streams.map((s) => s.id)
    )) as Array<[string, Array<[string, string[]]>]> | null
    return (
      raw?.map(([key, entries]) => ({
        key,
        entries: entries.map(([id, flat]) => ({ id, fields: pairs(flat) })),
      })) ?? null
    )
  }
}

function pairs(flat: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i] as string, flat[i + 1] as string])
  return out
}

type NodeClient = ReturnType<typeof createClient>
type NodeCluster = ReturnType<typeof createCluster>

class NodeConn implements Conn {
  constructor(private readonly c: NodeClient | NodeCluster) {}

  private get cluster(): NodeCluster | null {
    return 'masters' in this.c ? (this.c as NodeCluster) : null
  }

  eval(script: string, keys: string[], args: string[]) {
    return this.c.eval(script, { keys, arguments: args })
  }

  evalsha(sha: string, keys: string[], args: string[]) {
    return this.c.evalSha(sha, { keys, arguments: args })
  }

  run(cmd: Cmd) {
    const cluster = this.cluster
    return cluster
      ? cluster.sendCommand(cmd[1], false, cmd)
      : (this.c as NodeClient).sendCommand(cmd)
  }

  async transaction(cmds: Cmd[]) {
    const cluster = this.cluster
    if (cluster) {
      const multi = cluster.multi(cmds[0]?.[1])
      for (const cmd of cmds) multi.addCommand(cmd[1], false, cmd)
      return (await multi.exec()) as unknown[]
    }
    const multi = (this.c as NodeClient).multi()
    for (const cmd of cmds) multi.addCommand(cmd)
    return (await multi.exec()) as unknown[]
  }

  pipeline(cmds: Cmd[]) {
    return this.transaction(cmds)
  }

  async xread(streams: Array<{ key: string; id: string }>, opts: { count: number }) {
    const raw = (await this.c.xRead(streams, { COUNT: opts.count })) as Array<{
      name: string
      messages: Array<{ id: string; message: Record<string, string> }>
    }> | null
    return (
      raw?.map((s) => ({
        key: s.name,
        entries: s.messages.map((m) => ({ id: m.id, fields: Object.entries(m.message) })),
      })) ?? null
    )
  }
}

/** A Redis deployment under test: one standalone node (in a chosen database) or the cluster. */
export class Target {
  private io: Redis | Cluster | null = null
  private node: Promise<NodeClient | NodeCluster> | null = null

  private constructor(
    readonly mode: 'standalone' | 'cluster',
    private readonly db: number
  ) {}

  static standalone(db: number): Target {
    return new Target('standalone', db)
  }

  static cluster(): Target {
    return new Target('cluster', 0)
  }

  private seeds(): Seed[] {
    return this.mode === 'cluster' ? clusterSeeds() : []
  }

  private async ioredis(): Promise<Redis | Cluster> {
    if (this.io) return this.io
    if (this.mode === 'cluster') {
      this.io = new Cluster(this.seeds(), {
        clusterRetryStrategy: retry,
        redisOptions: { connectTimeout: CONNECT_MS, maxRetriesPerRequest: 1 },
      })
    } else {
      const url = standaloneUrl()
      this.io = new Redis({
        host: url.hostname,
        port: Number(url.port),
        db: this.db,
        connectTimeout: CONNECT_MS,
        retryStrategy: retry,
        maxRetriesPerRequest: 1,
      })
    }
    this.io.on('error', () => {})
    return this.io
  }

  private nodeRedis(): Promise<NodeClient | NodeCluster> {
    this.node ??= this.openNodeRedis()
    return this.node
  }

  private async openNodeRedis(): Promise<NodeClient | NodeCluster> {
    const client =
      this.mode === 'cluster'
        ? createCluster({
            rootNodes: this.seeds().map((s) => ({ url: `redis://${s.host}:${s.port}` })),
            defaults: { socket: { connectTimeout: CONNECT_MS, reconnectStrategy: nodeRetry } },
          })
        : createClient({
            url: `redis://${standaloneUrl().hostname}:${standaloneUrl().port}`,
            database: this.db,
            socket: { connectTimeout: CONNECT_MS, reconnectStrategy: nodeRetry },
          })
    client.on('error', () => {})
    try {
      await client.connect()
    } catch (error) {
      throw new ExitError(EXIT.docker, `Redis is unreachable: ${(error as Error).message}`)
    }
    return client
  }

  async conn(client: 'ioredis' | 'node-redis'): Promise<Conn> {
    return client === 'ioredis'
      ? new IoConn(await this.ioredis())
      : new NodeConn(await this.nodeRedis())
  }

  /** Fails with exit 4, naming the node, when a node does not answer within the deadline. */
  async verify(): Promise<void> {
    const io = await this.ioredis()
    const answer = async (name: string, node: Redis) => {
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), VERIFY_MS)
      })
      try {
        await Promise.race([node.ping(), timeout])
      } catch (error) {
        throw new ExitError(
          EXIT.docker,
          `Redis node ${name} is unavailable: ${(error as Error).message}`
        )
      } finally {
        clearTimeout(timer)
      }
    }
    if (!(io instanceof Cluster)) return answer(`${standaloneUrl().host} db ${this.db}`, io)
    await answer('cluster', io as unknown as Redis)
    await allDone(io.nodes('all').map((n) => answer(`${n.options.host}:${n.options.port}`, n)))
  }

  /** Loads a script on every primary, once the cluster is known, and checks each has it. */
  async loadScript(script: string): Promise<string> {
    await this.verify()
    const io = await this.ioredis()
    const nodes = io instanceof Cluster ? io.nodes('master') : [io]
    const expected = io instanceof Cluster ? await this.primaryCount(io) : 1
    if (nodes.length !== expected) {
      throw new HarnessError(`script load saw ${nodes.length} of ${expected} primaries`)
    }
    const shas = await allDone(nodes.map((n) => n.script('LOAD', script) as Promise<string>))
    const sha = shas[0] as string
    const present = await allDone(nodes.map((n) => n.script('EXISTS', sha) as Promise<number[]>))
    if (shas.some((x) => x !== sha) || present.some((p) => p[0] !== 1)) {
      throw new HarnessError('a primary did not keep the loaded script')
    }
    return sha
  }

  private async primaryCount(io: Cluster): Promise<number> {
    const nodes = (await io.cluster('NODES')) as string
    return nodes.split('\n').filter((l) => /\bmaster\b/.test(l) && !/\bfail/.test(l)).length
  }

  async version(): Promise<string> {
    const info = await (await this.ioredis()).info('server')
    return /redis_version:(\S+)/.exec(info)?.[1] ?? 'unknown'
  }

  async close(): Promise<void> {
    this.io?.disconnect()
    if (this.node) await (await this.node).destroy()
  }
}
