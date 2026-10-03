// Parses a single-file unified diff (`git diff` output) into renderable lines.

export type DiffLineKind = 'hunk' | 'context' | 'add' | 'del' | 'note'

export interface DiffLine {
  kind: DiffLineKind
  /** Line text without its +/-/space prefix; the whole @@ header for hunks. */
  text: string
  oldNo?: number
  newNo?: number
  /** [start, end) of the part that changed, when the line pairs with one on the other side. */
  changed?: [number, number]
}

export interface ParsedDiff {
  lines: DiffLine[]
  /** Highest line number shown, to size the gutters. */
  maxLineNo: number
  /** Header-only facts for diffs without hunks, e.g. a pure rename or mode change. */
  summary?: string
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parseDiff(patch: string): ParsedDiff {
  const lines: DiffLine[] = []
  const header: string[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false

  const raw = patch.split('\n')
  if (raw[raw.length - 1] === '') raw.pop()

  for (const line of raw) {
    const hunk = HUNK.exec(line)
    if (hunk) {
      inHunk = true
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      lines.push({ kind: 'hunk', text: line })
    } else if (!inHunk) {
      header.push(line)
    } else if (line.startsWith('+')) {
      lines.push({ kind: 'add', text: line.slice(1), newNo: newNo++ })
    } else if (line.startsWith('-')) {
      lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ })
    } else if (line.startsWith('\\')) {
      lines.push({ kind: 'note', text: line.slice(2) })
    } else {
      // Context lines start with a space; some tools strip it from blank lines.
      lines.push({ kind: 'context', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
  }

  markChangedSpans(lines)
  return {
    lines,
    // The counters stop one past the last line shown.
    maxLineNo: Math.max(0, oldNo - 1, newNo - 1),
    summary: lines.length ? undefined : summarize(header)
  }
}

/**
 * Within each block of removed lines followed by as many added lines, pairs the
 * lines up and marks what differs between them (everything between a common
 * prefix and suffix), the way GitHub highlights edited words.
 */
function markChangedSpans(all: DiffLine[]) {
  // "No newline at end of file" notes can sit between a pair.
  const lines = all.filter((l) => l.kind !== 'note')
  let i = 0
  while (i < lines.length) {
    if (lines[i].kind !== 'del') {
      i++
      continue
    }
    const delStart = i
    while (i < lines.length && lines[i].kind === 'del') i++
    const addStart = i
    while (i < lines.length && lines[i].kind === 'add') i++
    const n = addStart - delStart
    if (n === 0 || i - addStart !== n) continue

    for (let k = 0; k < n; k++) {
      const a = lines[delStart + k]
      const b = lines[addStart + k]
      const max = Math.min(a.text.length, b.text.length)
      let pre = 0
      while (pre < max && a.text[pre] === b.text[pre]) pre++
      let suf = 0
      while (suf < max - pre && a.text[a.text.length - 1 - suf] === b.text[b.text.length - 1 - suf]) suf++
      // Nothing in common: highlighting the whole line adds nothing.
      if (pre + suf === 0) continue
      a.changed = [pre, a.text.length - suf]
      b.changed = [pre, b.text.length - suf]
    }
  }
}

function summarize(header: string[]): string {
  const find = (prefix: string) => header.find((l) => l.startsWith(prefix))?.slice(prefix.length)
  const from = find('rename from ')
  const to = find('rename to ')
  const oldMode = find('old mode ')
  const newMode = find('new mode ')
  const parts: string[] = []
  if (from && to) parts.push(`Renamed from ${from} without changes`)
  if (oldMode && newMode) parts.push(`File mode changed from ${oldMode} to ${newMode}`)
  if (find('new file mode ')) parts.push('Empty file')
  return parts.join('. ') || 'No changes to show'
}
