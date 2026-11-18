import type { Driver } from '../diff/types.js'
import { usage } from '../errors.js'
import { approvalStore } from './approval-store.js'
import { fileDocReader } from './file-doc-reader.js'
import { fileDocStore } from './file-doc-store.js'
import { hostedQueue } from './hosted-queue.js'
import { idempotency } from './idempotency.js'
import { lock } from './lock.js'
import { otp } from './otp.js'
import { outboxPruneCursors } from './outbox-prune-cursors.js'
import { realtimeRooms } from './realtime-rooms.js'
import { slackStreamSessions } from './slack-stream-sessions.js'
import { streamAbortLocks } from './stream-abort-locks.js'
import { tokenBucket } from './token-bucket.js'
import { usageSegmentCache } from './usage-segment-cache.js'

export const DRIVERS: Driver[] = [
  hostedQueue,
  realtimeRooms,
  tokenBucket,
  approvalStore,
  usageSegmentCache,
  outboxPruneCursors,
  streamAbortLocks,
  slackStreamSessions,
  lock,
  otp,
  idempotency,
  fileDocStore,
  fileDocReader,
]

export function selectDrivers(spec: string): Driver[] {
  if (spec === 'all') return DRIVERS
  return spec.split(',').map((name) => {
    const found = DRIVERS.find((d) => d.name === name)
    if (!found) throw usage(`unknown driver: ${name}`)
    return found
  })
}
