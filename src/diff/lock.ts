import { randomUUID } from 'node:crypto'
import { EXIT, ExitError } from '../errors.js'
import type { Conn } from './conn.js'

const KEY = 'crossslot:run-lock'
const LEASE_MS = 30_000
const WAIT_MS = 20 * 60_000
const POLL_MS = 500

const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0`
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface Lease {
  /** True once a renewal failed or found the lease taken: the holder must stop starting work. */
  lost: boolean
}

interface Options {
  waitMs?: number
  leaseMs?: number
}

/**
 * Runs `work` while holding a lease on the reference Redis. Runs use separate key namespaces, but a second run on the same Redis still waits its turn so
 * they do not compete for the same nodes. If the lease cannot be
 * renewed the work is told to stop, finishes what is in flight, and the run fails.
 */
export async function withRunLock<T>(
  conn: Conn,
  work: (lease: Lease) => Promise<T>,
  { waitMs = WAIT_MS, leaseMs = LEASE_MS }: Options = {}
): Promise<T> {
  const token = randomUUID()
  const deadline = Date.now() + waitMs
  while ((await conn.run(['SET', KEY, token, 'NX', 'PX', String(leaseMs)])) !== 'OK') {
    if (Date.now() > deadline) {
      throw new ExitError(
        EXIT.failed,
        'another crossslot run holds this Redis and did not finish in time'
      )
    }
    await sleep(POLL_MS)
  }
  const lease: Lease = { lost: false }
  const renew = setInterval(() => {
    conn
      .eval(RENEW, [KEY], [token, String(leaseMs)])
      .then((kept) => void (lease.lost ||= Number(kept) !== 1))
      .catch(() => void (lease.lost = true))
  }, leaseMs / 3)
  try {
    const result = await work(lease)
    if (lease.lost)
      throw new ExitError(EXIT.failed, 'the run lost its lease on the reference Redis')
    return result
  } finally {
    clearInterval(renew)
    if (!lease.lost) await conn.eval(RELEASE, [KEY], [token]).catch(() => {})
  }
}
