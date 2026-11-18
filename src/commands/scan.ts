import { existsSync, statSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { EXIT, ExitError, usage } from '../errors.js'
import { writeJson } from '../files.js'
import { scanTree } from '../scan/index.js'

function parseAlias(entries: string[]): Record<string, string> {
  const alias: Record<string, string> = {}
  for (const entry of entries) {
    const at = entry.indexOf('=')
    if (at <= 0) throw usage(`--alias expects PREFIX=DIR, got ${entry}`)
    alias[entry.slice(0, at)] = entry.slice(at + 1)
  }
  return alias
}

export async function scanCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string' },
      json: { type: 'string' },
      alias: { type: 'string', multiple: true, default: [] },
      'fail-on-error': { type: 'boolean', default: false },
    },
  })
  if (!values.root || !values.json) throw usage('scan needs --root DIR and --json FILE')
  if (!existsSync(values.root) || !statSync(values.root).isDirectory()) {
    throw usage(`not a directory: ${values.root}`)
  }
  const result = await scanTree(values.root, { alias: parseAlias(values.alias ?? []) })
  writeJson(values.json, result)
  const s = result.summary
  console.log(
    `sites=${s.sites} errors=${s.errors} unresolved=${s.unresolved} files=${result.filesScanned}`
  )
  if (values['fail-on-error'] && s.errors > 0) throw new ExitError(EXIT.failed, '')
}
