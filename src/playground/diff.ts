// Line-level diff using the Myers algorithm, with optional intra-line
// word-level diff for changed line pairs.

export type Op = 'equal' | 'insert' | 'delete';

export interface LineChunk {
  op: Op;
  leftLine: number  | null;   // 1-based source line, or null when N/A
  rightLine: number | null;
  text: string;
}

// Group consecutive lines of the same op into a "hunk" with paired delete/insert
// lines treated as "change" for the UI.
export interface Hunk {
  // Either "equal" run (unchanged), or "change" run (some del/ins mix).
  kind: 'equal' | 'change';
  lines: LineChunk[];
}

// ── Myers diff (line-level) ───────────────────────────────────
// Standard O(ND) edit-script. Inputs are arrays of lines.
export function diffLines(a: string[], b: string[]): LineChunk[] {
  const n = a.length, m = b.length;
  const max = n + m;
  const v: number[] = new Array(2 * max + 1).fill(0);
  const trace: number[][] = [];

  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) {
        x = v[k + 1 + max];
      } else {
        x = v[k - 1 + max] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[k + max] = x;
      if (x >= n && y >= m) break outer;
    }
  }

  // Backtrack the trace to recover the edit script.
  const ops: LineChunk[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d > 0 && (x > 0 || y > 0); d--) {
    const vp = trace[d];
    const k  = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vp[k - 1 + max] < vp[k + 1 + max])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vp[prevK + max];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.unshift({ op: 'equal', leftLine: x, rightLine: y, text: a[x - 1] });
      x--; y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.unshift({ op: 'insert', leftLine: null, rightLine: y, text: b[y - 1] });
        y--;
      } else {
        ops.unshift({ op: 'delete', leftLine: x, rightLine: null, text: a[x - 1] });
        x--;
      }
    }
  }
  while (x > 0 && y > 0 && a[x - 1] === b[y - 1]) {
    ops.unshift({ op: 'equal', leftLine: x, rightLine: y, text: a[x - 1] });
    x--; y--;
  }
  return ops;
}

// Group sequential ops into hunks for the UI.
export function groupHunks(ops: LineChunk[]): Hunk[] {
  const hunks: Hunk[] = [];
  let curr: Hunk | null = null;
  for (const o of ops) {
    const kind: Hunk['kind'] = o.op === 'equal' ? 'equal' : 'change';
    if (!curr || curr.kind !== kind) {
      curr = { kind, lines: [] };
      hunks.push(curr);
    }
    curr.lines.push(o);
  }
  return hunks;
}

// ── Intra-line word diff (used to highlight specific characters that
//    differ between paired delete/insert lines within a change hunk) ────
export type WordOp = { op: Op; text: string };

export function diffWords(a: string, b: string): WordOp[] {
  const aw = tokenize(a), bw = tokenize(b);
  const n = aw.length, m = bw.length;
  // LCS table — fine for typical line lengths (< 1000 tokens).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aw[i] === bw[j] ? dp[i + 1][j + 1] + 1
                                  : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: WordOp[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (aw[i] === bw[j])                  { out.push({ op: 'equal',  text: aw[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: 'delete', text: aw[i] }); i++; }
    else                                   { out.push({ op: 'insert', text: bw[j] }); j++; }
  }
  while (i < n) { out.push({ op: 'delete', text: aw[i++] }); }
  while (j < m) { out.push({ op: 'insert', text: bw[j++] }); }
  return out;
}

function tokenize(s: string): string[] {
  // Split into runs of word chars / runs of non-word chars (incl. whitespace).
  return s.match(/\w+|\W/g) ?? [];
}

// ── Stats ─────────────────────────────────────────────────────
export function countStats(ops: LineChunk[]): { added: number; removed: number; same: number } {
  let added = 0, removed = 0, same = 0;
  for (const o of ops) {
    if (o.op === 'insert') added++;
    else if (o.op === 'delete') removed++;
    else same++;
  }
  return { added, removed, same };
}
