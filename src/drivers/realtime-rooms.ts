import type { Rng } from '../diff/rng.js'
import type { Driver, Selector, Step, Values } from '../diff/types.js'
import { episodes, pairsToObject, parseJson } from './kit.js'

const FILE = 'apps/realtime/src/rooms/redis-manager.ts'
const ADD: Selector = { file: FILE, fn: 'addUserToRoom' }
const REMOVE: Selector = { file: FILE, fn: 'removeUserFromRoom', kind: 'evalsha' }
const DELETE_ROOM: Selector = { file: FILE, fn: 'deleteRoom' }
const ACTIVITY: Selector = { file: FILE, fn: 'updateUserActivity', kind: 'evalsha' }
const TYPES = ['workflow', 'table', 'file', 'knowledge']
const NOW = '1700000000000'
const TTL_MS = 86_400_000

interface Room {
  type: string
  id: string
}

const roomEnt = (r: Room) => `room:${r.type}:${r.id}`

function values(socketId: string, room: Room, extra: Values = {}): Values {
  const userId = `user-${socketId}`
  const presence = { userId, userName: `Name ${userId}`, socketId, lastActivity: Number(NOW) }
  return {
    socketId,
    'room.type': room.type,
    'room.id': room.id,
    'JSON.stringify(presence)': JSON.stringify(presence),
    'Date.now().toString()': NOW,
    'presence.userId': presence.userId,
    'presence.userName': presence.userName,
    "presence.avatarUrl || ''": '',
    ...extra,
  }
}

function activityValues(socketId: string, room: Room, rng: Rng): Values {
  const field = (name: string, value: unknown) => [
    `serializePresenceField('${name}', updates.${name}, socketId)`,
    value ? JSON.stringify(value) : '',
  ]
  return values(socketId, room, {
    ...Object.fromEntries([
      field('cursor', rng.chance(0.7) && { x: rng.int(0, 99), y: rng.int(0, 99) }),
      field('selection', rng.chance(0.4) && { from: rng.int(0, 9), to: rng.int(10, 20) }),
      field('cell', rng.chance(0.3) && { row: rng.int(0, 9), col: rng.int(0, 9) }),
    ]),
    '(updates.lastActivity ?? Date.now()).toString()': String(Number(NOW) + rng.int(1, 999)),
    'SOCKET_ROOMS_TTL.toString()': '86400',
    'SESSION_TTL.toString()': '86400',
  })
}

function episode(rng: Rng, seed: string, index: number): Step[] {
  const socketId = `sock${seed}-${index}`
  const rooms: Room[] = rng
    .sample(TYPES, rng.int(1, 3))
    .map((type) => ({ type, id: `r${seed}-${index}-${type}` }))
  const ents = (room: Room) => [socketId, roomEnt(room)]
  const join = (room: Room): Step => ({
    ents: ents(room),
    // The patched corpus splits this into two transactions, so only the resulting state is compared.
    run: async (c) => void (await c.replay(ADD, values(socketId, room))),
    repair: (c) => c.replayEach(ADD, values(socketId, room)),
  })
  const activity = (room: Room): Step => {
    const v = activityValues(socketId, room, rng)
    return { ents: ents(room), run: (c) => c.eval(ACTIVITY, v) }
  }
  const leave = (room: Room): Step => ({
    ents: ents(room),
    run: (c) => c.eval(REMOVE, values(socketId, room)),
  })
  const out: Step[] = rooms.map(join)
  out.push(...rooms.map(activity), leave(rooms[0] as Room))
  for (const room of rooms.slice(1)) out.push(activity(room), leave(room))
  if (rng.chance(0.3))
    out.push({
      ents: ents(rooms[0] as Room),
      run: (c) => c.multikeyAt(DELETE_ROOM, values(socketId, rooms[0] as Room)),
    })
  return out
}

export const realtimeRooms: Driver = {
  name: 'realtime-rooms',
  controls: false,
  client: 'node-redis',
  sites: [ADD, REMOVE, DELETE_ROOM, ACTIVITY],
  plan: (rng, ops, seed) => {
    const known = new Map<string, Room>()
    const steps = episodes(ops, (i) => {
      const made = episode(rng, seed, i)
      return made
    })
    for (const ent of steps.flatMap((s) => s.ents).filter((e) => e.startsWith('room:'))) {
      const [, type, id] = ent.split(':') as [string, string, string]
      known.set(ent, { type, id })
    }
    return {
      steps,
      observe: async (c, ent) => {
        const room = known.get(ent)
        if (room) return observeRoom(c, room)
        return observeSocket(c, ent)
      },
    }
  },
}

async function observeRoom(c: import('../diff/ctx.js').Ctx, room: Room) {
  const v = values('x', room)
  const users = await c.run('HGETALL', c.helperKey(FILE, 'KEYS.roomUsers', v))
  const parsed = Object.fromEntries(
    Object.entries(pairsToObject(users)).map(([k, json]) => [k, parseJson(json)])
  )
  return [parsed, await c.run('EXISTS', c.helperKey(FILE, 'KEYS.roomMeta', v))]
}

async function observeSocket(c: import('../diff/ctx.js').Ctx, socketId: string) {
  const v: Values = { socketId }
  const rooms = pairsToObject(await c.run('HGETALL', c.helperKey(FILE, 'KEYS.socketRooms', v)))
  const session = c.helperKey(FILE, 'KEYS.socketSession', v)
  return [
    rooms,
    await c.run('EXISTS', session),
    pairsToObject(await c.run('HGETALL', session)),
    await c.ttlState(session, TTL_MS),
  ]
}
