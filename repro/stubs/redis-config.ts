import type { Cluster, Redis } from 'ioredis'

type Client = Redis | Cluster
let client: Client | null = null

export const setRedisClient = (next: Client | null) => {
  client = next
}
export const getRedisClient = () => client
