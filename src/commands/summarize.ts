import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { usage } from '../errors.js'
import type { DiffReport } from '../diff/report.js'

const TOTALS = ['drivers', 'failingDrivers', 'failingSites', 'ops', 'mismatches']

function readReport(path: string): DiffReport {
  let report: DiffReport
  try {
    report = JSON.parse(readFileSync(path, 'utf8')) as DiffReport
  } catch {
    throw usage(`cannot read a diff report: ${path}`)
  }
  const totals = (report?.totals ?? {}) as unknown as Record<string, unknown>
  const numeric = TOTALS.every((k) => typeof totals[k] === 'number' && Number.isFinite(totals[k]))
  if (report?.schema !== 1 || !Array.isArray(report.drivers) || !numeric) {
    throw usage(`not a schema 1 diff report: ${path}`)
  }
  return report
}

function row(label: string, t: DiffReport['totals']): string {
  return `| ${label} | ${t.drivers} | ${t.failingDrivers} | ${t.failingSites} | ${t.ops} | ${t.mismatches} | ${t.unverifiableDrivers ?? 0} |`
}

export async function summarizeCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { before: { type: 'string' }, after: { type: 'string' } },
  })
  if (!values.before || !values.after) throw usage('summarize needs --before FILE and --after FILE')
  const before = readReport(values.before)
  const after = readReport(values.after)
  console.log(
    '| Run | Drivers | Failing drivers | Failing sites | Ops | Mismatches | Unverifiable drivers |'
  )
  console.log('|---|---|---|---|---|---|---|')
  console.log(row('before', before.totals))
  console.log(row('after', after.totals))
}
