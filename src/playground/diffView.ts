// IDEA-style side-by-side diff view.
//
// Each side is an editable textarea with two synchronized overlays:
//   1. a line-number gutter on the outside
//   2. a row-background layer behind the textarea (delete = red, insert = green,
//      change = yellow)
// Scroll on either side is mirrored to the other. The narrow middle column
// shows ←/→ buttons per change-hunk to apply one side onto the other.

import { diffLines, groupHunks, countStats, diffWords, LineChunk } from './diff';
import { t } from '../ui/i18n';

export interface DiffPanelsAPI {
  root: HTMLElement;
  left: HTMLTextAreaElement;
  right: HTMLTextAreaElement;
  refresh: () => void;
}

interface HunkRange {
  leftStart: number;   // 1-based, inclusive
  leftEnd:   number;   // inclusive
  rightStart: number;
  rightEnd:   number;
  kind: 'change';
}

export function renderDiffPanels(options: { onChange: () => void }): DiffPanelsAPI {
  const root = document.createElement('div');
  root.className = 'fv-diff-shell-v2';

  // ── Top bar ────────────────────────────────────────────────
  const bar = document.createElement('div');
  bar.className = 'fv-diff-bar';

  const btnSwap = mkBtn(t('⇄ 交换两侧', '⇄ Swap sides'));
  const btnAllL = mkBtn(t('全部用左 →', 'Apply all left →'));
  const btnAllR = mkBtn(t('← 全部用右', '← Apply all right'));
  const stats   = document.createElement('span');
  stats.className = 'fv-diff-stats';
  bar.append(btnAllR, btnAllL, btnSwap, stats);

  // ── Body: left | center | right ────────────────────────────
  const body = document.createElement('div');
  body.className = 'fv-diff-body';

  const leftSide  = mkSide('left',  t('左侧文本', 'Left'));
  const rightSide = mkSide('right', t('右侧文本', 'Right'));

  const center = document.createElement('div');
  center.className = 'fv-diff-center';
  const centerInner = document.createElement('div');
  centerInner.className = 'fv-diff-center-inner';
  center.appendChild(centerInner);

  body.append(leftSide.root, center, rightSide.root);

  root.append(bar, body);

  // ── Wire up scroll syncing (textarea ↔ gutter ↔ bg ↔ center) ─
  syncScroll(leftSide,  rightSide, centerInner);
  syncScroll(rightSide, leftSide,  null);

  // ── Refresh logic ──────────────────────────────────────────
  const left  = leftSide.editor;
  const right = rightSide.editor;
  let lastHunks: HunkRange[] = [];

  function refresh(): void {
    const a = splitNoTrailing(left.value);
    const b = splitNoTrailing(right.value);
    const ops    = diffLines(a, b);
    const c      = countStats(ops);
    const hunks  = groupHunks(ops);

    stats.textContent = `+${c.added} / -${c.removed} / =${c.same}`;

    // Per-side row colors & gutter
    paintSide(leftSide,  ops, 'left',  a.length);
    paintSide(rightSide, ops, 'right', b.length);

    // Center accept buttons per change hunk
    lastHunks = collectChangeRanges(hunks);
    paintCenter(centerInner, lastHunks, leftSide);
  }

  // ── Apply-hunk handlers ────────────────────────────────────
  function applyHunk(range: HunkRange, side: 'left' | 'right'): void {
    const aLines = splitNoTrailing(left.value);
    const bLines = splitNoTrailing(right.value);
    if (side === 'left') {
      // overwrite right hunk lines with left hunk lines
      const fragment = aLines.slice(range.leftStart - 1, range.leftEnd);
      const before   = bLines.slice(0, range.rightStart - 1);
      const after    = bLines.slice(range.rightEnd);
      right.value = [...before, ...fragment, ...after].join('\n');
    } else {
      const fragment = bLines.slice(range.rightStart - 1, range.rightEnd);
      const before   = aLines.slice(0, range.leftStart - 1);
      const after    = aLines.slice(range.leftEnd);
      left.value = [...before, ...fragment, ...after].join('\n');
    }
    options.onChange();
    refresh();
  }

  // Delegate clicks on center buttons
  centerInner.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const btn = t.closest<HTMLElement>('button.fv-diff-accept');
    if (!btn) return;
    const idx = Number(btn.dataset.hunk);
    const side = btn.dataset.side as 'left' | 'right';
    if (Number.isNaN(idx) || !lastHunks[idx]) return;
    applyHunk(lastHunks[idx], side);
  });

  // Top-bar handlers
  btnSwap.addEventListener('click', () => {
    const tmp = left.value;
    left.value  = right.value;
    right.value = tmp;
    options.onChange();
    refresh();
  });
  btnAllL.addEventListener('click', () => {
    right.value = left.value;
    options.onChange();
    refresh();
  });
  btnAllR.addEventListener('click', () => {
    left.value = right.value;
    options.onChange();
    refresh();
  });

  return { root, left, right, refresh };
}

// ── Side builder ──────────────────────────────────────────────
interface SidePanel {
  root: HTMLElement;
  editor: HTMLTextAreaElement;
  gutterInner: HTMLElement;   // transformed to follow scroll
  bg: HTMLElement;            // transformed to follow scroll
  scrollWrap: HTMLElement;
}

function mkSide(which: 'left' | 'right', title: string): SidePanel {
  const root = document.createElement('div');
  root.className = `fv-diff-side fv-diff-side-${which}`;

  const titleEl = document.createElement('div');
  titleEl.className = 'fv-diff-side-title';
  titleEl.textContent = title;

  const scrollWrap = document.createElement('div');
  scrollWrap.className = 'fv-diff-scrollwrap';

  const gutter = document.createElement('div');
  gutter.className = 'fv-diff-gutter';
  const gutterInner = document.createElement('div');
  gutterInner.className = 'fv-diff-gutter-inner';
  gutter.appendChild(gutterInner);

  const textWrap = document.createElement('div');
  textWrap.className = 'fv-diff-textwrap';

  const bg = document.createElement('div');
  bg.className = 'fv-diff-bg';

  const editor = document.createElement('textarea');
  editor.className = 'fv-diff-editor';
  editor.spellcheck = false;
  editor.wrap = 'off';

  textWrap.append(bg, editor);
  scrollWrap.append(gutter, textWrap);
  root.append(titleEl, scrollWrap);
  return { root, editor, gutterInner, bg, scrollWrap };
}

function mkBtn(label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'fv-btn fv-pg-textbtn';
  b.textContent = label;
  return b;
}

// ── Painting ──────────────────────────────────────────────────

// Build per-line op map + per-line word-diff HTML for a side.
// Paired delete/insert lines within a change hunk get yellow 'change' op and
// word-diff highlighting; unmatched lines get pure 'delete' (red) or 'insert'
// (green).
type SidePaint = Map<number, { op: 'equal' | 'delete' | 'insert' | 'change'; html?: string }>;

function buildSidePaint(ops: LineChunk[], side: 'left' | 'right'): SidePaint {
  const map: SidePaint = new Map();
  const hunks = groupHunks(ops);
  for (const h of hunks) {
    if (h.kind === 'equal') {
      for (const o of h.lines) {
        const ln = side === 'left' ? o.leftLine : o.rightLine;
        if (ln != null) map.set(ln, { op: 'equal' });
      }
      continue;
    }
    const dels = h.lines.filter((o) => o.op === 'delete');
    const ins  = h.lines.filter((o) => o.op === 'insert');
    const paired = Math.min(dels.length, ins.length);
    const myList = side === 'left' ? dels : ins;
    const otherList = side === 'left' ? ins : dels;
    for (let i = 0; i < myList.length; i++) {
      const ln = side === 'left' ? myList[i].leftLine : myList[i].rightLine;
      if (ln == null) continue;
      if (i < paired) {
        // Paired change: compute word diff, render text into bg so deleted/inserted
        // characters get visible background tint behind the transparent textarea.
        const wd = diffWords(myList[i].text, otherList[i].text);
        const html = wordDiffHtml(wd, side);
        map.set(ln, { op: 'change', html });
      } else {
        map.set(ln, { op: side === 'left' ? 'delete' : 'insert' });
      }
    }
  }
  return map;
}

function wordDiffHtml(words: ReturnType<typeof diffWords>, side: 'left' | 'right'): string {
  let out = '';
  for (const w of words) {
    const t = esc(w.text);
    if (w.op === 'equal') {
      out += t;
    } else if ((side === 'left' && w.op === 'delete') || (side === 'right' && w.op === 'insert')) {
      out += `<span class="fv-diff-word-${side === 'left' ? 'del' : 'ins'}">${t}</span>`;
    }
    // Opposite-side words are silently dropped: the bg only shows the text
    // from its own side.
  }
  return out;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function paintSide(side: SidePanel, ops: LineChunk[], which: 'left' | 'right', lineCount: number): void {
  const paint = buildSidePaint(ops, which);

  // Line-number gutter
  side.gutterInner.innerHTML = '';
  for (let i = 1; i <= lineCount; i++) {
    const n = document.createElement('div');
    n.className = 'fv-diff-ln';
    n.textContent = String(i);
    side.gutterInner.appendChild(n);
  }
  if (lineCount === 0) {
    const n = document.createElement('div');
    n.className = 'fv-diff-ln';
    n.textContent = '1';
    side.gutterInner.appendChild(n);
  }

  // Row background layer: render the same text the textarea shows on top,
  // with word-diff highlights so specific changed characters get tinted
  // behind the transparent textarea.
  side.bg.innerHTML = '';
  const total = Math.max(lineCount, 1);
  for (let i = 1; i <= total; i++) {
    const row = document.createElement('div');
    const pi = paint.get(i);
    const op = pi?.op ?? 'equal';
    row.className = `fv-diff-bg-row op-${op}`;
    if (pi?.html) row.innerHTML = pi.html;
    else row.textContent = '​'; // zero-width space — keeps the row's height
    side.bg.appendChild(row);
  }
}

function collectChangeRanges(hunks: ReturnType<typeof groupHunks>): HunkRange[] {
  const out: HunkRange[] = [];
  for (const h of hunks) {
    if (h.kind !== 'change') continue;
    const dels = h.lines.filter((o) => o.op === 'delete');
    const ins  = h.lines.filter((o) => o.op === 'insert');
    const leftLines  = dels.map((o) => o.leftLine!).filter((n) => n != null);
    const rightLines = ins.map((o) => o.rightLine!).filter((n) => n != null);
    out.push({
      kind: 'change',
      leftStart:  leftLines[0]  ?? findPrevLeft(h, hunks),
      leftEnd:    leftLines[leftLines.length - 1]  ?? (leftLines[0]  ?? 0) - 1,
      rightStart: rightLines[0] ?? findPrevRight(h, hunks),
      rightEnd:   rightLines[rightLines.length - 1] ?? (rightLines[0] ?? 0) - 1,
    });
  }
  return out;
}

function findPrevLeft(h: ReturnType<typeof groupHunks>[number], all: ReturnType<typeof groupHunks>): number {
  // For pure-insert hunks (no left lines), position the action button after
  // the previous hunk's last left line.
  let prev = 0;
  for (const x of all) {
    if (x === h) break;
    for (const o of x.lines) if (o.leftLine != null) prev = o.leftLine;
  }
  return prev + 1; // hunk virtually "starts" at prev + 1
}
function findPrevRight(h: ReturnType<typeof groupHunks>[number], all: ReturnType<typeof groupHunks>): number {
  let prev = 0;
  for (const x of all) {
    if (x === h) break;
    for (const o of x.lines) if (o.rightLine != null) prev = o.rightLine;
  }
  return prev + 1;
}

function paintCenter(center: HTMLElement, ranges: HunkRange[], leftSide: SidePanel): void {
  center.innerHTML = '';

  // Use the actual rendered row height to position buttons (must read after
  // gutter is painted so the first .fv-diff-ln exists).
  const sample = leftSide.gutterInner.querySelector<HTMLElement>('.fv-diff-ln');
  if (!sample) return;
  const rowH = sample.offsetHeight || 20;
  const padTop = parseFloat(getComputedStyle(leftSide.bg).paddingTop || '0') || 0;

  ranges.forEach((r, i) => {
    // Position at the vertical center of the change hunk on the LEFT side
    const startLine = Math.max(1, r.leftStart);
    const endLine   = Math.max(startLine, r.leftEnd);
    const top = padTop + ((startLine - 1) + (endLine - startLine + 1) / 2) * rowH - rowH / 2;

    const group = document.createElement('div');
    group.className = 'fv-diff-hunk-actions';
    group.style.top = `${Math.max(0, top)}px`;

    // → applies LEFT to RIGHT
    const toRight = document.createElement('button');
    toRight.className = 'fv-diff-accept';
    toRight.dataset.hunk = String(i);
    toRight.dataset.side = 'left';
    toRight.textContent = '→';
    toRight.title = t('用左侧覆盖右侧', 'Apply left to right');

    // ← applies RIGHT to LEFT
    const toLeft = document.createElement('button');
    toLeft.className = 'fv-diff-accept';
    toLeft.dataset.hunk = String(i);
    toLeft.dataset.side = 'right';
    toLeft.textContent = '←';
    toLeft.title = t('用右侧覆盖左侧', 'Apply right to left');

    group.append(toRight, toLeft);
    center.appendChild(group);
  });
}

// Drop a single trailing empty line so a file ending with "\n" doesn't get
// counted as having an extra blank line in the diff.
function splitNoTrailing(s: string): string[] {
  const parts = s.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

// ── Scroll sync ───────────────────────────────────────────────
// Each side's gutter + bg layer scrolls vertically with its editor.
// The two sides' editors mirror each other's scrollTop.
function syncScroll(src: SidePanel, dst: SidePanel, centerInner: HTMLElement | null): void {
  src.editor.addEventListener('scroll', () => {
    const y = -src.editor.scrollTop;
    // Local sync: gutter-inner and bg follow the editor's scrollTop
    src.gutterInner.style.transform = `translateY(${y}px)`;
    src.bg.style.transform          = `translateY(${y}px)`;
    // Center buttons are positioned relative to the LEFT side — scroll with it.
    if (centerInner) centerInner.style.transform = `translateY(${y}px)`;
    // Cross-side sync (equality guard avoids an infinite scroll loop)
    if (dst.editor.scrollTop !== src.editor.scrollTop) {
      dst.editor.scrollTop = src.editor.scrollTop;
    }
  });
}
