import { allDone } from './settle.js'
import type { Arg, Command, DetailedSite, OpSite, Scan } from '../scan/types.js'
import type { Cmd, Conn, StreamRead } from './conn.js'

const WRITES = new Set(['SET', 'DEL', 'XADD', 'HSET', 'RPUSH', 'LREM', 'EXPIRE', 'ZADD'])
import { HarnessError } from './errors.js'
import type { Selector, Values } from './types.js'

/** One side of a comparison: a corpus under test, the deployment it runs on, and what it wrote. */
export class Side {
  /** Keys this run wrote or tried to write, recorded before the write. Cleanup deletes these. */
  readonly written = new Set<string>()
  readonly memory = new Map<string, unknown>()
  private readonly shas = new Map<string, string>()
  private readonly ordinals = new Map<string, Map<string, number>>()

  constructor(
    readonly scan: Scan,
    readonly target: { loadScript: (s: string) => Promise<string> },
    readonly conn: Conn
  ) {}

  async sha(script: string): Promise<string> {
    const known = this.shas.get(script)
    if (known) return known
    const sha = await this.target.loadScript(script)
    this.shas.set(script, sha)
    return sha
  }

  /** D-8: a server-generated stream id becomes its ordinal of first appearance in that stream. */
  ordinal(stream: string, id: string): number {
    const ids = this.ordinals.get(stream) ?? new Map<string, number>()
    this.ordinals.set(stream, ids)
    if (!ids.has(id)) ids.set(id, ids.size + 1)
    return ids.get(id) as number
  }
}

export function matching(scan: Scan, sel: Selector): DetailedSite[] {
  return scan.sites.filter(
    (s) =>
      s.file === sel.file &&
      (sel.fn === undefined || s.fn === sel.fn) &&
      (sel.script === undefined || s.scriptName === sel.script) &&
      (sel.kind === undefined || s.kind === sel.kind)
  )
}

/** Replaces each `${expr}` in a template with the value the driver supplies for that expression. */
export function render(template: string, values: Values): string {
  let out = ''
  for (let i = 0; i < template.length; i++) {
    if (!template.startsWith('${', i)) {
      out += template[i]
      continue
    }
    let depth = 0
    let j = i + 1
    for (; j < template.length; j++) {
      if (template[j] === '{') depth++
      else if (template[j] === '}' && --depth === 0) break
    }
    const expr = template.slice(i + 2, j).trim()
    const value = values[expr]
    if (value === undefined) throw new HarnessError(`no value for \${${expr}} in "${template}"`)
    out += String(value)
    i = j
  }
  return out
}

function renderArg(arg: Arg, values: Values): string[] {
  if (typeof arg === 'string') return [render(arg, values)]
  return arg.fields.flatMap(([name, template]) => [name, render(template, values)])
}

function rawCommand(cmd: Command, values: Values): Cmd {
  return [cmd.name.toUpperCase(), ...cmd.args.flatMap((a) => renderArg(a, values))]
}

export interface Item {
  name: string
  values: Values
}

/** Everything one step does on one side. */
export class Ctx {
  /** Ids of the corpus sites this step ran, in order. */
  readonly hits: string[] = []
  /** The site that was running when the step stopped, for blaming a failure. */
  last: string | null = null
  /** Sites that failed inside a step that went on to try the rest. */
  readonly failures: string[] = []
  /** Replacement calls that ran under a condition the harness cannot evaluate. */
  readonly unverified = new Set<string>()

  constructor(readonly side: Side) {}

  get conn(): Conn {
    return this.side.conn
  }

  sites(sel: Selector): DetailedSite[] {
    return matching(this.side.scan, sel)
  }

  private need(sel: Selector): DetailedSite[] {
    const sites = this.sites(sel)
    if (sites.length === 0) throw new HarnessError(`no site matches ${JSON.stringify(sel)}`)
    return sites
  }

  private enter(site: DetailedSite): void {
    this.hits.push(site.id)
    this.last = site.id
  }

  /** Renders a key template. Reading a key never makes the run its owner. */
  key(template: string, values: Values): string {
    return render(template, values)
  }

  /**
   * Records keys before a write is sent, so a write that fails halfway, or a batch of which only
   * some commands ran, still has its keys cleaned up. Every key derives from ids that carry the
   * run's id, so deleting them can only remove what this run could have created.
   */
  async writing<T>(keys: Array<string | undefined>, action: () => Promise<T>): Promise<T> {
    for (const key of keys) if (key !== undefined) this.side.written.add(key)
    return action()
  }

  /** The `index`-th declared key of the first site matching the selector. */
  siteKey(sel: Selector, index: number, values: Values): string {
    const template = this.need(sel)[0]?.keyPatterns?.[index]
    if (template === undefined)
      throw new HarnessError(`site ${JSON.stringify(sel)} has no key ${index}`)
    return this.key(template, values)
  }

  /** The `index`-th argument after the keys of the first matching eval site, rendered. */
  siteArg(sel: Selector, index: number, values: Values): string {
    const arg = this.need(sel)[0]?.args?.[index]
    if (typeof arg !== 'string')
      throw new HarnessError(`site ${JSON.stringify(sel)} has no argument ${index}`)
    return render(arg, values)
  }

  /** The key a named helper in the corpus builds. */
  helperKey(file: string, name: string, values: Values): string {
    const template = this.side.scan.helper(file, name)
    if (template === null) throw new HarnessError(`no key helper ${name} in ${file}`)
    return this.key(template, values)
  }

  async run(...cmd: Array<string | number>): Promise<unknown> {
    const args = cmd.map(String)
    if (!WRITES.has((args[0] ?? '').toUpperCase())) return this.conn.run(args)
    return this.writing([args[1]], () => this.conn.run(args))
  }

  /** Runs the script of every matching eval or evalsha site; returns the first site's reply. */
  async eval(
    sel: Selector,
    values: Values,
    over?: { keys?: string[]; args?: Array<string | number> }
  ) {
    const replies: unknown[] = []
    for (const site of this.need(sel)) {
      if (site.script === null) throw new HarnessError(`script of ${site.id} is unresolved`)
      const keys = over?.keys ?? this.siteKeys(site, values)
      const args = over?.args?.map(String) ?? this.siteArgs(site, values)
      this.enter(site)
      const script = site.script
      replies.push(
        await this.writing(keys, async () =>
          site.kind === 'evalsha'
            ? this.conn.evalsha(await this.side.sha(script), keys, args)
            : this.conn.eval(script, keys, args)
        )
      )
    }
    return replies[0]
  }

  private siteKeys(site: DetailedSite, values: Values): string[] {
    if (site.keyPatterns === null || site.keyCount === 'dynamic') {
      throw new HarnessError(`${site.id} has dynamic keys, the driver must pass them`)
    }
    return site.keyPatterns.map((p) => this.key(p, values))
  }

  private siteArgs(site: DetailedSite, values: Values): string[] {
    if (site.args === null)
      throw new HarnessError(`${site.id} has spread arguments, the driver must pass them`)
    return site.args.flatMap((a) => renderArg(a, values))
  }

  /** Replays the chained commands of every matching multi or pipeline site; returns the first site's replies. */
  async replay(sel: Selector, values: Values): Promise<unknown[]> {
    const replies: unknown[][] = []
    for (const site of this.need(sel)) {
      const cmds = site.commands.map((c) => rawCommand(c, values))
      this.enter(site)
      replies.push(
        await this.writing(
          cmds.map((c) => c[1]),
          () => this.send(site, cmds)
        )
      )
    }
    return replies[0] as unknown[]
  }

  private send(site: DetailedSite, cmds: Cmd[]): Promise<unknown[]> {
    return site.kind === 'multi' ? this.conn.transaction(cmds) : this.conn.pipeline(cmds)
  }

  /** The commands of the matching sites, one plain command each. Used to repair state after a failure. */
  async replayEach(sel: Selector, values: Values): Promise<void> {
    for (const site of this.need(sel)) {
      for (const command of site.commands) {
        const cmd = rawCommand(command, values)
        await this.writing([cmd[1]], () => this.conn.run(cmd))
      }
    }
  }

  /** The replacement operations of a fix, read from the corpus: a missing one is a harness error. */
  private ops(sel: Selector, command: string): OpSite[] {
    const found = this.side.scan.ops.filter(
      (o) =>
        o.file === sel.file && (sel.fn === undefined || o.fn === sel.fn) && o.command === command
    )
    if (found.length === 0) {
      throw new HarnessError(`the corpus has no ${command} call in ${sel.fn ?? sel.file} to replay`)
    }
    found.filter((o) => o.guard === 'unknown').forEach((o) => this.unverified.add(o.id))
    return found
  }

  /**
   * Runs one command per item through a looped pipeline site, or through the single-key calls
   * the corpus uses in its place once it has split the pipeline.
   */
  async each(sel: Selector, items: Item[]): Promise<unknown[]> {
    const [site] = this.sites(sel)
    const cmds = items.map((item) => {
      if (site) {
        const cmd = site.commands.find((c) => c.name === item.name)
        if (!cmd) throw new HarnessError(`${site.id} has no ${item.name} command`)
        return rawCommand(cmd, item.values)
      }
      const [op] = this.ops(sel, item.name)
      return [
        item.name.toUpperCase(),
        ...(op as OpSite).args.flatMap((a) => renderArg(a, item.values)),
      ]
    })
    const keys = cmds.map((c) => c[1])
    if (!site) return this.writing(keys, () => allDone(cmds.map((c) => this.conn.run(c))))
    this.enter(site)
    return this.writing(keys, () => this.send(site, cmds))
  }

  /**
   * One multi-key command (mget, del...) as the corpus issues it, or the single-key calls it uses
   * in its place once split. `values` holds each key's logical parameters for those calls.
   */
  async multikey(sel: Selector, keys: string[], values: Values[]): Promise<unknown> {
    const [site] = this.sites(sel)
    if (site) {
      this.enter(site)
      return this.conn.run([(site.command ?? '').toUpperCase(), ...keys])
    }
    const [op] = this.ops(sel, 'get')
    const cmds = values.map((v) => ['GET', ...(op as OpSite).args.flatMap((a) => renderArg(a, v))])
    return allDone(cmds.map((c) => this.conn.run(c)))
  }

  /** A multi-key command whose keys are fixed in the corpus, run as the corpus issues it. */
  async multikeyAt(sel: Selector, values: Values): Promise<unknown> {
    const [site] = this.need(sel)
    const keys = (site?.keyPatterns ?? []).map((p) => this.key(p, values))
    if (!site) throw new HarnessError(`no site matches ${JSON.stringify(sel)}`)
    this.enter(site)
    return this.writing(keys, () => this.conn.run([(site.command ?? '').toUpperCase(), ...keys]))
  }

  /**
   * One round of reads over the named streams, each call starting from the cursors the previous one left, through the corpus's own xread calls: every
   * multi-stream site in source order, or the per-stream calls that replaced them. A call that
   * waits (BLOCK) reads one stream. BLOCK itself is not replayed: it changes how long a read
   * waits, not which slots it touches, and a blocking call costs node-redis a connection each time.
   */
  async streamReads(
    sel: Selector,
    names: string[],
    cursors: { get: (name: string) => string; set: (name: string, id: string) => void }
  ): Promise<Array<{ name: string; entries: StreamRead['entries'] }>> {
    const sites = this.sites(sel)
    const calls = sites.length > 0 ? sites : this.ops(sel, 'xread')
    const out: Array<{ name: string; entries: StreamRead['entries'] }> = []
    let failure: unknown = null
    for (const call of calls) {
      const isSite = 'keyPatterns' in call
      const args = isSite ? call.commands[0]?.args : call.args
      const fields = (args?.[1] as { fields: Array<[string, string]> } | undefined)?.fields ?? []
      const options = Object.fromEntries(fields)
      const template = isSite ? call.keyPatterns?.[0] : call.keys?.[0]
      if (template === undefined) throw new HarnessError(`${call.id} has no stream key to replay`)
      const wanted = options.BLOCK && !isSite ? names.slice(0, 1) : names
      const keyOf = (name: string) => render(template, { '*': name, name })
      const streams = wanted.map((name) => ({ key: keyOf(name), id: cursors.get(name) }))
      if (isSite) this.enter(call)
      try {
        const batches = isSite ? [streams] : streams.map((s) => [s])
        const replies = await allDone(
          batches.map((b) => this.conn.xread(b, { count: Number(options.COUNT ?? 1) }))
        )
        for (const reply of replies) {
          for (const r of reply ?? []) {
            const name = wanted.find((n) => keyOf(n) === r.key)
            const last = r.entries[r.entries.length - 1]
            if (name === undefined) continue
            out.push({ name, entries: r.entries })
            if (last) cursors.set(name, last.id)
          }
        }
      } catch (error) {
        if (isSite) this.failures.push(call.id)
        failure ??= error
      }
    }
    if (failure) throw failure
    return out
  }

  /** The three TTL states of D-8: no expiry, expiring within the bound, or the key is gone. */
  async ttlState(key: string, boundMs: number): Promise<string> {
    const ms = Number(await this.conn.run(['PTTL', key]))
    if (ms === -2) return 'gone'
    if (ms === -1) return 'none'
    return ms <= boundMs ? 'ttl' : 'over'
  }
}
