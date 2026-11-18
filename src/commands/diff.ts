import { existsSync, statSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { selectDrivers } from '../drivers/index.js'
import { introducedTypeErrors } from '../patch/typecheck.js'
import { runDiff } from '../diff/run.js'
import { EXIT, ExitError, usage } from '../errors.js'
import { writeJson } from '../files.js'
import { clusterSeeds, standaloneUrl } from '../net.js'

function positive(value: string | undefined, name: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw usage(`--${name} must be a positive integer`)
  return n
}

function requireDir(path: string | undefined, name: string): string {
  if (!path || !existsSync(path) || !statSync(path).isDirectory())
    throw usage(`--${name} is not a directory: ${path}`)
  return path
}

export async function diffCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      corpus: { type: 'string' },
      'reference-corpus': { type: 'string' },
      target: { type: 'string' },
      seeds: { type: 'string' },
      ops: { type: 'string' },
      drivers: { type: 'string', default: 'all' },
      out: { type: 'string' },
      'fail-on-failure': { type: 'boolean', default: false },
    },
  })
  if (values.target !== 'cluster' && values.target !== 'standalone')
    throw usage('--target must be cluster or standalone')
  if (!values.out) throw usage('diff needs --out FILE')
  const corpus = requireDir(values.corpus, 'corpus')
  const referenceCorpus = requireDir(values['reference-corpus'] ?? corpus, 'reference-corpus')
  const drivers = selectDrivers(values.drivers ?? 'all')
  const seeds = positive(values.seeds, 'seeds')
  const ops = positive(values.ops, 'ops')
  standaloneUrl()
  clusterSeeds()

  if (corpus !== referenceCorpus) {
    const introduced = introducedTypeErrors(referenceCorpus, corpus)
    if (introduced.length > 0) {
      throw usage(`the patched corpus adds type errors:\n${introduced.join('\n')}`)
    }
  }
  const report = await runDiff({
    corpus,
    referenceCorpus,
    target: values.target,
    seeds,
    ops,
    drivers,
  })
  writeJson(values.out, report)
  const t = report.totals
  console.log(
    `drivers=${t.drivers} failing=${t.failingDrivers} unverifiable=${t.unverifiableDrivers} failingSites=${t.failingSites} mismatches=${t.mismatches} ops=${t.ops}`
  )
  if (report.drivers.some((d) => d.referenceErrors > 0))
    throw new ExitError(EXIT.usage, 'the reference run had errors: this is a harness bug')
  const brokenControl = report.drivers.find((d) => d.controls && d.failingSeeds > 0)
  if (brokenControl)
    throw new ExitError(
      EXIT.failed,
      `control driver ${brokenControl.name} failed: the harness is wrong`
    )
  if (values['fail-on-failure'] && (t.failingDrivers > 0 || t.unverifiableDrivers > 0))
    throw new ExitError(EXIT.failed, '')
}
