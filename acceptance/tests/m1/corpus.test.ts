import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CORPUS, MANIFEST, cli, copyTree, tmp } from '../../helpers'

describe('C-1 corpus verify', () => {
  const firstFile = () => readFileSync(MANIFEST, 'utf8').split('\n')[0].split(/\s+/)[1]

  it('C-1 the shipped corpus passes', () => {
    expect(existsSync(CORPUS)).toBe(true)
    const r = cli(['corpus', 'verify', '--dir', CORPUS, '--manifest', MANIFEST])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^ok 175 files/m)
  })

  it('C-1 one changed byte fails with exit 3', () => {
    const copy = copyTree(CORPUS)
    appendFileSync(join(copy, firstFile()), '\n')
    const r = cli(['corpus', 'verify', '--dir', copy, '--manifest', MANIFEST])
    expect(r.code).toBe(3)
  })

  it('C-1 a missing file fails with exit 3', () => {
    const copy = copyTree(CORPUS)
    rmSync(join(copy, firstFile()))
    expect(cli(['corpus', 'verify', '--dir', copy, '--manifest', MANIFEST]).code).toBe(3)
  })

  it('C-1 a manifest path escaping the directory is a usage error and reads nothing outside', () => {
    const dir = tmp()
    const manifest = join(tmp(), 'm.sha256')
    writeFileSync(manifest, `${'0'.repeat(64)}  ./../../etc/hosts\n`)
    const r = cli(['corpus', 'verify', '--dir', dir, '--manifest', manifest])
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).not.toMatch(/localhost/)
  })
})
