/** Seeded generator (mulberry32). Drivers must draw every random choice from here. */
export class Rng {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] as T
  }

  chance(p: number): boolean {
    return this.next() < p
  }

  /** `count` distinct items, in random order. */
  sample<T>(items: readonly T[], count: number): T[] {
    const pool = [...items]
    const out: T[] = []
    while (out.length < count && pool.length > 0)
      out.push(pool.splice(this.int(0, pool.length - 1), 1)[0] as T)
    return out
  }
}

export function seedFor(driver: string, seed: number): number {
  let h = 2166136261 ^ seed
  for (const c of driver) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return h >>> 0
}
