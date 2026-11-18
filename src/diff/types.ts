import type { Ctx } from './ctx.js'
import type { Rng } from './rng.js'
import type { Kind } from '../scan/types.js'

/** Finds a site by what it does rather than by line, so a patched tree still matches. */
export interface Selector {
  file: string
  fn?: string
  script?: string
  kind?: Kind
}

export interface Step {
  /** Logical entities this step touches, used for coverage and to isolate a failure. */
  ents: string[]
  run: (c: Ctx) => Promise<unknown>
  /**
   * Rebuilds this step's effect with plain single-key commands. It runs on the target after a failed
   * step so later steps meet the state the reference has, instead of an empty one.
   */
  repair?: (c: Ctx) => Promise<unknown>
}

export interface Plan {
  steps: Step[]
  /** Projects one entity's state through plain commands. */
  observe: (c: Ctx, ent: string) => Promise<unknown>
}

export interface Driver {
  name: string
  controls: boolean
  client: 'ioredis' | 'node-redis'
  sites: Selector[]
  plan: (rng: Rng, ops: number, seed: string) => Plan
}

export type Values = Record<string, string | number>
