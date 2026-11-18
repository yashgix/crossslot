import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cli, tmp } from '../../helpers'

function report(totals: Record<string, number>) {
  return {
    schema: 1,
    redis: { reference: '8.10.3', target: '8.10.3', mode: 'cluster' },
    corpus: 'c', referenceCorpus: 'c', seeds: 20, opsPerSeed: 500, drivers: [],
    totals,
  }
}

describe('summarize contract', () => {
  it('prints the header and the before and after rows from the totals', () => {
    const dir = tmp()
    const before = join(dir, 'b.json')
    const after = join(dir, 'a.json')
    writeFileSync(before, JSON.stringify(report({ drivers: 12, failingDrivers: 5, failingSites: 11, ops: 120000, mismatches: 3 })))
    writeFileSync(after, JSON.stringify(report({ drivers: 12, failingDrivers: 0, failingSites: 0, ops: 120000, mismatches: 0 })))
    const r = cli(['summarize', '--before', before, '--after', after])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('| Run | Drivers | Failing drivers | Failing sites | Ops | Mismatches |')
    expect(r.stdout).toContain('| before | 12 | 5 | 11 | 120000 | 3 |')
    expect(r.stdout).toContain('| after | 12 | 0 | 0 | 120000 | 0 |')
  })

  it('exits 2 when a file is not a schema 1 report', () => {
    const dir = tmp()
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, JSON.stringify({ schema: 2 }))
    expect(cli(['summarize', '--before', bad, '--after', bad]).code).toBe(2)
  })
})
