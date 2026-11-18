import { createHash } from 'node:crypto'
import type { Rng } from '../diff/rng.js'
import type { Step } from '../diff/types.js'

export const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex')

/** Sorts object keys so equal JSON documents compare equal whatever their field order. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)])
    )
  }
  return value
}

export const parseJson = (text: string | null) =>
  text === null ? null : canonical(JSON.parse(text))

/** Flat `[field, value, ...]` reply to a sorted object. */
export function pairsToObject(flat: unknown): Record<string, string> {
  const list = flat as string[]
  const out: Record<string, string> = {}
  for (let i = 0; i < list.length; i += 2) out[list[i] as string] = list[i + 1] as string
  return canonical(out) as Record<string, string>
}

/** Builds steps one independent episode at a time, until `ops` steps exist. */
export function episodes(ops: number, make: (index: number) => Step[]): Step[] {
  const steps: Step[] = []
  for (let i = 0; steps.length < ops; i++) steps.push(...make(i))
  return steps.slice(0, ops)
}

/** Merges episodes into one stream, keeping each episode's own order. */
export function interleave(rng: Rng, groups: Step[][]): Step[] {
  const queues = groups.map((g) => [...g])
  const out: Step[] = []
  while (queues.some((q) => q.length > 0)) {
    const live = queues.filter((q) => q.length > 0)
    out.push(rng.pick(live).shift() as Step)
  }
  return out
}

/** Several episodes at a time, interleaved, until `ops` steps exist. */
export function overlapping(
  rng: Rng,
  ops: number,
  width: number,
  make: (index: number) => Step[]
): Step[] {
  const steps: Step[] = []
  for (let i = 0; steps.length < ops; i += width) {
    steps.push(
      ...interleave(
        rng,
        Array.from({ length: width }, (_, k) => make(i + k))
      )
    )
  }
  return steps.slice(0, ops)
}
