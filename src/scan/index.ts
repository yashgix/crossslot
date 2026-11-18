import { loadProgram } from './program.js'
import { SiteFinder } from './sites.js'
import type { DetailedSite, Scan, ScanResult } from './types.js'

export type { Detail, DetailedSite, Hazard, Scan, ScanResult, Site } from './types.js'

export interface ScanOptions {
  alias?: Record<string, string>
}

function hasError(site: DetailedSite): boolean {
  return site.hazards.some((h) => h.severity === 'error')
}

function summarize(sites: DetailedSite[]): ScanResult['summary'] {
  const byKind: Record<string, number> = {}
  for (const s of sites) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1
  return {
    sites: sites.length,
    byKind,
    errors: sites.filter(hasError).length,
    unresolved: sites.filter((s) => !s.resolved).length,
  }
}

/** The public fields of a detailed site, in a fixed order. */
function publicSite(s: DetailedSite): ScanResult['sites'][number] {
  return {
    id: s.id,
    file: s.file,
    line: s.line,
    client: s.client,
    kind: s.kind,
    command: s.command,
    scriptSha256: s.scriptSha256,
    keyPatterns: s.keyPatterns,
    keyCount: s.keyCount,
    resolved: s.resolved,
    hazards: s.hazards,
  }
}

export function scanDetailed(root: string, opts: ScanOptions = {}): Scan {
  const program = loadProgram(root, opts.alias)
  const finder = new SiteFinder(program)
  const found = finder.find()
  const sites = found.sites.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line
  )
  const result: ScanResult = {
    schema: 1,
    root,
    filesScanned: program.filesScanned,
    sites: sites.map(publicSite),
    summary: summarize(sites),
  }
  return { result, sites, ops: found.ops, helper: (file, name) => finder.helper(file, name) }
}

export async function scanTree(root: string, opts: ScanOptions = {}): Promise<ScanResult> {
  return scanDetailed(root, opts).result
}
