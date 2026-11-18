/** Hash-tag logic on key templates, where `${...}` stands for a value known only at run time. */

const STAR = '${*}'

function tokenize(pattern: string): string[] {
  const out: string[] = []
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.startsWith('${', i)) {
      let depth = 0
      let j = i + 1
      for (; j < pattern.length; j++) {
        if (pattern[j] === '{') depth++
        else if (pattern[j] === '}' && --depth === 0) break
      }
      out.push(pattern.slice(i, j + 1))
      i = j
    } else {
      out.push(pattern[i] as string)
    }
  }
  return out
}

/** The text between the first literal `{` and the first literal `}` after it, or null. */
export function tagOf(pattern: string): string | null {
  const tokens = tokenize(pattern)
  const open = tokens.indexOf('{')
  if (open < 0) return null
  const close = tokens.indexOf('}', open + 1)
  if (close <= open + 1) return null
  return tokens.slice(open + 1, close).join('')
}

/** True when every key is certain to land in one slot. */
export function colocated(patterns: string[], varying = false): boolean {
  if (patterns.length === 0) return true
  const tags = patterns.map(tagOf)
  const first = tags[0]
  if (first !== null && first !== undefined && !first.includes(STAR)) {
    return tags.every((t) => t === first) && !(varying && first.includes('${'))
  }
  if (varying || patterns.some((p) => p.includes(STAR))) return false
  return patterns.every((p) => p === patterns[0])
}
