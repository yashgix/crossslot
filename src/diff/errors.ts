import type { ErrorClass } from './report.js'

/** A fault in the harness itself, never counted as a Sim failure. */
export class HarnessError extends Error {}

export function classify(error: unknown): ErrorClass {
  const text = error instanceof Error ? error.message : String(error)
  if (/CROSSSLOT|do not hash to the same slot/i.test(text)) return 'CROSSSLOT'
  if (/^MOVED|\bMOVED \d+/.test(text)) return 'MOVED'
  if (/non local key/i.test(text)) return 'NONLOCAL_KEY'
  if (/should belong to the same slots allocation group/i.test(text)) return 'CLIENT_PIPELINE_SLOTS'
  return 'OTHER'
}

const REPLY_ERRORS = new Set(['ReplyError', 'ErrorReply', 'MultiErrorReply'])
const SIM_FAILURE = /CROSSSLOT|\bMOVED\b|non local key|same slot|Too many Cluster redirections/i
const TRANSPORT =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|Connection is closed|Failed to refresh slots|ClusterAllFailedError|The client is closed|Socket closed|Command timed out/i

/** A refusal by Redis or by a cluster client's own slot check: a Sim failure the report counts. */
export function isSimFailure(error: unknown): boolean {
  const name = error instanceof Error ? error.name : ''
  const text = error instanceof Error ? error.message : String(error)
  return REPLY_ERRORS.has(name) || SIM_FAILURE.test(text)
}

/** The node could not be reached: not a Sim failure and not a harness bug. */
export function isTransport(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return TRANSPORT.test(text)
}
