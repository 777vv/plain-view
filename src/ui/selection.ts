// Smart text selection — used by the file viewers (content script, isolated
// world) and the Playground / CSV viewer (extension pages). enableSmartSelection
// is idempotent; call it once per document.
//
// Runs fine in the content-script ISOLATED world: it shares the page DOM and
// Selection, so dblclick events, caretRangeFromPoint, getSelection, and DOM
// mutation all work there. The one thing that does NOT work in the isolated
// world is the CSS Custom Highlight API (its registry is per-realm and the
// page's rendering ignores it), so highlights use plain <mark> wrapping, which
// renders everywhere.
//
// Two document-level delegated listeners:
//   • dblclick (bubble) — expand the selection to a full "token" bounded by
//     non-word characters (Unicode letters/digits/underscore stay; everything
//     else — punctuation, symbols, whitespace, incl. CJK — is a border).
//     Textareas expand via selectionStart/End; rendered HTML locates the text
//     node under the cursor via caretRangeFromPoint and overrides the selection.
//   • selectionchange (debounced) — wrap every WHOLE-TOKEN match of the selected
//     text in <mark class="fv-sel-hl">, case-insensitively, inside the current
//     rendered text. "Whole-token" = bordered by non-word chars on both sides,
//     so a substring buried in a larger word is NOT highlighted (selecting 天气好
//     in "今天，天气好" does not highlight the 天气好 inside "今天天气好"). Marks
//     skip the live selection's own node and are cleared without normalize(),
//     so the active selection is never disrupted.

const HL_CLASS = 'fv-sel-hl';
const MIN_LEN = 2;
const MAX_MATCHES = 300;
const MAX_NODES = 3000;
const WORD_RE = /[\p{L}\p{N}_]/u;
const SCOPE_SEL = '.fv-content, .fv-pg-output, .fv-csv-wrap';

function isWord(ch: string): boolean {
  return ch.length > 0 && WORD_RE.test(ch[0]);
}

let enabled = false;
export function enableSmartSelection(): void {
  if (enabled) return;
  enabled = true;
  document.addEventListener('dblclick', onDoubleClick);
  document.addEventListener('selectionchange', onSelectionChange);
}

// ── Double-click: expand to the full token under the cursor ─────────────
function onDoubleClick(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;

  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const v = target.value;
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    // Pivot at selectionStart only — Chrome's native dblclick can extend past
    // a space for CJK immediately before whitespace, so native `end` leaks.
    const [s2, e2] = expandToken(v, start);
    if (s2 !== start || e2 !== end) target.setSelectionRange(s2, e2);
    return;
  }

  // Locate the text node at the click point (coordinate-based — independent of
  // native-selection timing) and expand the token around it.
  const fn = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint;
  const point = fn ? fn.call(document, e.clientX, e.clientY) : null;
  if (!point) return;
  const node = point.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return;
  const text = node.nodeValue ?? '';
  const [s, en] = expandToken(text, point.startOffset);
  if (en <= s) return;
  const r = document.createRange();
  r.setStart(node, s);
  r.setEnd(node, en);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(r);
}

// Expand the token containing `anchor` outward to the nearest non-word
// boundaries on both sides. Pivot at a single anchor (the click point / the
// native selection's left edge) rather than trusting a pre-existing range:
// Chrome's dblclick can select across a space for CJK before whitespace.
function expandToken(text: string, anchor: number): [number, number] {
  let s = anchor, e = anchor;
  while (s > 0 && isWord(text[s - 1])) s--;
  while (e < text.length && isWord(text[e])) e++;
  return [s, e];
}

// ── Selection highlight (whole-token, case-insensitive, ≥2 chars) ───────
let debounce: ReturnType<typeof setTimeout> | null = null;
let lastScope: HTMLElement | null = null;

function onSelectionChange(): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(updateHighlight, 150);
}

function scopeRoot(node: Node | null): HTMLElement | null {
  const el = node instanceof HTMLElement ? node : node?.parentElement ?? null;
  return el ? el.closest(SCOPE_SEL) : null;
}

function updateHighlight(): void {
  // Always clear previous marks first (even if we won't re-add), tracked by
  // lastScope so a selection moving between scopes clears the old one.
  if (lastScope && lastScope.isConnected) clearMarks(lastScope);
  lastScope = null;

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  const scope = scopeRoot(sel.anchorNode);
  if (!scope) return;
  const needle = sel.toString().trim();
  if (needle.length < MIN_LEN) return;
  if (/[\r\n]/.test(needle)) return; // multi-line selection (e.g. triple-click) — skip

  lastScope = scope;
  const anchor = sel.anchorNode;
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(needle)}(?![\\p{L}\\p{N}_])`, 'giu');

  // Collect matches per text node (skip the live selection's node and any text
  // already inside a search highlight, which has its own colour).
  const byNode = new Map<Text, Array<[number, number]>>();
  let count = 0, scanned = 0;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Text): number {
      if (node === anchor) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (p && p.closest('.fv-highlight')) return NodeFilter.FILTER_REJECT;
      return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode()) && count < MAX_MATCHES && scanned < MAX_NODES) {
    scanned++;
    const text = (n as Text).nodeValue as string;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    const spans: Array<[number, number]> = [];
    while ((m = re.exec(text)) !== null) {
      spans.push([m.index, m.index + m[0].length]);
      if (++count >= MAX_MATCHES) break;
      if (m.index === re.lastIndex) re.lastIndex++; // guard zero-length loop
    }
    if (spans.length) byNode.set(n as Text, spans);
  }

  // Apply descending within each node so earlier offsets stay valid as we split.
  for (const [node, spans] of byNode) {
    spans.sort((a, b) => b[0] - a[0]);
    for (const [s, e] of spans) wrapMark(node, s, e);
  }
}

function wrapMark(node: Text, start: number, end: number): void {
  const mark = document.createElement('mark');
  mark.className = HL_CLASS;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  try {
    range.surroundContents(mark);
  } catch { /* range crosses an element boundary — skip this match */ }
}

function clearMarks(scope: HTMLElement): void {
  const marks = scope.querySelectorAll(`mark.${HL_CLASS}`);
  marks.forEach((m) => {
    const p = m.parentNode;
    if (!p) return;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m);
    // Deliberately no normalize(): merging text nodes would invalidate the
    // active selection's anchor if it sits in a node we just unwrapped.
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
