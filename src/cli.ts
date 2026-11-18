#!/usr/bin/env node
import { EXIT, ExitError } from './errors.js'
import { corpusCommand } from './commands/corpus.js'
import { clusterCommand } from './commands/cluster.js'
import { diffCommand } from './commands/diff.js'
import { patchCommand } from './commands/patch.js'
import { scanCommand } from './commands/scan.js'
import { summarizeCommand } from './commands/summarize.js'

const COMMANDS: Record<string, (argv: string[]) => Promise<void>> = {
  scan: scanCommand,
  corpus: corpusCommand,
  cluster: clusterCommand,
  diff: diffCommand,
  patch: patchCommand,
  summarize: summarizeCommand,
}

async function main(): Promise<number> {
  const [name, ...rest] = process.argv.slice(2)
  const run = name ? COMMANDS[name] : undefined
  if (!run) {
    console.error(`usage: crossslot <${Object.keys(COMMANDS).join('|')}> [options]`)
    return EXIT.usage
  }
  try {
    await run(rest)
    return EXIT.ok
  } catch (error) {
    if (error instanceof ExitError) {
      if (error.message) console.error(error.message)
      return error.code
    }
    console.error(error instanceof Error ? error.message : String(error))
    return EXIT.usage
  }
}

process.exitCode = await main()
