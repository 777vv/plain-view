// Mirror-overlay highlight for <textarea> elements (the playground input and
// the memo editor). A textarea can't show inline highlights, so a "mirror" div
// is floated exactly over it (ResizeObserver-kept aligned) carrying the same
// text rendered transparent, with match <span>s on top; the textarea itself
// sits above with a transparent background. Text-layout metrics are copied
// from the textarea so the marks line up with the real text.
//
// Selection inside a textarea isn't exposed via window.getSelection, so we read
// selectionStart/End on selectionchange (only when this textarea is active).
// Whole-token matching mirrors src/ui/selection.ts: a match must be bordered by
// non-word chars on both sides (case-insensitive, ≥2 chars).

const TA_HL = 'fv-ta-hl';
const MIN_LEN = 2;
const MAX_MATCHES = 300;
const WORD_RE = /[\p{L}\p{N}_]/u;

export function attachTextareaHighlight(ta: HTMLTextAreaElement): void {
  if (ta.dataset.fvTaHl) return;
  ta.dataset.fvTaHl = '1';

  const parent = ta.parentElement;
  if (!parent) return;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

  const mirror = document.createElement('div');
  mirror.className = 'fv-ta-mirror';
  mirror.style.position = 'absolute';
  mirror.style.zIndex = '0';
  mirror.style.pointerEvents = 'none';
  mirror.style.overflow = 'hidden';
  mirror.style.color = 'transparent';
  parent.insertBefore(mirror, ta);

  // Textarea paints on top; transparent background so the mirror shows through.
  ta.style.position = 'relative';
  ta.style.zIndex = '1';
  mirror.style.background = getComputedStyle(ta).backgroundColor;
  ta.style.background = 'transparent';

  function copyMetrics(): void {
    const cs = getComputedStyle(ta);
    mirror.style.font = cs.font;
    mirror.style.lineHeight = cs.lineHeight;
    mirror.style.letterSpacing = cs.letterSpacing;
    mirror.style.padding = cs.padding;
    mirror.style.borderWidth = cs.borderWidth;
    mirror.style.borderStyle = 'solid';
    mirror.style.borderColor = 'transparent';
    mirror.style.boxSizing = cs.boxSizing;
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordBreak = cs.wordBreak || 'break-word';
    mirror.style.overflowWrap = cs.overflowWrap || 'anywhere';
    mirror.style.tabSize = cs.tabSize;
  }

  function align(): void {
    mirror.style.top = `${ta.offsetTop}px`;
    mirror.style.left = `${ta.offsetLeft}px`;
    mirror.style.width = `${ta.offsetWidth}px`;
    mirror.style.height = `${ta.offsetHeight}px`;
    mirror.scrollTop = ta.scrollTop;
  }

  function syncText(): void {
    const v = ta.value;
    // A textarea reserves a trailing blank line for a final newline; mirror it
    // so the last line aligns.
    mirror.textContent = v.endsWith('\n') ? v + '\n' : v;
    mirror.scrollTop = ta.scrollTop;
  }

  copyMetrics();
  syncText();
  align();

  // Re-copy metrics (font-size can change via the toolbar) + realign on resize.
  const ro = new ResizeObserver(() => { copyMetrics(); align(); });
  ro.observe(ta);
  ta.addEventListener('input', () => { syncText(); align(); });
  ta.addEventListener('scroll', () => { mirror.scrollTop = ta.scrollTop; });

  let debounce: ReturnType<typeof setTimeout> | null = null;
  document.addEventListener('selectionchange', () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(update, 150);
  });

  function update(): void {
    syncText(); // reset to plain text (clears previous marks)
    if (document.activeElement !== ta) return;
    const s = ta.selectionStart ?? 0;
    const e = ta.selectionEnd ?? 0;
    if (s === e) return;
    const needle = ta.value.slice(s, e).trim();
    if (needle.length < MIN_LEN || /[\r\n]/.test(needle)) return;
    paint(needle);
  }

  function paint(needle: string): void {
    const node = mirror.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const text = (node as Text).data;
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(needle)}(?![\\p{L}\\p{N}_])`, 'giu');
    const spans: Array<[number, number]> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      spans.push([m.index, m.index + m[0].length]);
      if (spans.length >= MAX_MATCHES) break;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    for (let i = spans.length - 1; i >= 0; i--) { // descending: keep offsets valid as we split
      const [ms, me] = spans[i];
      const span = document.createElement('span');
      span.className = TA_HL;
      const r = document.createRange();
      r.setStart(node as Text, ms);
      r.setEnd(node as Text, me);
      try { r.surroundContents(span); } catch { /* range crosses a node — skip */ }
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
