export type Client = 'ioredis' | 'node-redis' | 'unknown'
export type Kind = 'eval' | 'evalsha' | 'multi' | 'pipeline' | 'multikey'

export interface Hazard {
  code: 'UNDECLARED_KEY' | 'CROSS_SLOT_KEYS' | 'UNRESOLVED'
  severity: 'error' | 'info'
  detail: string
}

export interface Site {
  id: string
  file: string
  line: number
  client: Client
  kind: Kind
  command: string | null
  scriptSha256: string | null
  keyPatterns: string[] | null
  keyCount: number | 'dynamic'
  resolved: boolean
  hazards: Hazard[]
}

export interface ScanResult {
  schema: 1
  root: string
  filesScanned: number
  sites: Site[]
  summary: { sites: number; byKind: Record<string, number>; errors: number; unresolved: number }
}

/** One argument of a replayed command: a template, or an object literal's field templates. */
export type Arg = string | { fields: Array<[string, string]> }

export interface Command {
  name: string
  args: Arg[]
}

/** What the harness needs from a site beyond the public JSON. */
export interface Detail {
  fn: string
  scriptName: string | null
  script: string | null
  /** Eval arguments after the keys, or null when a spread hides them. */
  args: Arg[] | null
  /** Chained commands of a multi or pipeline, or the single multikey command. */
  commands: Command[]
}

export interface DetailedSite extends Site, Detail {}

/** A single-key Redis call, kept so a patched corpus's replacement operations can be replayed. */
export interface OpSite {
  id: string
  file: string
  line: number
  fn: string
  command: string
  args: Arg[]
  /** `unknown` when the call sits under a condition the scanner cannot evaluate. */
  guard: 'none' | 'unknown'
  /** For xread: the stream keys of the first argument. */
  keys: string[] | null
}

export interface Scan {
  result: ScanResult
  sites: DetailedSite[]
  ops: OpSite[]
  /** The resolved key template of a named helper (function or const arrow) in a file. */
  helper: (file: string, name: string) => string | null
}
