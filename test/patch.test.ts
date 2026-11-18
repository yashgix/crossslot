import { describe, expect, it } from 'vitest'
import { applyHunks, parsePatch } from '../src/patch/unified.js'

const DIFF = `--- a/x.ts\t2026-01-01
+++ b/x.ts\t2026-01-02
@@ -2,3 +2,3 @@
 two
--- three
+++ three
 four
`

describe('parsePatch', () => {
  it('reads hunks by their line counts, so a removed "-- " line is not a header', () => {
    const [file] = parsePatch(DIFF)
    expect(file?.path).toBe('x.ts')
    expect(file?.hunks[0]?.lines).toEqual([' two', '--- three', '+++ three', ' four'])
  })

  it('refuses paths that leave the tree', () => {
    expect(() => parsePatch('--- a/../x\n+++ b/../x\n@@ -1 +1 @@\n-a\n+b\n')).toThrow(
      /leaves the tree/
    )
    expect(() => parsePatch('--- a//etc/x\n+++ b//etc/x\n@@ -1 +1 @@\n-a\n+b\n')).toThrow(
      /leaves the tree/
    )
  })
})

describe('applyHunks', () => {
  const hunks = parsePatch(DIFF)[0]?.hunks ?? []

  it('applies with exact context', () => {
    expect(applyHunks('x.ts', 'one\ntwo\n-- three\nfour\nfive', hunks)).toBe(
      'one\ntwo\n++ three\nfour\nfive'
    )
  })

  it('fails when the context moved', () => {
    expect(() => applyHunks('x.ts', 'zero\none\ntwo\n-- three\nfour', hunks)).toThrow(
      /does not apply/
    )
  })
})
