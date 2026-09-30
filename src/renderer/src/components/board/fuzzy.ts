// Fuzzy matching for the archive stack's search, in the spirit of fzy/Sublime:
// the query's characters must appear in order, and the best-scoring alignment
// wins. Runs of consecutive characters and hits on word starts score highest.

export interface FuzzyMatch {
  score: number
  /** Positions in the text that matched, for highlighting. */
  indices: number[]
}

const MATCH = 1
const CONSECUTIVE = 1.6
const WORD_START = 1.2
const TEXT_START = 0.8
const GAP = 0.06
const LEADING_GAP = 0.02

const isSeparator = (ch: string) => /[\s\-_/.:,;()[\]{}'"`]/.test(ch)
const isUpper = (ch: string) => ch !== ch.toLowerCase()

/** Scores `text` against `query` (case-insensitive, spaces ignored), or null when it doesn't match. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return { score: 0, indices: [] }
  const t = text.toLowerCase()
  const n = q.length
  const m = t.length

  // Cheap rejection before the O(n·m) pass.
  let k = 0
  for (let j = 0; j < m && k < n; j++) if (t[j] === q[k]) k++
  if (k < n) return null

  const bonus = new Float64Array(m)
  for (let j = 0; j < m; j++) {
    if (j === 0) bonus[j] = WORD_START + TEXT_START
    else if (isSeparator(text[j - 1])) bonus[j] = WORD_START
    else if (isUpper(text[j]) && !isUpper(text[j - 1])) bonus[j] = WORD_START * 0.8
  }

  // score[i][j]: best score with q[i] matched at t[j]; from[i][j]: where q[i-1] matched.
  const score: Float64Array[] = []
  const from: Int32Array[] = []
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(m).fill(-Infinity)
    const back = new Int32Array(m).fill(-1)
    const prev = score[i - 1]
    // Running best of prev[p] + GAP·(p+1) over p < j-1, so a gap of g costs GAP·g.
    let run = -Infinity
    let runAt = -1
    for (let j = i; j < m; j++) {
      if (i > 0 && j >= 2 && prev[j - 2] + GAP * (j - 1) > run) {
        run = prev[j - 2] + GAP * (j - 1)
        runAt = j - 2
      }
      if (t[j] !== q[i]) continue
      if (i === 0) {
        row[j] = MATCH + bonus[j] - LEADING_GAP * j
        continue
      }
      const chained = prev[j - 1] + CONSECUTIVE
      const jumped = run - GAP * j
      if (chained >= jumped && chained > -Infinity) {
        row[j] = chained + MATCH + bonus[j]
        back[j] = j - 1
      } else if (jumped > -Infinity) {
        row[j] = jumped + MATCH + bonus[j]
        back[j] = runAt
      }
    }
    score.push(row)
    from.push(back)
  }

  let end = -1
  let best = -Infinity
  for (let j = 0; j < m; j++) {
    if (score[n - 1][j] > best) {
      best = score[n - 1][j]
      end = j
    }
  }
  if (end < 0) return null

  const indices = new Array<number>(n)
  for (let i = n - 1, j = end; i >= 0; i--) {
    indices[i] = j
    j = from[i][j]
  }
  // Among equal alignments, prefer the shorter title.
  return { score: best - m * 0.005, indices }
}
