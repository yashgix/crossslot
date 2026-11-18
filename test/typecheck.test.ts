import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { introducedTypeErrors } from '../src/patch/typecheck.js'

function tree(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'crossslot-tc-'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/a.ts'), source)
  return dir
}

const BASE = `class R { read: { go(): void } | null = null
  run() {
    if (!this.read) return
`

describe('introducedTypeErrors', () => {
  it('reports a nullable field used inside a closure', () => {
    const before = tree(`${BASE}    this.read.go()\n  }\n}\n`)
    const after = tree(`${BASE}    const f = () => this.read.go()\n    f()\n  }\n}\n`)
    expect(introducedTypeErrors(before, after).join()).toMatch(/possibly 'null'/)
  })

  it('reports a syntax error such as an unmatched brace', () => {
    const before = tree(`${BASE}    this.read.go()\n  }\n}\n`)
    const after = tree(`${BASE}    this.read.go()\n  }\n}\n}\n`)
    expect(introducedTypeErrors(before, after).join()).toMatch(/TS1128/)
  })

  it('accepts the same code with the client captured in a local constant', () => {
    const before = tree(`${BASE}    this.read.go()\n  }\n}\n`)
    const after = tree(
      `${BASE}    const read = this.read\n    const f = () => read.go()\n    f()\n  }\n}\n`
    )
    expect(introducedTypeErrors(before, after)).toEqual([])
  })
})

const corpus = 'data/sim'
describe.skipIf(!existsSync(corpus))('the shipped patch', () => {
  it('adds no type errors', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'crossslot-patched-')), 'p')
    const { patchCommand } = await import('../src/commands/patch.js')
    await patchCommand([
      'apply',
      '--corpus',
      corpus,
      '--patch',
      'patch/crossslot.patch',
      '--out',
      out,
    ])
    expect(introducedTypeErrors(corpus, out)).toEqual([])
  })
})
