import { describe, expect, it } from 'vitest'
import { CLUSTER, cli } from '../../helpers'

const seeds = process.env.CROSSSLOT_CLUSTER_SEEDS ?? '127.0.0.1:7001'

describe.skipIf(!CLUSTER)('cluster rig (needs Docker, CROSSSLOT_CLUSTER_TESTS=1)', () => {
  it('R-1 cluster up gives 3 primaries, 3 replicas, 16384 slots, state ok', () => {
    expect(cli(['cluster', 'up']).code).toBe(0)
    const r = cli(['cluster', 'status', '--json'])
    expect(r.code).toBe(0)
    const status = JSON.parse(r.stdout)
    expect(status).toMatchObject({ nodes: 6, primaries: 3, replicas: 3, slotsAssigned: 16384, state: 'ok' })
    expect(status.image).toMatch(/^redis:8\.10\.3@sha256:1f88291b4c57bdf249f02eb085a8669889b2d2954e91d4de5118a5da6b78dd53$/)
  })

  it('R-4 a plain cluster client reaches every primary from the host with no NAT map', async () => {
    const { Cluster } = await import('ioredis')
    const [host, port] = seeds.split(',')[0].split(':')
    const cluster = new Cluster([{ host, port: Number(port) }])
    try {
      const keys = Array.from({ length: 300 }, (_, i) => `acc:r4:${i}`)
      await Promise.all(keys.map((k) => cluster.set(k, k)))
      const values = await Promise.all(keys.map((k) => cluster.get(k)))
      expect(values).toEqual(keys)
      expect(cluster.nodes('master')).toHaveLength(3)
      expect(cluster.nodes('slave')).toHaveLength(3)
      await Promise.all(keys.map((k) => cluster.del(k)))
    } finally {
      cluster.disconnect()
    }
  })

  it('R-3 down removes the cluster and up works again', () => {
    expect(cli(['cluster', 'down']).code).toBe(0)
    expect(cli(['cluster', 'status', '--json']).code).toBe(4)
    expect(cli(['cluster', 'up']).code).toBe(0)
    expect(JSON.parse(cli(['cluster', 'status', '--json']).stdout).state).toBe('ok')
  })
})
