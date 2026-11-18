import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { summarizeCommand } from '../src/commands/summarize.js'

function file(content: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'crossslot-sum-')), 'r.json')
  writeFileSync(path, JSON.stringify(content))
  return path
}

describe('summarize input checks', () => {
  it.each([
    { schema: 1, totals: {}, drivers: [] },
    { schema: 1, drivers: [] },
    {
      schema: 1,
      totals: { drivers: 'x', failingDrivers: 0, failingSites: 0, ops: 0, mismatches: 0 },
      drivers: [],
    },
    {
      schema: 1,
      totals: { drivers: 1, failingDrivers: 0, failingSites: 0, ops: 0, mismatches: 0 },
    },
  ])('rejects a malformed report', async (bad) => {
    const path = file(bad)
    await expect(summarizeCommand(['--before', path, '--after', path])).rejects.toThrow(/schema 1/)
  })
})

describe('summarize table', () => {
  it('states unverifiable drivers apart from failing ones', async () => {
    const totals = {
      drivers: 13,
      failingDrivers: 1,
      failingSites: 1,
      ops: 10,
      mismatches: 0,
      unverifiableDrivers: 2,
    }
    const path = file({ schema: 1, drivers: [], totals })
    const lines: string[] = []
    const log = console.log
    console.log = (l: string) => void lines.push(l)
    try {
      await summarizeCommand(['--before', path, '--after', path])
    } finally {
      console.log = log
    }
    expect(lines[0]).toContain('Unverifiable drivers')
    expect(lines[3]).toBe('| after | 13 | 1 | 1 | 10 | 0 | 2 |')
  })
})
