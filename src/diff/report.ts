export const ERROR_CLASSES = [
  'CROSSSLOT',
  'MOVED',
  'NONLOCAL_KEY',
  'CLIENT_PIPELINE_SLOTS',
  'OTHER',
] as const
export type ErrorClass = (typeof ERROR_CLASSES)[number]

export interface SiteOutcome {
  id: string
  executed: number
  failed: number
}

export interface DriverReport {
  name: string
  siteIds: string[]
  ops: number
  failingSeeds: number
  referenceErrors: number
  sites: SiteOutcome[]
  errors: Partial<Record<ErrorClass, number>>
  distinctEntities: number
  primariesCovered: number
  mismatches: number
  controls: boolean
  /** Replacement calls replayed under a condition the harness cannot check: never counted as passing. */
  unverifiable: string[]
  /** `unverifiable` when a replacement call ran under a condition the harness cannot check: not a pass. */
  status: 'ok' | 'failing' | 'unverifiable'
  first: { seed: number; op: number; message: string } | null
}

export interface Totals {
  drivers: number
  failingDrivers: number
  unverifiableDrivers: number
  failingSites: number
  executedSites: number
  unexecutedSites: number
  ops: number
  mismatches: number
  coverage: { resolvedErrorSites: number; executedResolvedErrorSites: number; ratio: number }
}

export interface DiffReport {
  schema: 1
  redis: { reference: string; target: string; mode: 'cluster' | 'standalone' }
  corpus: string
  referenceCorpus: string
  seeds: number
  opsPerSeed: number
  drivers: DriverReport[]
  totals: Totals
  /** Scanner verdicts against what the run saw, on executed sites only. */
  unverifiable: string[]
  scanner: { falsePositives: string[]; falseNegatives: string[] }
}
