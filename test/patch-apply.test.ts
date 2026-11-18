import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { patchCommand } from '../src/commands/patch.js'

const PATCH = '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n'

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'crossslot-patch-'))
  const corpus = join(base, 'corpus')
  mkdirSync(corpus)
  writeFileSync(join(base, 'patch.diff'), PATCH)
  return { base, corpus, patchFile: join(base, 'patch.diff') }
}

const apply = (corpus: string, patch: string, out: string) =>
  patchCommand(['apply', '--corpus', corpus, '--patch', patch, '--out', out])

describe('patch apply', () => {
  it('patches a plain copy', async () => {
    const { base, corpus, patchFile } = fixture()
    writeFileSync(join(corpus, 'x.ts'), 'old\n')
    await apply(corpus, patchFile, join(base, 'out'))
    expect(readFileSync(join(base, 'out/x.ts'), 'utf8')).toBe('new\n')
    expect(readFileSync(join(corpus, 'x.ts'), 'utf8')).toBe('old\n')
  })

  it('refuses a corpus with a symlink and writes nothing through it', async () => {
    const { base, corpus, patchFile } = fixture()
    const outside = join(base, 'outside.ts')
    writeFileSync(outside, 'old\n')
    symlinkSync(outside, join(corpus, 'x.ts'))
    await expect(apply(corpus, patchFile, join(base, 'out'))).rejects.toThrow(/symlink/)
    expect(readFileSync(outside, 'utf8')).toBe('old\n')
  })
})
