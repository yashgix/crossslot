import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from '../../helpers'

describe('R-2 compose images are pinned by digest', () => {
  const text = readFileSync(join(ROOT, 'compose.yaml'), 'utf8')
  const images = [...text.matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1])

  it('R-2 there is at least one image and every image has a sha256 digest', () => {
    expect(images.length).toBeGreaterThan(0)
    for (const image of images) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/)
  })

  it('R-2 only the official redis repository is used and nothing is "latest"', () => {
    for (const image of images) expect(image).toMatch(/^redis:[0-9.]+@sha256:/)
    expect(text).not.toMatch(/:latest\b/)
  })

  it('R-5 every published port binds loopback and the project is named crossslot', () => {
    const ports = [...text.matchAll(/^\s*-\s*["']?([0-9.:]+:\d+:\d+)["']?\s*$/gm)].map((m) => m[1])
    expect(ports.length).toBeGreaterThanOrEqual(7)
    for (const p of ports) expect(p).toMatch(/^127\.0\.0\.1:/)
    expect(text).toMatch(/^name:\s*crossslot\s*$/m)
    expect(text).not.toMatch(/network_mode:\s*host|privileged:\s*true|\/var\/run\/docker\.sock/)
  })

  it('R-2 the pinned image is the one in compose.yaml', () => {
    expect(images).toContain(
      'redis:8.10.3@sha256:1f88291b4c57bdf249f02eb085a8669889b2d2954e91d4de5118a5da6b78dd53'
    )
  })
})
