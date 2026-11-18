import { parseArgs } from 'node:util'
import { clusterDown, clusterUp, status } from '../cluster/rig.js'
import { usage } from '../errors.js'

export async function clusterCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  const { values } = parseArgs({
    args: rest,
    options: {
      version: { type: 'string', default: '8.10' },
      json: { type: 'boolean', default: false },
    },
  })
  if (sub === 'up') {
    if (values.version !== '8.10') throw usage('only --version 8.10 is available')
    await clusterUp()
    console.log('cluster up')
  } else if (sub === 'down') {
    clusterDown()
    console.log('cluster down')
  } else if (sub === 'status') {
    const s = await status()
    console.log(
      values.json
        ? JSON.stringify(s)
        : Object.entries(s)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')
    )
  } else {
    throw usage('cluster <up|down|status>')
  }
}
