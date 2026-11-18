import { createCluster } from 'redis'
import type { Server } from 'socket.io'
import { RedisRoomManager } from '../data/sim/apps/realtime/src/rooms/redis-manager.ts'
import { check, header, ioCluster, main, message, printSlots, simSource } from './common.ts'
import { logged } from './stubs/logger.ts'

const MANAGER = 'apps/realtime/src/rooms/redis-manager.ts'
const source = simSource(MANAGER)

/** Key formats at redis-manager.ts:26-29. Fails loudly if Sim changes them. */
for (const template of [
  '`${room.type}:${room.id}:users`',
  '`${room.type}:${room.id}:meta`',
  '`socket:${socketId}:rooms`',
  '`socket:${socketId}:session`',
])
  if (!source.includes(template)) throw new Error(`Sim no longer builds ${template}`)

// One workflow room, one socket (the key scheme comment at redis-manager.ts:19-25).
const room = { type: 'workflow', id: 'wf_4d7e91' }
const socketId = 'sock_Q8nv2'
const presence = { userId: 'user_17', userName: 'Ada', socketId, lastActivity: Date.now() }
const keys = [
  `${room.type}:${room.id}:users`,
  `${room.type}:${room.id}:meta`,
  `socket:${socketId}:rooms`,
  `socket:${socketId}:session`,
]

header('realtime rooms: RedisRoomManager (node-redis 5.10.0)', [
  'redis-manager.ts:243 addUserToRoom (MULTI), :281 removeUserFromRoom (EVALSHA, 4 keys),',
  '  :385 deleteRoom (DEL, 2 keys), :404 updateUserActivity (EVALSHA, 3 keys)',
  "Sim's real module. Stubbed, none touching Redis: @sim/logger (prints error lines),",
  '  @sim/realtime-protocol/rooms and @/rooms/presence-visibility (broadcast helpers, never called)',
  'standalone: the manager builds its own client with createClient({ url }) as Sim does.',
  'cluster: the same manager, its private `redis` field set to createCluster() (see README).',
])

type Call = [name: string, run: (manager: RedisRoomManager) => Promise<unknown>]
const calls: Call[] = [
  ['addUserToRoom (:243)', (m) => m.addUserToRoom(room, socketId, presence)],
  [
    'updateUserActivity (:404)',
    (m) => m.updateUserActivity(room, socketId, { cursor: { x: 1, y: 2 } }),
  ],
  ['removeUserFromRoom (:281)', (m) => m.removeUserFromRoom(room, socketId)],
  ['deleteRoom (:385)', (m) => m.deleteRoom(room)],
]
/** The error each call must end in on the cluster, found either as a throw or in Sim's own log. */
const EXPECTED = ['MOVED ', 'CROSSSLOT ', 'CROSSSLOT ', 'CROSSSLOT ']

/** Returns the thrown error message, the return value and what Sim logged during the call. */
async function attempt(fn: () => Promise<unknown>) {
  const before = logged.length
  let thrown: string | undefined
  let value: unknown
  try {
    value = await fn()
  } catch (error) {
    thrown = message(error)
  }
  return { thrown, value, logs: logged.slice(before) }
}

async function run(manager: RedisRoomManager, cluster: boolean): Promise<void> {
  await manager.initialize()
  for (const [i, [name, call]] of calls.entries()) {
    const { thrown, value, logs } = await attempt(() => call(manager))
    if (!cluster) {
      const ok = thrown === undefined && logs.length === 0 && value !== false
      check(
        `standalone ${name}`,
        ok,
        thrown ?? `returned ${JSON.stringify(value)}, no error logged`
      )
      continue
    }
    const text = `${thrown ?? ''} ${logs.join(' ')}`
    const found = text.includes(EXPECTED[i] as string)
    check(
      `cluster ${name}`,
      found,
      thrown ?? `returned ${JSON.stringify(value)}, logged ${logs.join(' | ')}`
    )
  }
}

const fakeIo = {} as Server
const slots = ioCluster()
const standalone = new RedisRoomManager(fakeIo, 'redis://127.0.0.1:7100')
const clustered = new RedisRoomManager(fakeIo, 'redis://127.0.0.1:7001')
const clusterClient = createCluster({ rootNodes: [{ url: 'redis://127.0.0.1:7001' }] })
clusterClient.on('error', () => {})
;(clustered as unknown as { redis: unknown }).redis = clusterClient
await main(async () => {
  try {
    await printSlots(slots, keys)
    await run(standalone, false)
    await standalone.deleteRoom(room).catch(() => {})
    await run(clustered, true)
  } finally {
    await standalone.shutdown()
    clusterClient.destroy()
    slots.disconnect()
  }
})
