// Playground page — paste any text and format it on the fly.

import { setupPage, copyText, injectStyles } from '../ui/common';
import { enableSmartSelection } from '../ui/selection';
import { attachTextareaHighlight } from '../ui/textarea-highlight';
import { t, isZh } from '../ui/i18n';
import { cycleFontSize, getStoredFontSize, fontSizeLabel, FontSize } from '../ui/fontSize';

// Pure renderer functions (no DOM mounting)
import { mdToHtml }                                 from '../renderers/markdown';
import { formatSQL, highlight as highlightSql }    from '../renderers/sql';

// Decoders
import { processBase64 }  from '../decoders/base64';
import { processUrl }     from '../decoders/url';
import { generateQr }     from '../decoders/qr';

// Diff
import { renderDiffPanels } from './diffView';

// Detect module is no longer used here (Auto mode removed), but keep the file
// in place — other modules may still reference DetectedFormat.

// Modes for the single-input formats (everything except diff, which has two)
type SingleMode = 'json' | 'markdown' | 'sql' | 'base64' | 'url' | 'qr' | 'translate';
type Mode = SingleMode | 'diff' | 'memo';

// ── Persistence ───────────────────────────────────────────────
// Each single-input format keeps its own draft; switching formats does not
// wipe the others. The diff mode keeps its own pair of textareas separately.
type StoredState = {
  mode?: Mode;
  inputs?: Partial<Record<SingleMode, string>>;
  diffLeft?: string;
  diffRight?: string;
  jsonView?: JsonView;
  b64Dir?: Base64Dir;
  splitRatio?: number;
};

const STORAGE_KEY = 'pg_state';
let state: StoredState = {};
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ [STORAGE_KEY]: state }).catch(() => { /* ignore */ });
  }, 300);
}

// ── Soft size limit ──────────────────────────────────────────
// The gutter's per-line height measurement (attachWrappedGutter) plus the
// full-output re-render on every keystroke is O(N) DOM + O(N) forced reflows.
// Past these thresholds the main thread freezes for seconds, so we pause the
// real-time formatting and show a warning card instead. The textarea stays
// editable/scrollable/copyable; a "format anyway" button lets the user force
// a one-shot render (still skipping the line-number gutter).
const SOFT_LIMIT_BYTES = 1_000_000;   // ~1 MB
const SOFT_LIMIT_LINES  = 20_000;     // 20k lines
// Markdown is heavier per byte: mdToHtml renders then mdLineMap reads
// getBoundingClientRect() on every block (forced layout), and the input→output
// scroll sync linearly scans the gutter on every scroll. Use a stricter cap.
const MD_LIMIT_BYTES = 500_000;       // 500 KB
const MD_LIMIT_LINES = 10_000;        // 10k lines
function isOverLimit(text: string, mode?: string): boolean {
  const isMd = mode === 'markdown';
  const byteLimit = isMd ? MD_LIMIT_BYTES : SOFT_LIMIT_BYTES;
  const lineLimit = isMd ? MD_LIMIT_LINES : SOFT_LIMIT_LINES;
  return text.length > byteLimit || text.split('\n').length > lineLimit;
}
function describeSize(text: string): string {
  const kb = text.length > 1_000_000
    ? (text.length / 1_000_000).toFixed(2) + ' MB'
    : (text.length / 1024).toFixed(1) + ' KB';
  const lines = text.split('\n').length;
  return kb + ' · ' + lines.toLocaleString() + ' ' + t('行', 'lines');
}

// ── DOM building ──────────────────────────────────────────────
// All of these are initialized synchronously inside `build()` (called from the
// boot IIFE) before any other code references them; the `!` assertions tell
// TypeScript to trust that.
let input!: HTMLTextAreaElement;
let output!: HTMLDivElement;
let outputHeader!: HTMLElement;
let chips!: HTMLElement;
let chipsTrack: HTMLElement | null = null;
let copyBtn!: HTMLButtonElement;
let split!: HTMLElement;
let inputScroll!: HTMLElement;
let currentMode: Mode = 'json';

// Cached cumulative offsetTops of each gutter row (in content-scroll pixels).
// Refreshed by attachWrappedGutter; consumed by markdownScrollSync via binary
// search so scrolling never reads layout (offsetTop) per row — that read could
// trigger a reflow and made multi-thousand-line docs janky on scroll.
let gutterTops: number[] = [];

let diffShell!: HTMLElement;
let diffLeft!:  HTMLTextAreaElement;
let diffRight!: HTMLTextAreaElement;
let diffRefresh: (() => void) | null = null;
let diffDebounce: ReturnType<typeof setTimeout> | null = null;

let memoTimer: ReturnType<typeof setTimeout> | null = null;

let refreshInputGutter: (() => void) | null = null;

let enabledFeatures: Set<string> = new Set();
let moduleOrder: string[] = [];        // ordered module keys (drives the tab row order)
let disabledSet: Set<string> = new Set();
let settingsBtn: HTMLButtonElement | null = null;
let settingsPanel: HTMLElement | null = null;

// Module order + enabled state are managed inside the Playground now (the
// popup's feature list was removed). `disabledFormats` stays the source of
// truth for disabled IDs — the content script also reads it to skip rendering
// those file formats — and `pg_order` holds the tab order. Both are validated
// and cleaned of ghost entries on load.
async function loadFeatures(): Promise<void> {
  const data = await chrome.storage.local.get(['disabledFormats', 'pg_order']);
  const storedOrder = (data['pg_order'] as string[]) ?? [];
  const orderSet = new Set(storedOrder);
  const orderValid =
    storedOrder.length === CANON_MODULES.length &&
    CANON_MODULES.every((k) => orderSet.has(k));
  moduleOrder = orderValid ? storedOrder : [...CANON_MODULES];
  const rawDisabled = (data['disabledFormats'] as string[]) ?? [];
  const known = new Set(CANON_MODULES);
  disabledSet = new Set(rawDisabled.filter((id) => known.has(id)));
  enabledFeatures = new Set(moduleOrder.filter((k) => !disabledSet.has(k)));
  if (!orderValid || disabledSet.size !== rawDisabled.length) {
    await chrome.storage.local.set({ disabledFormats: [...disabledSet], pg_order: moduleOrder });
  }
}

const ALL_LABELS: { key: Mode; zh: string; en: string }[] = [
  { key: 'json',      zh: 'JSON',        en: 'JSON' },
  { key: 'markdown',  zh: 'Markdown',    en: 'Markdown' },
  { key: 'sql',       zh: 'SQL',         en: 'SQL' },
  { key: 'base64',    zh: 'Base64',      en: 'Base64' },
  { key: 'url',       zh: 'URL',         en: 'URL' },
  { key: 'translate', zh: '翻译',         en: 'Translate' },
  { key: 'diff',      zh: '文本对比',     en: 'Compare' },
  { key: 'qr',        zh: '二维码',       en: 'QR Code' },
  { key: 'memo',      zh: '备忘录',       en: 'Memo' },
];

// Canonical module order + set, derived from ALL_LABELS (single source).
const CANON_MODULES: string[] = ALL_LABELS.map((l) => l.key);

function rebuildChips(): void {
  loadFeatures().then(renderChips);
}

// Render the module tab row in the stored order (enabled modules only), then
// re-append the settings gear so it always sits at the right end of the row.
function renderChips(): void {
  const track = chipsTrack;
  if (!track) return;
  const visible = moduleOrder
    .map((k) => ALL_LABELS.find((l) => l.key === k))
    .filter((l): l is { key: Mode; zh: string; en: string } => !!l && enabledFeatures.has(l.key));
  track.innerHTML = '';
  visible.forEach(({ key, zh, en }) => {
    const c = document.createElement('button');
    c.className = 'fv-pg-chip';
    c.dataset.mode = key;
    c.textContent = isZh() ? zh : en;
    c.addEventListener('click', () => switchMode(key));
    track.appendChild(c);
  });
  if (!visible.some((l) => l.key === currentMode)) {
    switchMode(visible[0]?.key ?? 'json');
  } else {
    updateChips();
  }
}

// ── Module settings (gear at the right end of the tab row) ──────
// Popover listing every module in order: drag rows to reorder, toggle to
// enable/disable. Persists to disabledFormats + pg_order and re-renders chips.
const GEAR_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37 1 .608 2.296.07 2.572-1.065z"/>' +
  '<circle cx="12" cy="12" r="3"/></svg>';

function buildSettings(): void {
  settingsBtn = document.createElement('button');
  settingsBtn.className = 'fv-pg-chip fv-pg-settings-btn';
  settingsBtn.innerHTML = GEAR_SVG;
  settingsBtn.title = t('功能管理', 'Manage modules');
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();             // don't let the document handler close it straight away
    toggleSettings();
  });

  settingsPanel = document.createElement('div');
  settingsPanel.className = 'fv-pg-settings';
  settingsPanel.style.display = 'none';
  const head = document.createElement('div');
  head.className = 'fv-pg-settings-head';
  head.textContent = t('拖动排序 · 点击开关', 'Drag to reorder · toggle on/off');
  settingsPanel.appendChild(head);
  const list = document.createElement('div');
  list.className = 'fv-pg-settings-list';
  settingsPanel.appendChild(list);
  wireSettingsList(list);
  document.body.appendChild(settingsPanel);

  // Close on outside click (the gear stops propagation, so it toggles instead).
  document.addEventListener('click', (e) => {
    if (!settingsPanel || settingsPanel.style.display === 'none') return;
    if (settingsPanel.contains(e.target as Node) || e.target === settingsBtn) return;
    closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsPanel && settingsPanel.style.display !== 'none') closeSettings();
  });
}

function toggleSettings(): void {
  if (!settingsPanel) return;
  if (settingsPanel.style.display === 'none') openSettings(); else closeSettings();
}

function openSettings(): void {
  if (!settingsPanel || !settingsBtn) return;
  renderSettingsList();
  const r = settingsBtn.getBoundingClientRect();
  settingsPanel.style.top = `${r.bottom + 6}px`;
  settingsPanel.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  settingsPanel.style.display = '';
  settingsPanel.classList.remove('fv-overlay-in');
  void settingsPanel.offsetWidth; // restart the entrance animation
  settingsPanel.classList.add('fv-overlay-in');
}

function closeSettings(): void {
  if (settingsPanel) settingsPanel.style.display = 'none';
}

function renderSettingsList(): void {
  if (!settingsPanel) return;
  const list = settingsPanel.querySelector<HTMLElement>('.fv-pg-settings-list');
  if (!list) return;
  list.innerHTML = '';
  moduleOrder.forEach((key) => {
    const label = ALL_LABELS.find((l) => l.key === key);
    if (!label) return;
    const row = document.createElement('div');
    row.className = 'fv-pg-settings-row' + (disabledSet.has(key) ? ' is-disabled' : '');
    row.dataset.key = key;
    row.draggable = true;

    const handle = document.createElement('span');
    handle.className = 'fv-pg-settings-handle';
    handle.textContent = '⋮⋮';

    const name = document.createElement('span');
    name.className = 'fv-pg-settings-name';
    name.textContent = isZh() ? label.zh : label.en;

    const sw = document.createElement('label');
    sw.className = 'fv-pg-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !disabledSet.has(key);
    const track = document.createElement('span');
    track.className = 'fv-pg-toggle-track';
    sw.append(input, track);
    input.addEventListener('change', () => {
      if (input.checked) {
        disabledSet.delete(key);
      } else {
        // Never allow turning off the last enabled module.
        const remaining = moduleOrder.filter((k) => !disabledSet.has(k) && k !== key);
        if (remaining.length === 0) { input.checked = true; return; }
        disabledSet.add(key);
      }
      row.classList.toggle('is-disabled', disabledSet.has(key));
      void persistFeatures();
    });

    row.append(handle, name, sw);
    list.appendChild(row);
  });
}

// HTML5 drag-and-drop reorder within the settings list.
function wireSettingsList(list: HTMLElement): void {
  let dragging = false;
  list.addEventListener('dragstart', (e) => {
    const row = (e.target as HTMLElement).closest('.fv-pg-settings-row') as HTMLElement | null;
    if (!row) return;
    dragging = true;
    row.classList.add('dragging');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  list.addEventListener('dragover', (e) => {
    if (!dragging) return;
    const row = (e.target as HTMLElement).closest('.fv-pg-settings-row') as HTMLElement | null;
    if (!row) return;
    e.preventDefault();
    const moved = list.querySelector('.dragging');
    if (!moved || moved === row) return;
    const rect = row.getBoundingClientRect();
    if (e.clientY > rect.top + rect.height / 2) row.after(moved);
    else row.before(moved);
  });
  const finish = (): void => {
    list.querySelector('.dragging')?.classList.remove('dragging');
    if (dragging) { dragging = false; commitSettingsOrder(); }
  };
  list.addEventListener('drop', (e) => { e.preventDefault(); finish(); });
  list.addEventListener('dragend', finish);
}

function commitSettingsOrder(): void {
  if (!settingsPanel) return;
  moduleOrder = Array.from(
    settingsPanel.querySelectorAll<HTMLElement>('.fv-pg-settings-row'),
  ).map((r) => r.dataset.key!);
  void persistFeatures();
}

async function persistFeatures(): Promise<void> {
  await chrome.storage.local.set({ disabledFormats: [...disabledSet], pg_order: moduleOrder });
  enabledFeatures = new Set(moduleOrder.filter((k) => !disabledSet.has(k)));
  renderChips();
}

// ── Boot ──────────────────────────────────────────────────────
(async () => {
  await injectStyles();
  setupPage(t('Plain View 工作台', 'Plain View Playground'));
  document.body.classList.add('fv-playground-body');
  enableSmartSelection();

  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    if (data[STORAGE_KEY] && typeof data[STORAGE_KEY] === 'object') {
      state = data[STORAGE_KEY] as StoredState;
    }
  } catch { /* fresh state */ }
  if (state.mode) currentMode = state.mode;
  if (!state.inputs) state.inputs = {};

  await loadFeatures();

  // Default to first enabled feature if saved mode is disabled
  if (!enabledFeatures.has(currentMode as string)) {
    currentMode = ALL_LABELS.find((l) => enabledFeatures.has(l.key))?.key ?? 'json';
  }

  build();

  // Restore the saved input for the *current* format only; others stay parked
  // in state.inputs and will load when the user switches to them.
  if (currentMode !== 'diff' && currentMode !== 'memo') {
    input.value = state.inputs[currentMode] ?? '';
  }
  if (state.diffLeft)   diffLeft.value  = state.diffLeft;
  if (state.diffRight)  diffRight.value = state.diffRight;

  applyPlaceholder();

  // Handoff from right-click context menu (background sets a key in storage).
  const m = location.hash.match(/k=([^&]+)/);
  if (m) {
    const key = decodeURIComponent(m[1]);
    try {
      const data = await chrome.storage.local.get(key);
      const text = data[key];
      if (typeof text === 'string') {
        input.value = text;
        if (currentMode !== 'diff' && currentMode !== 'memo') {
          state.inputs![currentMode] = text;
        }
        scheduleSave();
      }
      chrome.storage.local.remove(key).catch(() => { /* ignore */ });
    } catch { /* ignore */ }
    history.replaceState(null, '', location.pathname);
  }

  runFormat();
})();

// Rebuild chips when the popup toggles features
chrome.storage.onChanged.addListener((changes) => {
  if (changes['disabledFormats'] || changes['pg_order']) rebuildChips();
  // C4: cross-tab sync. When another tab writes playground state or memo
  // data, merge it in. For state.inputs we only take drafts of modes that
  // aren't currently active (so we never clobber what the user is typing
  // here). For memos we skip the reload entirely while a memo editor field
  // has focus — the user's in-progress edit wins locally; the other tab's
  // write will land on next blur/reload (accepted trade-off of "live").
  if (changes[STORAGE_KEY] && state) {
    const incoming = changes[STORAGE_KEY].newValue as StoredState | undefined;
    if (incoming && incoming.inputs) {
      if (!state.inputs) state.inputs = {};
      for (const key of Object.keys(incoming.inputs) as SingleMode[]) {
        if (key !== currentMode && incoming.inputs[key] !== undefined) {
          state.inputs[key] = incoming.inputs[key];
        }
      }
    }
  }
  if (changes[MEMO_KEY] && memoBodyEl) {
    // Don't interrupt an active edit — reload only when the editor is idle.
    const editing = document.activeElement === memoBodyEl || document.activeElement === memoTitleEl;
    if (!editing) reloadMemoFromStorage();
  }
});

// Mode-specific input placeholder. Shown on the left-side textarea.
const PLACEHOLDERS: Record<SingleMode, { zh: string; en: string }> = {
  json:      { zh: '在此粘贴或拖入 JSON 文件,例如 {"a":1}',       en: 'Paste or drop a JSON file, e.g. {"a":1}' },
  markdown:  { zh: '在此粘贴或拖入 Markdown,例如 # 标题\n- 列表',  en: 'Paste Markdown, e.g. # Title\n- list item' },
  sql:       { zh: '在此粘贴或拖入 SQL,例如 SELECT * FROM users',  en: 'Paste SQL, e.g. SELECT * FROM users' },
  base64:    { zh: '在这里粘贴 Base64 / 文本',                     en: 'Paste Base64 text (or plain text to encode)' },
  url:       { zh: '在这里粘贴 URL,例如 https://example.com/p?a=1',en: 'Paste a URL, e.g. https://example.com/p?a=1' },
  qr:        { zh: '在这里输入要生成二维码的文本',                  en: 'Enter text to encode as a QR code' },
  translate: { zh: '在这里输入要翻译的文本',                       en: 'Enter text to translate' },
};

function applyPlaceholder(): void {
  if (currentMode === 'diff' || currentMode === 'memo') return;
  const p = PLACEHOLDERS[currentMode as SingleMode];
  input.placeholder = isZh() ? p.zh : p.en;
}

// ── Icons (12px / 14px) ───────────────────────────────────────
const ICONS = {
  copy:     '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="8" height="10" rx="1"/><path d="M6 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/></svg>',
  check:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 8 6 11 13 4"/></svg>',
  clear:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h10"/><path d="M5 5V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M5 5l1 9a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1l1-9"/></svg>',
  fontSize: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14 L8 3 L13 14"/><line x1="5" y1="10" x2="11" y2="10"/></svg>',
  repo:     '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 8v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4"/><polyline points="9 3 13 3 13 7"/><line x1="13" y1="3" x2="7" y2="9"/></svg>',
  pin:      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1l2 4 4 1-3 3 1 4-4-2-4 2 1-4-3-3 4-1 2-4z"/></svg>',
  maximize: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3"/></svg>',
  minimize: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v3H3M10 3v3h3M6 13v-3H3M10 13v-3h3"/></svg>',
};

function iconBtn(svg: string, tip: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'fv-btn';
  b.innerHTML = svg;
  b.dataset.tip = tip;
  return b;
}

function fontSizeTip(size: FontSize): string {
  return isZh() ? `字号:${fontSizeLabel(size)}` : `Font size: ${fontSizeLabel(size)}`;
}

// Build a gutter whose line-number rows match the *visual* height of each
// logical line in a wrapping textarea. A hidden mirror div measures how tall
// each line renders (1 row, or more if it wraps), so line numbers stay aligned
// even when text wraps. Returns a refresh() to call on input/resize.
function attachWrappedGutter(ta: HTMLTextAreaElement, gutterInner: HTMLElement): () => void {
  const mirror = document.createElement('div');
  mirror.style.cssText =
    'position:absolute;visibility:hidden;left:-9999px;top:0;' +
    'white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;box-sizing:border-box;';
  document.body.appendChild(mirror);

  function refresh(): void {
    const cs = getComputedStyle(ta);
    mirror.style.fontFamily  = cs.fontFamily;
    mirror.style.fontSize    = cs.fontSize;
    mirror.style.lineHeight  = cs.lineHeight;
    mirror.style.paddingLeft = cs.paddingLeft;
    mirror.style.paddingRight = cs.paddingRight;
    mirror.style.width = ta.clientWidth + 'px';

    const lines = ta.value.split('\n');

    // Build the measurement mirror: one div per logical line. We append them
    // all up front (a single write batch) before reading any height.
    mirror.innerHTML = '';
    const blocks: HTMLDivElement[] = [];
    // Use a DocumentFragment so the mirror only reflows once on append, not
    // once per line.
    const frag = document.createDocumentFragment();
    for (const ln of lines) {
      const d = document.createElement('div');
      d.style.cssText = 'white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;';
      d.textContent = ln === '' ? '​' : ln;
      frag.appendChild(d);
      blocks.push(d);
    }
    mirror.appendChild(frag);

    // Read every line height in one tight loop with NO interleaved writes.
    // Reading offsetHeight after all appends are done lets the browser batch
    // them into a single layout pass — the previous read/write-per-line
    // alternation (layout thrashing) was the main freeze source when pasting
    // thousands of lines.
    const heights = new Array<number>(lines.length);
    for (let i = 0; i < lines.length; i++) {
      heights[i] = blocks[i].offsetHeight;
    }

    // Now write: rebuild the gutter rows and cache cumulative offsetTops for
    // the scroll-sync binary search. All writes, no reads → one more layout.
    gutterInner.innerHTML = '';
    gutterTops = new Array(lines.length);
    const gfrag = document.createDocumentFragment();
    let cum = 0;
    for (let i = 0; i < lines.length; i++) {
      const h = heights[i];
      gutterTops[i] = cum;
      cum += h;
      const g = document.createElement('div');
      g.className = 'fv-pg-gutter-ln';
      g.textContent = String(i + 1);
      g.style.height = h + 'px';
      gfrag.appendChild(g);
    }
    gutterInner.appendChild(gfrag);
  }

  return refresh;
}

function build(): void {
  // ── Toolbar ─────────────────────────────────────────────────
  const toolbar = document.createElement('div');
  toolbar.className = 'fv-toolbar';

  const left = document.createElement('div');
  left.className = 'fv-toolbar-left';

  const wordmark = document.createElement('span');
  wordmark.className = 'fv-wordmark';
  wordmark.textContent = 'plain.view';
  left.appendChild(wordmark);

  const right = document.createElement('div');
  right.className = 'fv-toolbar-right';

  copyBtn = iconBtn(ICONS.copy,  t('复制结果', 'Copy result'));
  copyBtn.addEventListener('click', () => {
    // memo mode: copy the active memo's content directly.
    const txt = currentMode === 'memo' ? (currentMemo()?.content ?? null)
      : currentMode === 'markdown' ? (currentMd()?.content ?? null)
      : currentOutputText();
    if (txt == null || txt === '') return;
    copyText(txt).then(() => {
      const orig = copyBtn.innerHTML;
      copyBtn.innerHTML = ICONS.check;
      setTimeout(() => { copyBtn.innerHTML = orig; }, 1200);
    });
  });

  const clearBtn = iconBtn(ICONS.clear, t('清空当前内容', 'Clear current content'));
  clearBtn.addEventListener('click', () => {
    // Confirm before clearing — the action is destructive and the saved draft
    // is overwritten on the next debounced flush, so it can't be undone.
    const msg = currentMode === 'memo'
      ? t('确定清空当前备忘录的标题和内容吗?', 'Clear this memo\'s title and content?')
      : currentMode === 'markdown'
        ? t('确定清空当前文档的标题和内容吗?', 'Clear this document\'s title and content?')
        : currentMode === 'diff'
          ? t('确定清空两侧对比文本吗?', 'Clear both sides of the comparison?')
          : t('确定清空当前输入内容吗?', 'Clear the current input?');
    if (!window.confirm(msg)) return;
    if (currentMode === 'memo') {
      const f = currentMemo();
      if (f && memoTitleEl && memoBodyEl) {
        memoTitleEl.value = '';
        memoBodyEl.value = '';
        f.title = '';
        f.content = '';
        renderMemoList();
      }
      saveMemo();
    } else if (currentMode === 'markdown') {
      const f = currentMd();
      if (f && mdTitleEl && mdEditEl) {
        mdTitleEl.value = '';
        mdEditEl.value = '';
        f.title = '';
        f.content = '';
        renderMdList();
        renderMdPreview();
      }
      saveMd();
    } else if (currentMode === 'diff') {
      diffLeft.value  = '';
      diffRight.value = '';
      state.diffLeft  = '';
      state.diffRight = '';
      if (diffRefresh) diffRefresh();
    } else {
      input.value = '';
      if (state.inputs) state.inputs[currentMode as SingleMode] = '';
      // Rebuild the line-number gutter so stale row numbers are cleared
      // (syncInput also re-collapses the textarea height for the empty input).
      if (refreshInputGutter) refreshInputGutter();
      runFormat();
      input.focus();
    }
    scheduleSave();
  });

  const fontBtn  = iconBtn(ICONS.fontSize, fontSizeTip(getStoredFontSize()));
  fontBtn.addEventListener('click', () => {
    const next = cycleFontSize();
    fontBtn.dataset.tip = fontSizeTip(next);
  });

  // Hover-only informational button — the tooltip carries the actual message.
  const pinBtn = iconBtn(ICONS.pin, t(
    '把扩展固定到工具栏,下次一键打开 (★ 收藏本页也行)',
    'Pin the extension to your toolbar for quick access (or bookmark this page)',
  ));
  pinBtn.classList.add('fv-tip-wide');

  const repoBtn  = iconBtn(ICONS.repo, t('查看源码', 'View source'));
  repoBtn.addEventListener('click', () => {
    window.open('https://github.com/777vv/plain-view', '_blank', 'noopener,noreferrer');
  });

  const divider = document.createElement('div');
  divider.className = 'fv-divider';

  right.append(copyBtn, clearBtn, divider, fontBtn, divider.cloneNode() as HTMLElement, pinBtn, repoBtn);

  toolbar.append(left, right);
  document.body.append(toolbar);

  // ── Chips row ───────────────────────────────────────────────
  // The bar holds a scrollable track of module tabs with the settings gear as
  // a sibling, so the gear stays pinned at the far right instead of scrolling.
  chips = document.createElement('div');
  chips.className = 'fv-pg-chips';
  chipsTrack = document.createElement('div');
  chipsTrack.className = 'fv-pg-chips-track';
  chips.appendChild(chipsTrack);
  buildSettings();            // creates the gear (settingsBtn) + popover
  chips.appendChild(settingsBtn!);
  document.body.append(chips);
  renderChips();

  // ── Split: input pane | output pane ─────────────────────────
  split = document.createElement('div');
  split.className = 'fv-pg-split';

  // Input pane: header + numbered layout (gutter + textarea)
  const inputPane = document.createElement('div');
  inputPane.className = 'fv-pg-pane';
  const inputHeader = document.createElement('div');
  inputHeader.className = 'fv-pg-pane-header';
  const inputTitle = document.createElement('span');
  inputTitle.textContent = t('输入', 'Input');
  inputHeader.appendChild(inputTitle);

  const headerSpacer = document.createElement('span');
  headerSpacer.style.cssText = 'flex:1;';
  inputHeader.appendChild(headerSpacer);

  // Maximize / restore button.
  const inputMaxBtn = iconBtn(ICONS.maximize, t('全屏', 'Maximize'));
  inputMaxBtn.style.padding = '2px 6px';
  inputHeader.appendChild(inputMaxBtn);

  // Gutter + textarea scroll together in a shared container so wrapping
  // doesn't break alignment.
  inputScroll = document.createElement('div');
  inputScroll.style.cssText = 'flex:1;min-height:0;overflow:auto;';

  const inputNumbered = document.createElement('div');
  inputNumbered.className = 'fv-pg-numbered';

  const inputGutter = document.createElement('div');
  inputGutter.className = 'fv-pg-gutter';
  inputGutter.style.paddingTop = '14px';
  const inputGutterInner = document.createElement('div');
  inputGutter.appendChild(inputGutterInner);

  const inputContent = document.createElement('div');
  inputContent.className = 'fv-pg-content';

  input = document.createElement('textarea');
  input.className = 'fv-pg-input';
  input.spellcheck = false;
  // Auto-expand to content height so the parent scroll container handles
  // all scrolling. The gutter and content then scroll together naturally.
  input.style.overflow = 'hidden';
  input.style.resize = 'none';
  input.style.minHeight = 'calc(100% - 4px)';

  let debounce: ReturnType<typeof setTimeout> | null = null;

  const refreshInputGutterFn = attachWrappedGutter(input, inputGutterInner);

  function expandTextarea(): void {
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  }

  function syncInput(): void {
    expandTextarea();
    refreshInputGutterFn();
  }

  input.addEventListener('input', () => {
    if (currentMode !== 'diff' && currentMode !== 'memo' && state.inputs) {
      state.inputs[currentMode] = input.value;
    }
    scheduleSave();
    // Size guard: the gutter rebuilds one div + reads offsetHeight per line
    // (forced reflow), so above the soft limit we skip it entirely — only the
    // textarea's own height is adjusted. runFormat() shows the warning card.
    const overLimit = currentMode !== 'diff' && currentMode !== 'memo' && isOverLimit(input.value, currentMode);
    if (!overLimit) syncInput();
    else expandTextarea();
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => runFormat(overLimit), 120);
  });

  refreshInputGutter = syncInput;

  // Tab / Shift+Tab indentation inside the textarea (instead of losing focus).
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const ta = input;
    const s = ta.selectionStart, en = ta.selectionEnd;
    const INDENT = '  ';
    if (e.shiftKey) {
      // Outdent the current line: remove up to 2 leading spaces.
      const before = ta.value.slice(0, s);
      const lineStart = before.lastIndexOf('\n') + 1;
      const lineHead = ta.value.slice(lineStart, lineStart + 2);
      if (lineHead === INDENT) {
        ta.setSelectionRange(lineStart, lineStart + 2);
        document.execCommand('insertText', false, '');
        const removed = s >= lineStart + 2 ? s - 2 : s - (s - lineStart);
        ta.setSelectionRange(Math.max(lineStart, removed), Math.max(lineStart, removed + (en - s)));
      }
    } else {
      document.execCommand('insertText', false, INDENT);
    }
  });

  // ResizeObserver keeps the gutter in sync with the textarea's font metrics
  // and soft-wrapped line heights. Above the soft limit we skip the gutter
  // rebuild to avoid the per-line reflow storm.
  const inputObserver = new ResizeObserver(() => {
    if (!isOverLimit(input.value, currentMode)) syncInput();
  });
  inputObserver.observe(input);

  // Drag-and-drop file → load content + auto-switch mode.
  // B7: only intercept when a file is being dropped; plain-text drags fall
  // through to the browser's default insertion so selected text isn't swallowed.
  input.addEventListener('dragover', (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      e.preventDefault();
    }
  });
  input.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files[0];
    if (!file) return; // let the browser insert dragged text natively
    e.preventDefault();
    const ext = file.name.split('.').pop()?.toLowerCase();
    const extToMode: Record<string, Mode> = {
      json: 'json', md: 'markdown', markdown: 'markdown', sql: 'sql',
    };
    const mode = ext ? extToMode[ext] : undefined;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      if (mode) {
        if (mode !== 'diff' && mode !== 'memo' && mode !== 'markdown') {
          if (state.inputs) state.inputs[mode] = text;
          scheduleSave();
        }
        switchMode(mode);
        input.value = text;
        refreshInputGutterFn();
        runFormat();
      } else {
        input.value = text;
        refreshInputGutterFn();
        if (state.inputs && currentMode !== 'diff' && currentMode !== 'memo') {
          state.inputs[currentMode] = input.value;
        }
        scheduleSave();
        runFormat();
      }
    };
    reader.readAsText(file);
  });

  input.style.width = '100%';
  inputContent.appendChild(input);
  inputNumbered.append(inputGutter, inputContent);
  inputScroll.appendChild(inputNumbered);
  inputPane.append(inputHeader, inputScroll);

  // Initial expand + gutter
  requestAnimationFrame(() => syncInput());

  // Output pane: header (sub-chips slot) + output body
  const outputPane = document.createElement('div');
  outputPane.className = 'fv-pg-pane';
  outputHeader = document.createElement('div');
  outputHeader.className = 'fv-pg-pane-header';
  outputHeader.textContent = t('结果', 'Result');

  const outputMaxBtn = iconBtn(ICONS.maximize, t('全屏', 'Maximize'));
  outputMaxBtn.style.cssText = 'padding:2px 6px;margin-left:auto;';
  outputHeader.appendChild(outputMaxBtn);

  output = document.createElement('div');
  output.className = 'fv-pg-output';
  output.tabIndex = 0;
  outputPane.append(outputHeader, output);

  // Resizable divider between the two panes.
  const paneDivider = document.createElement('div');
  paneDivider.className = 'fv-pg-divider';

  // Restore the saved split ratio (default 50/50).
  let splitRatio = typeof state.splitRatio === 'number' ? state.splitRatio : 0.5;
  // B12: below 900px the layout stacks vertically via a media query with
  // !important; in that range we leave gridTemplateColumns alone so the
  // stacked rows take over.
  const isNarrow = () => window.innerWidth <= 900;
  function applySplitRatio(): void {
    if (isNarrow()) return;
    const clamped = Math.max(0.15, Math.min(0.85, splitRatio));
    splitRatio = clamped;
    split.style.gridTemplateColumns =
      `${(clamped * 100).toFixed(2)}% 6px ${((1 - clamped) * 100).toFixed(2)}%`;
  }
  applySplitRatio();
  // Re-apply when crossing the breakpoint so widening the window restores
  // the saved ratio instead of staying stacked.
  window.addEventListener('resize', applySplitRatio);

  let dragging = false;
  paneDivider.addEventListener('mousedown', (e) => {
    if (isNarrow()) return; // vertical layout — divider drag is meaningless
    e.preventDefault();
    dragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = split.getBoundingClientRect();
    splitRatio = (e.clientX - rect.left) / rect.width;
    applySplitRatio();
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    state.splitRatio = splitRatio;
    scheduleSave();
  });

  split.append(inputPane, paneDivider, outputPane);
  document.body.append(split);
  attachTextareaHighlight(input);

  // ── B1: full-pane drop zone for file import ──────────────────
  // A semi-transparent overlay announces "drop to import" while a file is
  // being dragged over the workspace. A counter tolerates dragenter/leave
  // bubbling from child elements so the overlay doesn't flicker.
  const dropzone = document.createElement('div');
  dropzone.className = 'fv-pg-dropzone';
  dropzone.innerHTML = '<div class="fv-pg-dropzone-inner">'
    + '<div class="fv-pg-dropzone-icon">📄</div>'
    + '<div class="fv-pg-dropzone-text">' + t('松开以导入文件', 'Drop file to import') + '</div>'
    + '</div>';
  split.appendChild(dropzone);
  let dragDepth = 0;
  split.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    dragDepth++;
    dropzone.classList.add('active');
  });
  split.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  split.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropzone.classList.remove('active');
  });
  split.addEventListener('drop', (e) => {
    if (!e.dataTransfer || e.dataTransfer.files.length === 0) return;
    // The textarea's own drop handler will read the file; here we just clear
    // the overlay. preventDefault on split stops the browser from navigating
    // to the dropped file.
    e.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('active');
  });

  // ── Maximize / restore single pane ──
  // When maximizing we directly hide the other pane + divider via display:none
  // and collapse the grid to a single column. ESC restores the split view.
  function setMaximize(which: 'input' | 'output' | null): void {
    inputMaxBtn.innerHTML = ICONS.maximize;
    outputMaxBtn.innerHTML = ICONS.maximize;
    // Reset visibility of all three elements first.
    inputPane.style.display = '';
    outputPane.style.display = '';
    paneDivider.style.display = '';
    if (which === 'input') {
      outputPane.style.display = 'none';
      paneDivider.style.display = 'none';
      split.style.gridTemplateColumns = '1fr';
      inputMaxBtn.innerHTML = ICONS.minimize;
    } else if (which === 'output') {
      inputPane.style.display = 'none';
      paneDivider.style.display = 'none';
      split.style.gridTemplateColumns = '1fr';
      outputMaxBtn.innerHTML = ICONS.minimize;
    } else {
      // Restore the saved ratio.
      applySplitRatio();
    }
    // B4: fade the pane that takes over so the swap isn't a hard cut.
    // The target pane is the one still displayed; briefly drop it to 0
    // and let the CSS transition (var(--fv-base)) bring it back.
    const target = which === 'input' ? inputPane : which === 'output' ? outputPane : null;
    if (target) {
      target.style.opacity = '0';
      requestAnimationFrame(() => { target.style.opacity = '1'; });
    }
  }
  let currentMax: 'input' | 'output' | null = null;
  inputMaxBtn.addEventListener('click', () => {
    currentMax = currentMax === 'input' ? null : 'input';
    setMaximize(currentMax);
  });
  outputMaxBtn.addEventListener('click', () => {
    currentMax = currentMax === 'output' ? null : 'output';
    setMaximize(currentMax);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentMax) {
      currentMax = null;
      setMaximize(null);
    }
  });


  // Relay wheel events: if the input is at its boundary and the user keeps
  // scrolling, forward the delta to the output pane.
  inputScroll.addEventListener('wheel', (e) => {
    if (currentMode !== 'markdown') return;
    const atTop = inputScroll.scrollTop <= 0;
    const atBottom = inputScroll.scrollTop >= inputScroll.scrollHeight - inputScroll.clientHeight;
    const scrollingUp = e.deltaY < 0;
    const scrollingDown = e.deltaY > 0;
    if ((atTop && scrollingUp) || (atBottom && scrollingDown)) {
      e.preventDefault();
      output.scrollTop += e.deltaY;
    }
  }, { passive: false });

  // Diff shell: separate layout (hidden by default).
  buildDiffShell();
  buildMemoShell();
  buildMdShell();
}

function setOutputHeader(content: Node | null, stats?: { lines: number; chars: number }): void {
  if (content !== null) {
    // Replace header with provided content (e.g. sub-chips)
    outputHeader.textContent = '';
    outputHeader.appendChild(content);
  } else {
    // Reset to default title — only if children aren't already sub-chips
    // (don't overwrite sub-chips when stats-only update fires)
    if (outputHeader.children.length === 0) {
      outputHeader.textContent = t('结果', 'Result');
    }
  }

  let statsEl = outputHeader.querySelector<HTMLElement>('.fv-pg-stats');
  if (statsEl) statsEl.remove();

  if (stats) {
    statsEl = document.createElement('span');
    statsEl.className = 'fv-pg-stats';
    statsEl.style.cssText = 'margin-left:auto;font-size:10px;font-weight:400;color:var(--fv-text-muted);text-transform:none;letter-spacing:0;';
    statsEl.textContent = `${stats.lines} ${t('行', 'lines')} · ${stats.chars} ${t('字符', 'chars')}`;
    outputHeader.appendChild(statsEl);
  }
}

function resetOutputHeader(): void {
  outputHeader.textContent = t('结果', 'Result');
}

function updateChips(): void {
  chips.querySelectorAll<HTMLElement>('.fv-pg-chip[data-mode]').forEach((c) => {
    c.classList.toggle('active', c.dataset.mode === currentMode);
  });
}

// Switch to a new mode: persist it, swap the input textarea's contents to the
// draft saved for that mode, refresh the placeholder, and re-render the output.
function switchMode(mode: Mode): void {
  currentMode = mode;
  state.mode = mode;
  // Reset any single-pane maximize when changing modes.
  split.classList.remove('fv-pg-max-input', 'fv-pg-max-output');
  if (mode !== 'diff' && mode !== 'memo' && mode !== 'markdown') {
    input.value = (state.inputs && state.inputs[mode]) ?? '';
    // Restore the textarea height + gutter in ONE pass. We used to dispatch a
    // synthetic 'input' event here, but that re-ran the full input listener
    // (syncInput + a debounced runFormat + scheduleSave) and then this function
    // called refreshInputGutter() and runFormat() again — so every switch did
    // double gutter rebuilds + double renders + an unnecessary storage write.
    // For large Markdown drafts that double work froze the tab on switch.
    const overLimit = isOverLimit(input.value, mode);
    if (!overLimit) {
      if (refreshInputGutter) refreshInputGutter();
    } else {
      // Over the soft limit: skip the per-line gutter rebuild, just size the
      // textarea. runFormat() below will show the size-warning card.
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
    }
  }
  applyPlaceholder();
  scheduleSave();
  updateChips();
  runFormat();
  updateCopyBtnState();
}

// ── Formatting pipeline ───────────────────────────────────────
let lastResultText: string | null = null;

// Translation cache
let trLastText = '';
let trLastResult = '';
// B6: inflight guard — only one translate request at a time. A new click
// aborts the previous fetch and disables both buttons until it settles.
let trBusy = false;
let trAbort: AbortController | null = null;

function currentOutputText(): string | null { return lastResultText; }

// Enable/disable the copy button based on whether there is anything to copy
// in the current mode. Called after every mode switch and format run.
function updateCopyBtnState(): void {
  if (!copyBtn) return;
  let hasContent: boolean;
  if (currentMode === 'memo') {
    hasContent = !!currentMemo()?.content;
  } else if (currentMode === 'markdown') {
    hasContent = !!currentMd()?.content;
  } else if (currentMode === 'diff') {
    hasContent = false; // diff has no single "result" to copy
  } else {
    hasContent = lastResultText != null && lastResultText !== '';
  }
  copyBtn.disabled = !hasContent;
  copyBtn.dataset.tip = hasContent ? t('复制结果', 'Copy result') : t('无内容可复制', 'Nothing to copy');
}

function runFormat(skipExpensive?: boolean): void {
  toggleDiffShell(currentMode === 'diff');
  toggleMemoShell(currentMode === 'memo');
  toggleMdShell(currentMode === 'markdown');
  if (currentMode === 'diff' || currentMode === 'memo' || currentMode === 'markdown') return;

  const raw = input.value;
  lastResultText = null;
  resetOutputHeader();

  if (!raw.trim()) {
    showEmptyOutput();
    return;
  }

  // Soft size guard: past the threshold the real-time render + line-number
  // gutter freeze the main thread. Show a warning card instead, unless the
  // user explicitly forced a one-shot render (skipExpensive=true). The forced
  // path still skips syncInput/gutter (the caller is responsible for not
  // rebuilding the gutter), only the output is rendered.
  if (!skipExpensive && isOverLimit(raw, currentMode)) {
    showSizeWarning(raw);
    updateCopyBtnState();
    return;
  }

  if (currentMode === 'qr') {
    output.innerHTML = '';
    try { renderQr(raw); } catch (e) { renderErrorPlaceholder(t('二维码生成失败', 'QR generation failed'), (e as Error).message); }
    return;
  }

  output.innerHTML = '';
  try {
    switch (currentMode) {
      case 'json':      renderJson(raw); break;
      case 'sql':       renderSql(raw); break;
      case 'base64':    renderBase64(raw); break;
      case 'url':       renderUrl(raw); break;
      case 'translate': renderTranslate(raw); break;
    }
  } catch (e) {
    renderErrorPlaceholder(t('处理出错', 'Something went wrong'), String(e));
  }
  output.classList.remove('fv-pg-fade');
  void output.offsetWidth;
  output.classList.add('fv-pg-fade');

  // Update stats in the output header
  if (lastResultText !== null) {
    setOutputHeader(null, { lines: (lastResultText as string).split('\n').length, chars: (lastResultText as string).length });
  }
  updateCopyBtnState();
}

// ── Renderers (output side) ───────────────────────────────────
type JsonView = 'format' | 'minify' | 'escape' | 'unescape';

// Friendly empty-state placeholder for the output pane.
function showEmptyOutput(): void {
  output.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'fv-pg-empty';
  wrap.innerHTML = '<div class="fv-pg-empty-icon">'
    + '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h12l4 4v12a0 0 0 0 1 0 0H4z"/><path d="M16 4v4h4"/></svg>'
    + '</div>'
    + '<div class="fv-pg-empty-text">' + t('左侧粘贴内容，右侧即刻呈现', 'Paste on the left — it renders here instantly') + '</div>';
  output.appendChild(wrap);
}

const WRAP_WIDTH = 72;

function renderJson(raw: string): void {
  let parsed: unknown;
  let parseOk = false;
  let parseErr: string | null = null;
  try {
    parsed = JSON.parse(raw);
    parseOk = true;
  } catch (e) {
    parseErr = (e as Error).message;
  }

  let view: JsonView = state.jsonView ?? 'format';

  const picker = document.createElement('div');
  picker.className = 'fv-pg-subchips';

  const opts: { v: JsonView; label: string }[] = [
    { v: 'format',   label: t('格式化', 'Format') },
    { v: 'minify',   label: t('压缩',  'Minify') },
    { v: 'escape',   label: t('转义',  'Escape') },
    { v: 'unescape', label: t('去转义','Unescape') },
  ];

  const body = document.createElement('div');
  body.className = 'fv-pg-json-body';

  function paintPicker(): void {
    picker.querySelectorAll<HTMLElement>('.fv-pg-subchip').forEach((c) => {
      c.classList.toggle('active', c.dataset.view === view);
    });
  }

  function paintBody(): void {
    body.innerHTML = '';

    if (!parseOk && (view === 'format' || view === 'minify')) {
      const detail = parseErr ? formatJsonError(parseErr, raw) : '';
      body.appendChild(buildErrorPlaceholder(t('JSON 解析失败', 'JSON parse error'), detail));
      lastResultText = raw;
      return;
    }

    let displayText = '';
    let useHighlight = false;

    if (view === 'format') {
      displayText = JSON.stringify(parsed, null, 2);
      useHighlight = true;
      lastResultText = displayText;
    } else if (view === 'minify') {
      const minified = JSON.stringify(parsed);
      // Show wrapped for readability; copy returns the unbroken line.
      displayText = wrapText(minified, WRAP_WIDTH);
      useHighlight  = true;
      lastResultText = minified;
    } else if (view === 'escape') {
      const escaped = JSON.stringify(raw);
      displayText = wrapText(escaped, WRAP_WIDTH);
      useHighlight  = true;
      lastResultText = escaped;
    } else if (view === 'unescape') {
      try {
        const v = JSON.parse(raw);
        displayText = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
        useHighlight = typeof v !== 'string';
      } catch {
        displayText = raw
          .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
          .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
      lastResultText = displayText;
    }

    const pre = document.createElement('pre');
    pre.className = 'fv-pg-json-text';
    if (useHighlight) pre.innerHTML = jsonHighlight(displayText);
    else              pre.textContent = displayText;

    const { wrap, refreshGutter } = withGutter(pre);
    body.appendChild(wrap);
    refreshGutter(Math.max(1, displayText.split('\n').length));
  }

  opts.forEach(({ v, label }) => {
    const b = document.createElement('button');
    b.className = 'fv-pg-subchip';
    b.dataset.view = v;
    b.textContent = label;
    b.addEventListener('click', () => {
      view = v;
      state.jsonView = v;
      scheduleSave();
      paintPicker();
      paintBody();
    });
    picker.appendChild(b);
  });

  // Copy button pushed to the right side of the sub-chip row
  const spacer = document.createElement('div');
  spacer.style.cssText = 'flex:1;';
  picker.appendChild(spacer);

  const cpBtn = document.createElement('button');
  cpBtn.className = 'fv-pg-subchip fv-pg-copy-btn';
  cpBtn.textContent = t('复制', 'Copy');
  cpBtn.addEventListener('click', () => {
    const txt = lastResultText;
    if (txt == null) return;
    copyText(txt).then(() => {
      const orig = cpBtn.textContent;
      cpBtn.textContent = '✓';
      setTimeout(() => { cpBtn.textContent = orig; }, 1200);
    });
  });
  picker.appendChild(cpBtn);

  setOutputHeader(picker);

  const wrap = document.createElement('div');
  wrap.className = 'fv-pg-decoder';
  wrap.appendChild(body);
  output.appendChild(wrap);

  paintPicker();
  paintBody();
}

// Break a long single-line string into chunks of at most `w` characters
// so that compressed/escaped output doesn't render as one unreadable line.
function wrapText(text: string, w: number): string {
  if (text.length <= w) return text;
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += w) {
    parts.push(text.slice(i, i + w));
  }
  return parts.join('\n');
}

// Wrap a content element with a left-side line-number gutter, editor-style.
// The gutter sticks to the left edge as the user scrolls horizontally and
// scrolls with the content vertically (both live inside the same scroll
// container — the `.fv-pg-output` element).
function withGutter(content: HTMLElement): { wrap: HTMLElement; refreshGutter: (lineCount: number) => void } {
  const wrap = document.createElement('div');
  wrap.className = 'fv-pg-numbered';

  const gutter = document.createElement('div');
  gutter.className = 'fv-pg-gutter';

  const contentBox = document.createElement('div');
  contentBox.className = 'fv-pg-content';
  contentBox.appendChild(content);

  wrap.append(gutter, contentBox);

  function refreshGutter(lineCount: number): void {
    const n = Math.max(1, lineCount);
    while (gutter.childElementCount > n) gutter.removeChild(gutter.lastChild!);
    while (gutter.childElementCount < n) {
      const d = document.createElement('div');
      d.className = 'fv-pg-gutter-ln';
      gutter.appendChild(d);
    }
    for (let i = 0; i < n; i++) {
      (gutter.children[i] as HTMLElement).textContent = String(i + 1);
    }
  }

  return { wrap, refreshGutter };
}

// Pull a character position out of JSON.parse's error message and convert
// it to a human-readable "line X, column Y (position N)" string.
function formatJsonError(msg: string, raw: string): string {
  // Chrome / Edge: "… in JSON at position 15"
  const m1 = msg.match(/at position\s+(\d+)/i);
  // Firefox: "… at line 1 column 15 …"
  const m2 = msg.match(/column\s+(\d+)/i);

  let pos: number | null = null;
  if (m1) pos = parseInt(m1[1], 10);
  else if (m2) pos = parseInt(m2[1], 10) - 1;

  if (pos === null || pos < 0) return msg;

  // Compute line:column from character position
  let line = 1;
  let col  = 1;
  for (let i = 0; i < pos && i < raw.length; i++) {
    if (raw[i] === '\n') { line++; col = 1; }
    else col++;
  }
  return `${msg}\n${t('第', 'Line ')}${line}${t('行,第', ', column ')}${col}${t('列', '')} (position ${pos})`;
}

// ── Error placeholder (used by JSON/Base64/URL/QR failures) ───
function buildErrorPlaceholder(title: string, detail: string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'fv-pg-error';
  const icon = document.createElement('div');
  icon.className = 'fv-pg-error-icon';
  icon.textContent = '⚠';
  const h = document.createElement('div');
  h.className = 'fv-pg-error-title';
  h.textContent = title;
  root.append(icon, h);
  if (detail) {
    const d = document.createElement('div');
    d.className = 'fv-pg-error-detail';
    d.textContent = detail;
    root.appendChild(d);
  }
  return root;
}

function renderErrorPlaceholder(title: string, detail: string): void {
  output.innerHTML = '';
  output.appendChild(buildErrorPlaceholder(title, detail));
}

// Size-limit warning card — shown in place of formatted output when the input
// crosses the soft threshold. The textarea stays fully editable; the user can
// click "format anyway" to force a one-shot render (the line-number gutter
// stays disabled because its per-line measurement is the main freeze source).
function showSizeWarning(raw: string): void {
  output.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'fv-pg-error';
  const icon = document.createElement('div');
  icon.className = 'fv-pg-error-icon';
  icon.textContent = '📏';
  const h = document.createElement('div');
  h.className = 'fv-pg-error-title';
  h.textContent = t('内容过大，已暂停实时格式化', 'Content too large — live formatting paused');
  const d = document.createElement('div');
  d.className = 'fv-pg-error-detail';
  d.textContent = describeSize(raw) + ' · ' + t('继续编辑、滚动、复制均不受影响', 'editing, scrolling and copying still work');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fv-pg-primary-btn fv-pg-primary-btn--sm';
  btn.textContent = t('仍要格式化', 'Format anyway');
  btn.addEventListener('click', () => { runFormat(true); });
  card.append(icon, h, d, btn);
  output.appendChild(card);
}

// Lightweight JSON syntax highlighter for text output (minify/escape views).
function jsonHighlight(text: string): string {
  const re = /"(?:\\.|[^"\\])*"(\s*:)?|true|false|null|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;
  let out = '';
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) out += escapePunct(text.slice(lastIdx, m.index));
    const tok = m[0];
    if (tok.startsWith('"')) {
      if (m[1]) {
        const keyOnly = tok.slice(0, tok.length - m[1].length);
        out += `<span class="fv-key">${escapeHtml(keyOnly)}</span><span class="fv-colon">${escapeHtml(m[1])}</span>`;
      } else {
        out += `<span class="fv-string">${escapeHtml(tok)}</span>`;
      }
    } else if (tok === 'true' || tok === 'false') {
      out += `<span class="fv-boolean">${tok}</span>`;
    } else if (tok === 'null') {
      out += `<span class="fv-null">null</span>`;
    } else {
      out += `<span class="fv-number">${tok}</span>`;
    }
    lastIdx = m.index + tok.length;
  }
  if (lastIdx < text.length) out += escapePunct(text.slice(lastIdx));
  return out;
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapePunct(s: string): string {
  return escapeHtml(s);
}

function renderSql(raw: string): void {
  const formatted = formatSQL(raw);
  const pre = document.createElement('pre');
  pre.className = 'fv-sql-root';
  pre.innerHTML = highlightSql(formatted);

  const { wrap, refreshGutter } = withGutter(pre);
  output.appendChild(wrap);
  refreshGutter(formatted.split('\n').length);
  lastResultText = formatted;
}

// Base64 direction toggle (persisted via shared state).
type Base64Dir = 'auto' | 'encode' | 'decode';

function renderBase64(raw: string): void {
  const r = processBase64(raw);

  const picker = document.createElement('div');
  picker.className = 'fv-pg-subchips';
  const opts: { dir: Base64Dir; label: string }[] = [
    { dir: 'auto',   label: t('自动 ⇄', 'Auto ⇄') },
    { dir: 'encode', label: t('编码 →', 'Encode →') },
    { dir: 'decode', label: t('解码 ←', 'Decode ←') },
  ];
  let dir: Base64Dir = state.b64Dir ?? 'auto';

  const body = document.createElement('div');
  body.className = 'fv-pg-subchips-body';

  function paintPicker(): void {
    picker.querySelectorAll<HTMLElement>('.fv-pg-subchip').forEach((c) => {
      c.classList.toggle('active', c.dataset.dir === dir);
    });
  }
  function paintBody(): void {
    body.innerHTML = '';
    if (dir === 'auto' || dir === 'decode') {
      if (r.decoded !== null) {
        body.appendChild(section(t('解码后', 'Decoded'), r.decoded));
      } else if (dir === 'decode') {
        body.appendChild(buildErrorPlaceholder(
          t('Base64 解码失败', 'Base64 decode failed'),
          t('输入不是合法的 Base64 字符串', 'Input is not a valid Base64 string'),
        ));
      }
    }
    if (dir === 'auto' || dir === 'encode') {
      body.appendChild(section(t('编码', 'Encoded'), r.encoded));
    }
    lastResultText = dir === 'encode' ? r.encoded
                   : dir === 'decode' ? (r.decoded ?? '')
                   : (r.decoded ?? r.encoded);
  }

  opts.forEach(({ dir: d, label }) => {
    const c = document.createElement('button');
    c.className = 'fv-pg-subchip';
    c.dataset.dir = d;
    c.textContent = label;
    c.addEventListener('click', () => {
      dir = d;
      state.b64Dir = d;
      scheduleSave();
      paintPicker();
      paintBody();
    });
    picker.appendChild(c);
  });

  setOutputHeader(picker);

  const wrap = document.createElement('div');
  wrap.className = 'fv-pg-decoder';
  wrap.appendChild(body);
  output.appendChild(wrap);
  paintPicker();
  paintBody();
}

function renderUrl(raw: string): void {
  const r = processUrl(raw);
  const wrap = document.createElement('div');
  wrap.className = 'fv-pg-decoder';

  wrap.appendChild(section(t('解码', 'Decoded'), r.decoded));
  wrap.appendChild(section(t('编码', 'Encoded'), r.encoded));

  if (r.parts) {
    const tbl = document.createElement('table');
    tbl.className = 'fv-csv-table fv-pg-kvtable';
    const add = (k: string, v: string): void => {
      const tr = tbl.insertRow();
      const th = document.createElement('th'); th.textContent = k; tr.appendChild(th);
      const td = tr.insertCell(); td.textContent = v;
    };
    add(t('协议', 'Scheme'),   r.parts.scheme);
    add(t('主机', 'Host'),     r.parts.host);
    if (r.parts.port) add(t('端口', 'Port'), r.parts.port);
    add(t('路径', 'Path'),     r.parts.pathname);
    r.parts.query.forEach(({ key, value }) =>
      add(`query.${key}`, value));
    if (r.parts.hash) add(t('片段', 'Hash'), r.parts.hash);

    const head = document.createElement('div');
    head.className = 'fv-pg-sec-title';
    head.textContent = t('URL 解析', 'URL parts');
    wrap.append(head, tbl);
  }
  output.appendChild(wrap);
  lastResultText = r.decoded;
}

function section(title: string, content: string, kind: 'plain' | 'json' = 'plain'): HTMLElement {
  const root = document.createElement('div');
  root.className = 'fv-pg-section';
  const h = document.createElement('div');
  h.className = 'fv-pg-sec-title';
  h.textContent = title;
  const body = document.createElement('pre');
  body.className = 'fv-pg-sec-body' + (kind === 'json' ? ' fv-pg-sec-json' : '');
  body.textContent = content;
  root.append(h, body);
  return root;
}

// ── Translation ──────────────────────────────────────────────

function renderTranslate(raw: string): void {
  // Buttons in the output header
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;';

  const btnZh = mkTrBtn(t('英译中', 'EN→ZH'), 'en', 'zh');
  const btnEn = mkTrBtn(t('中译英', 'ZH→EN'), 'zh', 'en');

  btnRow.append(btnZh, btnEn);
  setOutputHeader(btnRow);

  const body = document.createElement('div');
  body.className = 'fv-pg-subchips-body';

  const resultArea = document.createElement('div');

  async function doTranslate(sl: string, tl: string): Promise<void> {
    const text = raw.trim();
    if (!text || trBusy) return;

    // B6: cancel any in-flight request and take the lock.
    trAbort?.abort();
    trAbort = new AbortController();
    const mySignal = trAbort.signal;
    trBusy = true;
    const setBtnsDisabled = (disabled: boolean) =>
      btnRow.querySelectorAll('button').forEach((b) => { (b as HTMLButtonElement).disabled = disabled; });
    setBtnsDisabled(true);

    resultArea.innerHTML = '';
    const loading = document.createElement('div');
    const spinner = document.createElement('div');
    spinner.className = 'fv-pg-spinner';
    loading.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:10px;padding:32px;min-height:0;';
    loading.appendChild(spinner);
    const label = document.createElement('span');
    label.style.cssText = 'font-size:13px;color:var(--fv-text-muted);';
    label.textContent = t('翻译中…', 'Translating…');
    loading.appendChild(label);
    resultArea.appendChild(loading);

    try {
      const translated = await translateChunk(text, sl, tl, mySignal);
      const pre = document.createElement('pre');
      pre.className = 'fv-pg-sec-body';
      pre.style.whiteSpace = 'pre-wrap';
      pre.textContent = translated;
      resultArea.innerHTML = '';
      resultArea.appendChild(pre);
      trLastResult = translated;
      trLastText = text;
      lastResultText = translated;

      // If the result is a single English word (zh→en direction), append its
      // IPA phonetic from a free dictionary API. Failures are silent.
      if (tl === 'en' && /^[a-zA-Z][a-zA-Z'-]*$/.test(translated.trim())) {
        const phonetic = await fetchPhonetic(translated.trim());
        if (phonetic) {
          const phEl = document.createElement('div');
          phEl.className = 'fv-pg-phonetic';
          phEl.textContent = phonetic;
          resultArea.appendChild(phEl);
        }
      }
    } catch (err) {
      // Aborted by a newer request — leave the new request's loading state
      // in place; don't show an error.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      resultArea.innerHTML = '';
      resultArea.appendChild(buildErrorPlaceholder(
        t('翻译失败', 'Translation failed'),
        t('请检查网络连接后重试', 'Check your network and try again'),
      ));
    } finally {
      // Only release the lock if this request is still the active one
      // (a newer request may have already replaced trAbort).
      if (trAbort === null || trAbort.signal === mySignal) {
        trBusy = false;
        setBtnsDisabled(false);
      }
    }
  }

  function mkTrBtn(label: string, sl: string, tl: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'fv-pg-primary-btn fv-pg-primary-btn--sm';
    b.textContent = label;
    b.addEventListener('click', () => doTranslate(sl, tl));
    return b;
  }

  body.appendChild(resultArea);

  // Show cached result if available
  if (trLastResult && trLastText === raw.trim()) {
    const pre = document.createElement('pre');
    pre.className = 'fv-pg-sec-body';
    pre.style.whiteSpace = 'pre-wrap';
    pre.textContent = trLastResult;
    resultArea.appendChild(pre);
    lastResultText = trLastResult;
  }

  output.appendChild(body);
  lastResultText = raw;
}

async function translateChunk(text: string, sl: string, tl: string, signal?: AbortSignal): Promise<string> {
  const pair = `${sl}|${tl}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${pair}`;
  // Combine the caller's cancel signal (B6 inflight abort) with an 8s
  // timeout. AbortSignal.any is supported in Chrome 116+.
  const timeoutSignal = AbortSignal.timeout(8000);
  const combined = signal && 'any' in AbortSignal
    ? (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any([signal, timeoutSignal])
    : timeoutSignal;
  const resp = await fetch(url, { signal: combined });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  const result = json.responseData?.translatedText;
  if (!result || result.includes('MYMEMORY WARNING')) throw new Error('quota');
  return result;
}

// Fetch IPA phonetic for a single English word from the free dictionary API.
// Returns null on any failure (network, not found, non-word) — caller ignores.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchPhonetic(word: string): Promise<string | null> {
  try {
    const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const entry = data[0];
    const phonetic: string | undefined =
      entry.phonetic ?? entry.phonetics?.find((p: { text?: string }) => p.text)?.text;
    return typeof phonetic === 'string' && phonetic ? phonetic : null;
  } catch {
    return null;
  }
}

// ── QR code generation ───────────────────────────────────────
function renderQr(raw: string): void {
  const wrap = document.createElement('div');
  wrap.className = 'fv-pg-qr-wrap';

  let qr;
  try { qr = generateQr(raw.trim()); }
  catch (e) {
    renderErrorPlaceholder(t('二维码生成失败', 'QR generation failed'), (e as Error).message);
    return;
  }

  // Render QR using DOM elements — each module is a <b> tag with fixed
  // pixel dimensions. This guarantees pixel-perfect rendering regardless
  // of canvas anti-aliasing behaviour.
  // Display scale is computed so the whole QR (incl. quiet zone) targets
  // ~260px — comfortable for phone scanning without dominating the pane.
  const QUIET = 4;
  const DISPLAY_TARGET = 260;
  const total = qr.size + QUIET * 2;
  const DISPLAY_SCALE = Math.max(6, Math.floor(DISPLAY_TARGET / total));
  const grid = document.createElement('div');
  grid.className = 'fv-pg-qr';
  grid.style.cssText =
    `display:grid;` +
    `grid-template-columns:repeat(${qr.size},${DISPLAY_SCALE}px);` +
    `grid-template-rows:repeat(${qr.size},${DISPLAY_SCALE}px);` +
    `padding:${QUIET * DISPLAY_SCALE}px;` +
    `background:#fff;` +
    `width:${qr.size * DISPLAY_SCALE}px;` +
    `border-radius:var(--fv-radius-md);` +
    `box-shadow:var(--fv-shadow-md);` +
    `box-sizing:content-box;`;

  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      const m = document.createElement('b');
      m.style.cssText = `display:block;width:${DISPLAY_SCALE}px;height:${DISPLAY_SCALE}px;` +
        `background:${qr.matrix[r][c] ? '#000' : '#fff'};`;
      grid.appendChild(m);
    }
  }

  // Build a high-resolution canvas for the download button (independent of
  // the on-screen scale, so saved PNGs stay crisp at any zoom).
  const DL_SCALE = 20;
  const canvas = document.createElement('canvas');
  const cpx = (qr.size + QUIET * 2) * DL_SCALE;
  canvas.width = cpx;
  canvas.height = cpx;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cpx, cpx);
  ctx.fillStyle = '#000';
  for (let r = 0; r < qr.size; r++)
    for (let c = 0; c < qr.size; c++)
      if (qr.matrix[r][c])
        ctx.fillRect((c + QUIET) * DL_SCALE, (r + QUIET) * DL_SCALE, DL_SCALE, DL_SCALE);

  const meta = document.createElement('div');
  meta.className = 'fv-pg-qr-meta';
  meta.textContent = t(
    `版本 ${qr.version} · ${qr.size}×${qr.size} 模块`,
    `Version ${qr.version} · ${qr.size}×${qr.size} modules`);

  const dl = document.createElement('button');
  dl.className = 'fv-pg-primary-btn';
  dl.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8m-3-3 3 3 3-3"/><path d="M3 13h10"/></svg>'
                + '<span>' + t('下载 PNG', 'Download PNG') + '</span>';
  dl.addEventListener('click', () => {
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'qrcode.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  });

  wrap.append(grid, meta, dl);
  output.appendChild(wrap);
  lastResultText = raw;
}

// ── Diff mode ─────────────────────────────────────────────────
function buildDiffShell(): void {
  diffShell = document.createElement('div');
  diffShell.className = 'fv-pg-diff-shell';
  diffShell.style.display = 'none';

  const { root, left, right, refresh } = renderDiffPanels({
    onChange: () => {
      state.diffLeft  = left.value;
      state.diffRight = right.value;
      scheduleSave();
    },
  });

  diffLeft  = left;
  diffRight = right;
  diffRefresh = refresh;

  diffShell.appendChild(root);
  document.body.append(diffShell);

  // Debounce rebuild on input
  const queueRefresh = (): void => {
    if (diffDebounce) clearTimeout(diffDebounce);
    diffDebounce = setTimeout(refresh, 150);
  };
  left.addEventListener('input',  queueRefresh);
  right.addEventListener('input', queueRefresh);
}

function toggleDiffShell(on: boolean): void {
  if (!diffShell) return;
  diffShell.style.display = on ? '' : 'none';
  const split = document.querySelector<HTMLElement>('.fv-pg-split');
  if (split) split.style.display = on ? 'none' : '';
  // Recompute the diff when entering diff mode (e.g. after restoring saved text)
  if (on) {
    if (diffRefresh) diffRefresh();
    diffShell.classList.remove('fv-pg-fade');
    void diffShell.offsetWidth;
    diffShell.classList.add('fv-pg-fade');
  }
}

// ── Memo mode ─────────────────────────────────────────────────
// Data model: a list of memo files; the active file is shown in the editor.
type MemoFile = {
  id: string; title: string; content: string;
  updatedAt: number;
  createdAt: number;   // set once at creation; never mutated afterwards
  icon?: number;       // index into MEMO_ICONS (0-based); assigned on create/import
};

// 20 preset icons cycled across new/imported memos. Users can change any
// memo's icon via the picker.
const MEMO_ICONS = ['📝','📌','⭐','💡','🔥','🚀','✅','🎯','📋','🔖','💼','🎨','📊','🔔','🌟','🏷️','💬','🔑','🧩','⚡'];
// New/imported files always start on the first icon (📝). Users can still
// change it per-file via the icon picker.
function nextIcon(): number {
  return 0;
}

let memoShell: HTMLElement | null = null;
let memoFiles: MemoFile[] = [];
let memoActiveId: string | null = null;
// id of the file currently being dragged (for manual reordering).
let memoDragId: string | null = null;
// Cached handles to the editor elements (built once in buildMemoShell).
let memoListEl: HTMLElement | null = null;
let memoTitleEl: HTMLInputElement | null = null;
let memoBodyEl: HTMLTextAreaElement | null = null;
let memoIconEl: HTMLSpanElement | null = null;

const MEMO_KEY = 'pg_memo_v2';
const MEMO_CUR_KEY = 'pg_memo_cur';
// Whether the file-list sidebar is collapsed (persisted across sessions).
const MEMO_COLLAPSED_KEY = 'pg_memo_collapsed';
// Legacy keys from the old two-pane layout — cleared on first load of v2.
const MEMO_LEGACY_KEYS = ['pg_memo_1', 'pg_memo_2'];

function memoUid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function currentMemo(): MemoFile | null {
  if (!memoActiveId) return null;
  return memoFiles.find((f) => f.id === memoActiveId) ?? null;
}

// Write the editor's current values back into the active file record.
function flushEditorToMemo(): void {
  const f = currentMemo();
  if (!f || !memoTitleEl || !memoBodyEl) return;
  f.title = memoTitleEl.value;
  f.content = memoBodyEl.value;
  f.updatedAt = Date.now();
}

function saveMemo(): void {
  if (memoTimer) clearTimeout(memoTimer);
  memoTimer = setTimeout(() => {
    flushEditorToMemo();
    chrome.storage.local.set({
      [MEMO_KEY]: memoFiles,
      [MEMO_CUR_KEY]: memoActiveId,
    }).catch(() => { /* ignore */ });
  }, 300);
}

// Icon picker popup — shows a grid of preset icons. Click one to set it on
// the given memo, then close. Only one picker is open at a time.
let iconPickerEl: HTMLElement | null = null;
function openIconPicker(anchor: HTMLElement, f: MemoFile): void {
  closeIconPicker();
  const pop = document.createElement('div');
  pop.className = 'fv-memo-icon-picker fv-overlay-in';
  MEMO_ICONS.forEach((ic, idx) => {
    const cell = document.createElement('button');
    cell.className = 'fv-memo-icon-cell' + ((f.icon ?? 0) === idx ? ' sel' : '');
    cell.type = 'button';
    cell.textContent = ic;
    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      f.icon = idx;
      renderMemoList();
      updateMemoEditorIcon(f);
      saveMemo();
      closeIconPicker();
    });
    pop.appendChild(cell);
  });
  // Position below the anchor.
  const rect = anchor.getBoundingClientRect();
  pop.style.left = rect.left + 'px';
  pop.style.top = (rect.bottom + 4) + 'px';
  document.body.appendChild(pop);
  iconPickerEl = pop;
}
function closeIconPicker(): void {
  if (iconPickerEl) { iconPickerEl.remove(); iconPickerEl = null; }
}

function renderMemoList(): void {
  if (!memoListEl) return;
  memoListEl.textContent = '';
  for (const f of memoFiles) {
    const item = document.createElement('div');
    item.className = 'fv-memo-item' + (f.id === memoActiveId ? ' active' : '');
    item.draggable = true;
    item.dataset.id = f.id;

    const icon = document.createElement('span');
    icon.className = 'fv-memo-icon';
    icon.textContent = MEMO_ICONS[f.icon ?? 0];
    icon.title = t('点击修改图标', 'Click to change icon');
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      openIconPicker(icon, f);
    });
    item.appendChild(icon);

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = f.title || t('无标题', 'Untitled');
    item.appendChild(title);

    const del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.setAttribute('aria-label', t('删除', 'Delete'));
    del.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h10"/><path d="M5 5V3.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V5"/><path d="M5 5l.7 8a1 1 0 0 0 1 1h2.6a1 1 0 0 0 1-1L11 5"/><path d="M7 8v3M9 8v3"/></svg>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!window.confirm(t('确定删除此备忘录？', 'Delete this memo?'))) return;
      deleteMemo(f.id);
    });
    item.appendChild(del);

    item.addEventListener('click', () => selectMemo(f.id));

    // ── Drag & drop reordering ──
    item.addEventListener('dragstart', () => {
      memoDragId = f.id;
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      memoDragId = null;
      item.classList.remove('dragging');
      memoListEl?.querySelectorAll('.fv-memo-item.drag-over').forEach((el) => el.classList.remove('drag-over'));
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!memoDragId || memoDragId === f.id) return;
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (!memoDragId || memoDragId === f.id) return;
      // Decide insertion half via cursor Y vs. item midpoint.
      const rect = item.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      reorderMemo(memoDragId, f.id, after);
    });

    memoListEl.appendChild(item);
  }
}

// Move the dragged file (dragId) to the position of targetId, either before
// or after it depending on the `after` flag. Saves the new order.
function reorderMemo(dragId: string, targetId: string, after: boolean): void {
  const from = memoFiles.findIndex((f) => f.id === dragId);
  if (from < 0) return;
  const [moved] = memoFiles.splice(from, 1);
  let to = memoFiles.findIndex((f) => f.id === targetId);
  if (to < 0) { memoFiles.push(moved); }
  else { memoFiles.splice(after ? to + 1 : to, 0, moved); }
  renderMemoList();
  saveMemo();
}

function loadMemoIntoEditor(f: MemoFile): void {
  if (!memoTitleEl || !memoBodyEl) return;
  memoTitleEl.value = f.title;
  memoBodyEl.value = f.content;
  updateMemoEditorIcon(f);
}

// C4: reload memo data from storage — used for cross-tab live sync. Reads
// the files + active id, backfills legacy createdAt, and refreshes the list
// + editor. Called on first load and whenever another tab writes memo data.
function reloadMemoFromStorage(data?: Record<string, unknown>): void {
  void Promise.resolve(
    data ?? chrome.storage.local.get([MEMO_KEY, MEMO_CUR_KEY])
  ).then((d) => {
    const got = (d ?? {}) as Record<string, unknown>;
    const files = got[MEMO_KEY] as MemoFile[] | undefined;
    const now = Date.now();
    memoFiles = Array.isArray(files) && files.length > 0
      ? files
      : [{ id: memoUid(), title: '', content: '', updatedAt: now, createdAt: now, icon: 0 }];
    for (const f of memoFiles) {
      if (typeof f.createdAt !== 'number') f.createdAt = f.updatedAt;
    }
    const prevActive = memoActiveId;
    memoActiveId = (got[MEMO_CUR_KEY] as string | undefined) ?? memoFiles[0].id;
    if (!memoFiles.some((f) => f.id === memoActiveId)) memoActiveId = memoFiles[0].id;
    const active = memoFiles.find((f) => f.id === memoActiveId) ?? memoFiles[0];
    memoActiveId = active.id;
    // Only push the editor content into the DOM if the active memo changed
    // or this is the first load — otherwise preserve scroll/cursor in the
    // currently-open memo by refreshing from memoFiles (which may have been
    // updated by the other tab).
    if (prevActive !== memoActiveId || !memoTitleEl || memoTitleEl.value === '') {
      loadMemoIntoEditor(active);
    } else {
      // Same memo still active: refresh its content from the freshly-loaded
      // file list (the other tab may have edited it).
      loadMemoIntoEditor(active);
    }
    renderMemoList();
    if (memoFiles.length === 0 || !files || files.length === 0) saveMemo();
  }).catch(() => { /* ignore */ });
}

// Update the editor title-bar icon to reflect the active memo's icon.
function updateMemoEditorIcon(f: MemoFile): void {
  if (!memoIconEl) return;
  memoIconEl.textContent = MEMO_ICONS[f.icon ?? 0];
  memoIconEl.onclick = (e) => { e.stopPropagation(); openIconPicker(memoIconEl!, f); };
}

function selectMemo(id: string): void {
  flushEditorToMemo();
  const f = memoFiles.find((m) => m.id === id);
  if (!f) return;
  memoActiveId = id;
  loadMemoIntoEditor(f);
  renderMemoList();
  saveMemo();
}

function createMemo(): void {
  flushEditorToMemo();
  const now = Date.now();
  const f: MemoFile = { id: memoUid(), title: '', content: '', updatedAt: now, createdAt: now, icon: nextIcon() };
  memoFiles.unshift(f);
  memoActiveId = f.id;
  loadMemoIntoEditor(f);
  renderMemoList();
  saveMemo();
  memoTitleEl?.focus();
}

function deleteMemo(id: string): void {
  const idx = memoFiles.findIndex((f) => f.id === id);
  if (idx < 0) return;
  memoFiles.splice(idx, 1);
  // Keep at least one file around — recreate a blank one if we emptied the list.
  if (memoFiles.length === 0) {
    const now = Date.now();
    const f: MemoFile = { id: memoUid(), title: '', content: '', updatedAt: now, createdAt: now, icon: 0 };
    memoFiles.push(f);
    memoActiveId = f.id;
    loadMemoIntoEditor(f);
  } else if (memoActiveId === id) {
    // Deleted the active file — switch to the first remaining one.
    memoActiveId = memoFiles[0].id;
    loadMemoIntoEditor(memoFiles[0]);
  }
  renderMemoList();
  saveMemo();
}

function buildMemoShell(): void {
  memoShell = document.createElement('div');
  memoShell.className = 'fv-pg-diff-shell';
  memoShell.style.display = 'none';

  const bar = document.createElement('div');
  bar.className = 'fv-pg-diff-bar';
  bar.style.justifyContent = 'space-between';

  const title = document.createElement('span');
  title.style.cssText = 'font-size:13px;font-weight:700;letter-spacing:.05em;color:var(--fv-text);';
  title.textContent = t('备忘录', 'Memo');

  // Collapse/expand the file-list sidebar. Placed in the toolbar (not on the
  // divider) so it never overlaps the editor content and stays visible when
  // the sidebar is collapsed.
  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'fv-btn fv-memo-collapse-btn';
  collapseBtn.dataset.tip = t('收起文件列表', 'Collapse file list');
  collapseBtn.setAttribute('aria-label', t('收起文件列表', 'Collapse file list'));
  collapseBtn.setAttribute('aria-pressed', 'false');
  // Standard sidebar-panel icon (panel + left vertical bar) — same glyph for
  // both states; the pressed state is conveyed via colour + tooltip.
  collapseBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1"/><line x1="6" y1="3" x2="6" y2="13"/></svg>';

  const leftBtns = document.createElement('div');
  leftBtns.style.cssText = 'display:flex;align-items:center;gap:8px;';
  leftBtns.append(title, collapseBtn);
  bar.appendChild(leftBtns);

  const rightBtns = document.createElement('div');
  rightBtns.style.cssText = 'display:flex;align-items:center;gap:8px;';

  // ── Import button: read .txt files as new memos ──
  const importBtn = document.createElement('button');
  importBtn.className = 'fv-btn';
  importBtn.dataset.tip = t('导入 TXT 文件', 'Import TXT files');
  importBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14V6m3 3-3-3-3 3"/><path d="M2 2h12"/></svg>'
    + '<span style="font-size:12px">' + t('导入', 'Import') + '</span>';
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = '.txt,text/plain';
  importInput.multiple = true;
  // Position off-screen (not display:none) so .click() reliably opens the
  // file dialog in the extension environment.
  importInput.style.cssText = 'position:absolute;left:-9999px;top:0;opacity:0;';
  document.body.appendChild(importInput);
  importInput.addEventListener('change', () => {
    const files = importInput.files;
    if (!files || files.length === 0) { return; }
    let loaded = 0;
    const total = files.length;
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const content = reader.result as string;
        const now = Date.now();
        const f: MemoFile = {
          id: memoUid(),
          title: file.name.replace(/\.txt$/i, ''),
          content,
          updatedAt: now,
          createdAt: now,
          icon: nextIcon(),
        };
        memoFiles.unshift(f);
        loaded++;
        if (loaded === total) {
          // Select the first imported file and persist immediately (no debounce,
          // no flushEditorToMemo — we write memoFiles directly).
          memoActiveId = memoFiles[0].id;
          loadMemoIntoEditor(memoFiles[0]);
          renderMemoList();
          chrome.storage.local.set({
            [MEMO_KEY]: memoFiles,
            [MEMO_CUR_KEY]: memoActiveId,
          }).catch(() => { /* ignore */ });
        }
      };
      reader.onerror = () => { loaded++; };
      reader.readAsText(file);
    });
    importInput.value = ''; // allow re-importing the same file
  });
  importBtn.addEventListener('click', () => importInput.click());
  rightBtns.appendChild(importBtn);

  // ── Export button with dropdown: current / all ──
  const exportWrap = document.createElement('div');
  exportWrap.style.cssText = 'position:relative;';

  const exportBtn = document.createElement('button');
  exportBtn.className = 'fv-btn';
  exportBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8m-3-3 3 3 3-3"/><path d="M2 10v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3"/></svg>'
    + '<span style="font-size:12px">' + t('导出', 'Export') + '</span>';
  exportWrap.appendChild(exportBtn);

  const exportDrop = document.createElement('div');
  exportDrop.className = 'fv-memo-export-drop';
  exportDrop.style.display = 'none';
  // C8: menu items are <button> so they're keyboard-reachable (Tab + Enter).
  function expItem(label: string, fn: () => void): HTMLButtonElement {
    const it = document.createElement('button');
    it.type = 'button';
    it.className = 'fv-memo-export-item';
    it.textContent = label;
    it.addEventListener('click', () => { fn(); hideExportDrop(); });
    return it;
  }
  function showExportDrop(): void {
    exportDrop.style.display = '';
    exportDrop.classList.remove('fv-overlay-in');
    // re-trigger the animation on each open
    void exportDrop.offsetWidth;
    exportDrop.classList.add('fv-overlay-in');
  }
  function hideExportDrop(): void {
    exportDrop.style.display = 'none';
    exportDrop.classList.remove('fv-overlay-in');
  }
  exportDrop.appendChild(expItem(t('导出当前文档', 'Export current'), () => {
    const f = currentMemo();
    if (!f) return;
    const name = (f.title || 'memo').replace(/[\\/:*?"<>|]/g, '_').trim() || 'memo';
    downloadText(name + '.txt', f.content);
  }));
  exportDrop.appendChild(expItem(t('导出所有文档', 'Export all'), () => {
    if (memoFiles.length === 0) return;
    // Download each memo as a separate .txt file. A small stagger between
    // downloads avoids the browser blocking rapid successive downloads.
    memoFiles.forEach((f, idx) => {
      const name = (f.title || 'memo').replace(/[\\/:*?"<>|]/g, '_').trim() || 'memo';
      setTimeout(() => downloadText(name + '.txt', f.content), idx * 200);
    });
  }));
  exportWrap.appendChild(exportDrop);

  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (exportDrop.style.display === 'none') showExportDrop(); else hideExportDrop();
  });
  document.addEventListener('click', (e) => {
    if (exportDrop.style.display === 'none') return;
    if (!exportWrap.contains(e.target as Node)) hideExportDrop();
  });

  rightBtns.appendChild(exportWrap);
  bar.appendChild(rightBtns);
  memoShell.appendChild(bar);

  const body = document.createElement('div');
  body.className = 'fv-memo-body-grid';
  body.style.cssText = 'flex:1;display:flex;min-height:0;';

  // ── Left sidebar: new-file button + file list ──
  const sidebar = document.createElement('div');
  sidebar.className = 'fv-memo-sidebar';

  const newBtn = document.createElement('button');
  newBtn.className = 'fv-memo-new';
  newBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>'
    + '<span>' + t('新建文件', 'New file') + '</span>';
  newBtn.addEventListener('click', createMemo);
  sidebar.appendChild(newBtn);

  const list = document.createElement('div');
  list.className = 'fv-memo-list';
  memoListEl = list;
  sidebar.appendChild(list);

  // Divider between sidebar and editor — pure separator (the collapse toggle
  // lives in the toolbar above, so the divider stays out of the content area).
  const divider = document.createElement('div');
  divider.className = 'fv-memo-divider';

  // ── Right editor: title input + body textarea (no line-number gutter) ──
  const editor = document.createElement('div');
  editor.className = 'fv-memo-editor';

  const editorIcon = document.createElement('span');
  editorIcon.className = 'fv-memo-icon fv-memo-editor-icon';
  editorIcon.title = t('点击修改图标', 'Click to change icon');
  memoIconEl = editorIcon;

  const titleBar = document.createElement('div');
  titleBar.className = 'fv-memo-title-bar';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'fv-memo-title';
  titleInput.placeholder = t('标题', 'Title');
  titleInput.spellcheck = false;
  titleInput.addEventListener('input', () => {
    flushEditorToMemo();
    renderMemoList();
    saveMemo();
  });
  memoTitleEl = titleInput;
  titleBar.append(editorIcon, titleInput);

  const bodyTa = document.createElement('textarea');
  bodyTa.className = 'fv-memo-body';
  bodyTa.spellcheck = false;
  bodyTa.placeholder = t('在此输入备忘内容…', 'Type your notes here…');
  bodyTa.addEventListener('input', () => { saveMemo(); });
  // Tab / Shift+Tab indentation (same behaviour as the main input pane).
  bodyTa.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const ta = bodyTa;
    const s = ta.selectionStart, en = ta.selectionEnd;
    const INDENT = '  ';
    if (e.shiftKey) {
      const before = ta.value.slice(0, s);
      const lineStart = before.lastIndexOf('\n') + 1;
      if (ta.value.slice(lineStart, lineStart + 2) === INDENT) {
        ta.setSelectionRange(lineStart, lineStart + 2);
        document.execCommand('insertText', false, '');
      }
    } else {
      document.execCommand('insertText', false, INDENT);
    }
  });
  memoBodyEl = bodyTa;

  editor.append(titleBar, bodyTa);

  body.append(sidebar, divider, editor);
  memoShell.appendChild(body);
  document.body.appendChild(memoShell);
  attachTextareaHighlight(bodyTa);

  // ── Sidebar collapse/expand toggle ──────────────────────────
  // The sidebar width is transitioned via CSS (.fv-memo-sidebar.collapsed),
  // so toggling the class animates the collapse. State is persisted so the
  // sidebar stays collapsed across sessions.
  let memoCollapsed = false;
  function applyMemoCollapsed(): void {
    sidebar.classList.toggle('collapsed', memoCollapsed);
    divider.classList.toggle('collapsed', memoCollapsed);
    const tip = memoCollapsed ? t('展开文件列表', 'Expand file list') : t('收起文件列表', 'Collapse file list');
    collapseBtn.dataset.tip = tip;
    collapseBtn.setAttribute('aria-label', tip);
    collapseBtn.setAttribute('aria-pressed', String(memoCollapsed));
    chrome.storage.local.set({ [MEMO_COLLAPSED_KEY]: memoCollapsed }).catch(() => { /* ignore */ });
  }
  collapseBtn.addEventListener('click', () => {
    memoCollapsed = !memoCollapsed;
    applyMemoCollapsed();
  });

  // Close the icon picker on outside click.
  document.addEventListener('click', (e) => {
    if (!iconPickerEl) return;
    if (!iconPickerEl.contains(e.target as Node)) closeIconPicker();
  });

  // Load saved files (or seed a default one), then activate. Also restore the
  // sidebar collapse state.
  chrome.storage.local.get([MEMO_KEY, MEMO_CUR_KEY, MEMO_COLLAPSED_KEY]).then((data) => {
    reloadMemoFromStorage(data);
    if (data[MEMO_COLLAPSED_KEY] === true) {
      memoCollapsed = true;
      applyMemoCollapsed();
    }
  }).catch(() => { /* ignore */ });

  // Clear legacy two-pane data on first run of v2.
  chrome.storage.local.remove(MEMO_LEGACY_KEYS).catch(() => { /* ignore */ });
}

function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  // Prefer the chrome.downloads API — it forces a download without opening
  // the file and respects the filename exactly. Fall back to <a download>
  // when running outside the extension context.
  if (typeof chrome !== 'undefined' && chrome.downloads) {
    chrome.downloads.download({ url, filename, saveAs: false })
      .catch(() => fallbackAnchorDownload(url, filename));
  } else {
    fallbackAnchorDownload(url, filename);
  }
}

function fallbackAnchorDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toggleMemoShell(on: boolean): void {
  if (!memoShell) return;
  memoShell.style.display = on ? '' : 'none';
  const split = document.querySelector<HTMLElement>('.fv-pg-split');
  if (split) split.style.display = on ? 'none' : '';
  if (on) {
    memoShell.classList.remove('fv-pg-fade');
    void memoShell.offsetWidth;
    memoShell.classList.add('fv-pg-fade');
  }
}

// ── Markdown module: file-managed shell with edit / split / preview modes ──
// Mirrors the memo module's shape (sidebar file list + editor) but the editor
// is a Markdown textarea with a live-rendered preview and three view modes.
type MdFile = {
  id: string; title: string; content: string;
  updatedAt: number;
  createdAt: number;   // set once at creation; never mutated
};

let mdShell: HTMLElement | null = null;
let mdFiles: MdFile[] = [];
let mdActiveId: string | null = null;
let mdDragId: string | null = null;
let mdListEl: HTMLElement | null = null;
let mdTitleEl: HTMLInputElement | null = null;
let mdEditEl: HTMLTextAreaElement | null = null;
let mdPreviewEl: HTMLElement | null = null;
let mdWorkspaceEl: HTMLElement | null = null;
type MdMode = 'edit' | 'split' | 'preview';
let mdMode: MdMode = 'split';
let mdTimer: ReturnType<typeof setTimeout> | null = null;

const MD_KEY = 'pg_md_files';
const MD_CUR_KEY = 'pg_md_cur';
const MD_MODE_KEY = 'pg_md_mode';
const MD_COLLAPSED_KEY = 'pg_md_collapsed';

function mdUid(): string { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function currentMd(): MdFile | null {
  if (!mdActiveId) return null;
  return mdFiles.find((f) => f.id === mdActiveId) ?? null;
}
function flushEditorToMd(): void {
  const f = currentMd();
  if (!f || !mdTitleEl || !mdEditEl) return;
  f.title = mdTitleEl.value;
  f.content = mdEditEl.value;
  f.updatedAt = Date.now();
}
function saveMd(): void {
  if (mdTimer) clearTimeout(mdTimer);
  mdTimer = setTimeout(() => {
    flushEditorToMd();
    chrome.storage.local.set({ [MD_KEY]: mdFiles, [MD_CUR_KEY]: mdActiveId }).catch(() => { /* ignore */ });
  }, 300);
}
function renderMdPreview(): void {
  if (!mdPreviewEl) return;
  const f = currentMd();
  mdPreviewEl.innerHTML = mdToHtml(f?.content ?? '');
}
function setMdMode(mode: MdMode): void {
  mdMode = mode;
  if (mdWorkspaceEl) mdWorkspaceEl.dataset.mode = mode;
  mdShell?.querySelectorAll<HTMLButtonElement>('.fv-md-mode').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  chrome.storage.local.set({ [MD_MODE_KEY]: mode }).catch(() => { /* ignore */ });
}
function loadMdIntoEditor(f: MdFile): void {
  if (!mdTitleEl || !mdEditEl) return;
  mdTitleEl.value = f.title;
  mdEditEl.value = f.content;
  renderMdPreview();
}

function renderMdList(): void {
  if (!mdListEl) return;
  mdListEl.textContent = '';
  for (const f of mdFiles) {
    const item = document.createElement('div');
    item.className = 'fv-memo-item' + (f.id === mdActiveId ? ' active' : '');
    item.draggable = true;
    item.dataset.id = f.id;

    const icon = document.createElement('span');
    icon.className = 'fv-memo-icon';
    icon.textContent = '📄';
    item.appendChild(icon);

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = (f.title || t('无标题', 'Untitled')) + '.md';
    item.appendChild(title);

    const del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.setAttribute('aria-label', t('删除', 'Delete'));
    del.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h10"/><path d="M5 5V3.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V5"/><path d="M5 5l.7 8a1 1 0 0 0 1 1h2.6a1 1 0 0 0 1-1L11 5"/></svg>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!window.confirm(t('确定删除此文档？', 'Delete this document?'))) return;
      deleteMd(f.id);
    });
    item.appendChild(del);

    item.addEventListener('click', () => selectMd(f.id));
    item.addEventListener('dragstart', () => { mdDragId = f.id; item.classList.add('dragging'); });
    item.addEventListener('dragend', () => {
      mdDragId = null;
      item.classList.remove('dragging');
      mdListEl?.querySelectorAll('.fv-memo-item.drag-over').forEach((el) => el.classList.remove('drag-over'));
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!mdDragId || mdDragId === f.id) return;
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => { item.classList.remove('drag-over'); });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (!mdDragId || mdDragId === f.id) return;
      const rect = item.getBoundingClientRect();
      reorderMd(mdDragId, f.id, (e.clientY - rect.top) > rect.height / 2);
    });

    mdListEl.appendChild(item);
  }
}
function reorderMd(dragId: string, targetId: string, after: boolean): void {
  const from = mdFiles.findIndex((f) => f.id === dragId);
  if (from < 0) return;
  const [moved] = mdFiles.splice(from, 1);
  const to = mdFiles.findIndex((f) => f.id === targetId);
  if (to < 0) mdFiles.push(moved);
  else mdFiles.splice(after ? to + 1 : to, 0, moved);
  renderMdList();
  saveMd();
}
function selectMd(id: string): void {
  flushEditorToMd();
  const f = mdFiles.find((m) => m.id === id);
  if (!f) return;
  mdActiveId = id;
  loadMdIntoEditor(f);
  renderMdList();
  saveMd();
}
function createMd(): void {
  flushEditorToMd();
  const now = Date.now();
  const f: MdFile = { id: mdUid(), title: '', content: '', updatedAt: now, createdAt: now };
  mdFiles.unshift(f);
  mdActiveId = f.id;
  loadMdIntoEditor(f);
  renderMdList();
  saveMd();
  mdTitleEl?.focus();
}
function deleteMd(id: string): void {
  const idx = mdFiles.findIndex((f) => f.id === id);
  if (idx < 0) return;
  mdFiles.splice(idx, 1);
  if (mdFiles.length === 0) {
    const now = Date.now();
    const f: MdFile = { id: mdUid(), title: '', content: '', updatedAt: now, createdAt: now };
    mdFiles.push(f);
    mdActiveId = f.id;
    loadMdIntoEditor(f);
  } else if (mdActiveId === id) {
    mdActiveId = mdFiles[0].id;
    loadMdIntoEditor(mdFiles[0]);
  }
  renderMdList();
  saveMd();
}

function buildMdShell(): void {
  mdShell = document.createElement('div');
  mdShell.className = 'fv-pg-diff-shell fv-md-shell';
  mdShell.style.display = 'none';

  // ── Top bar ──
  const bar = document.createElement('div');
  bar.className = 'fv-pg-diff-bar';
  bar.style.justifyContent = 'space-between';

  const left = document.createElement('div');
  left.style.cssText = 'display:flex;align-items:center;gap:12px;';

  // Mode segmented control: 编辑 | 编辑+预览 | 预览
  const seg = document.createElement('div');
  seg.className = 'fv-md-modes';
  const modes: Array<{ key: MdMode; zh: string; en: string }> = [
    { key: 'edit',    zh: '编辑',     en: 'Edit' },
    { key: 'split',   zh: '编辑+预览', en: 'Split' },
    { key: 'preview', zh: '预览',     en: 'Preview' },
  ];
  modes.forEach((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fv-md-mode' + (m.key === mdMode ? ' active' : '');
    b.dataset.mode = m.key;
    b.textContent = t(m.zh, m.en);
    b.addEventListener('click', () => setMdMode(m.key));
    seg.appendChild(b);
  });
  // Collapse file-list sidebar (mirrors the memo module).
  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'fv-btn fv-memo-collapse-btn';
  collapseBtn.dataset.tip = t('收起文件列表', 'Collapse file list');
  collapseBtn.setAttribute('aria-label', t('收起文件列表', 'Collapse file list'));
  collapseBtn.setAttribute('aria-pressed', 'false');
  collapseBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1"/><line x1="6" y1="3" x2="6" y2="13"/></svg>';
  collapseBtn.addEventListener('click', () => {
    const collapsed = mdShell!.classList.toggle('md-sidebar-collapsed');
    collapseBtn.setAttribute('aria-pressed', String(collapsed));
    chrome.storage.local.set({ [MD_COLLAPSED_KEY]: collapsed }).catch(() => { /* ignore */ });
  });
  left.append(collapseBtn, seg);
  bar.appendChild(left);

  const right = document.createElement('div');
  right.style.cssText = 'display:flex;align-items:center;gap:8px;';

  const fsBtn = mkMdBarBtn('<path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3"/>', t('全屏', 'Fullscreen'), () => {
    mdShell!.classList.add('md-fullscreen');
  });
  right.appendChild(fsBtn);

  // Import .md files
  const importBtn = mkMdBarBtn('<path d="M8 14V6m3 3-3-3-3 3"/><path d="M2 2h12"/>', t('导入', 'Import'), null);
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = '.md,.markdown,text/markdown,text/plain';
  importInput.multiple = true;
  importInput.style.cssText = 'position:absolute;left:-9999px;top:0;opacity:0;';
  document.body.appendChild(importInput);
  importInput.addEventListener('change', () => {
    const files = importInput.files;
    if (!files || files.length === 0) return;
    let loaded = 0;
    const total = files.length;
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const now = Date.now();
        mdFiles.unshift({
          id: mdUid(),
          title: file.name.replace(/\.(md|markdown|txt)$/i, ''),
          content: String(reader.result),
          updatedAt: now,
          createdAt: now,
        });
        loaded++;
        if (loaded === total) {
          // Select the first imported file; persist directly (no flush — we
          // just wrote mdFiles).
          mdActiveId = mdFiles[0].id;
          loadMdIntoEditor(mdFiles[0]);
          renderMdList();
          chrome.storage.local.set({ [MD_KEY]: mdFiles, [MD_CUR_KEY]: mdActiveId }).catch(() => { /* ignore */ });
        }
      };
      reader.onerror = () => { loaded++; };
      reader.readAsText(file);
    });
    importInput.value = '';
  });
  importBtn.addEventListener('click', () => importInput.click());
  right.appendChild(importBtn);

  // Export dropdown: current / all
  const exportWrap = document.createElement('div');
  exportWrap.style.cssText = 'position:relative;';
  const exportBtn = mkMdBarBtn('<path d="M8 2v8m-3-3 3 3 3-3"/><path d="M2 10v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3"/>', t('导出', 'Export'), null);
  exportWrap.appendChild(exportBtn);
  const exportDrop = document.createElement('div');
  exportDrop.className = 'fv-memo-export-drop';
  exportDrop.style.display = 'none';
  function expItem(label: string, fn: () => void): HTMLButtonElement {
    const it = document.createElement('button');
    it.type = 'button';
    it.className = 'fv-memo-export-item';
    it.textContent = label;
    it.addEventListener('click', () => { fn(); exportDrop.style.display = 'none'; });
    return it;
  }
  exportDrop.appendChild(expItem(t('导出当前文档', 'Export current'), () => {
    const f = currentMd();
    if (!f) return;
    const name = (f.title || 'document').replace(/[\\/:*?"<>|]/g, '_').trim() || 'document';
    mdDownload(name + '.md', f.content, true);
  }));
  exportDrop.appendChild(expItem(t('导出所有文档', 'Export all'), () => {
    if (mdFiles.length === 0) return;
    mdFiles.forEach((f, i) => {
      const name = (f.title || ('document-' + (i + 1))).replace(/[\\/:*?"<>|]/g, '_').trim() || ('document-' + (i + 1));
      setTimeout(() => mdDownload(name + '.md', f.content, false), i * 150);
    });
  }));
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const show = exportDrop.style.display === 'none';
    exportDrop.style.display = show ? '' : 'none';
    if (show) {
      exportDrop.classList.remove('fv-overlay-in');
      void exportDrop.offsetWidth;
      exportDrop.classList.add('fv-overlay-in');
    }
  });
  document.addEventListener('click', (e) => {
    if (exportDrop.style.display === 'none') return;
    if (exportWrap.contains(e.target as Node)) return;
    exportDrop.style.display = 'none';
  });
  exportWrap.appendChild(exportDrop);
  right.appendChild(exportWrap);

  bar.appendChild(right);
  mdShell.appendChild(bar);

  // ── Body: sidebar + editor ──
  const body = document.createElement('div');
  body.className = 'fv-md-body';

  const sidebar = document.createElement('div');
  sidebar.className = 'fv-memo-sidebar';
  const newSidebarBtn = document.createElement('button');
  newSidebarBtn.type = 'button';
  newSidebarBtn.className = 'fv-memo-new';
  newSidebarBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M8 3v10"/></svg>'
    + t('新建文档', 'New document');
  newSidebarBtn.addEventListener('click', () => createMd());
  sidebar.appendChild(newSidebarBtn);
  mdListEl = document.createElement('div');
  mdListEl.className = 'fv-memo-list';
  sidebar.appendChild(mdListEl);

  const divider = document.createElement('div');
  divider.className = 'fv-memo-divider';

  const editor = document.createElement('div');
  editor.className = 'fv-memo-editor';

  const titleBar = document.createElement('div');
  titleBar.className = 'fv-memo-title-bar';
  mdTitleEl = document.createElement('input');
  mdTitleEl.className = 'fv-memo-title';
  mdTitleEl.placeholder = t('文档标题…', 'Document title…');
  mdTitleEl.addEventListener('input', () => { flushEditorToMd(); renderMdList(); saveMd(); });
  titleBar.appendChild(mdTitleEl);
  editor.appendChild(titleBar);

  // Workspace: textarea (edit) + preview, visibility driven by data-mode.
  mdWorkspaceEl = document.createElement('div');
  mdWorkspaceEl.className = 'fv-md-workspace';
  mdWorkspaceEl.dataset.mode = mdMode;

  mdEditEl = document.createElement('textarea');
  mdEditEl.className = 'fv-md-edit fv-memo-body';
  mdEditEl.spellcheck = false;
  mdEditEl.placeholder = t('在此输入 Markdown…', 'Type Markdown here…');
  mdEditEl.addEventListener('input', () => { flushEditorToMd(); renderMdPreview(); saveMd(); });
  // Scroll sync (edit → preview): in split mode, scrolling the editor scrolls
  // the preview proportionally. Proportional (not source-line-mapped) — cheap
  // and good enough for an editor/preview pair.
  mdEditEl.addEventListener('scroll', () => {
    if (mdMode !== 'split' || !mdPreviewEl || !mdEditEl) return;
    const em = mdEditEl, pm = mdPreviewEl;
    const emMax = em.scrollHeight - em.clientHeight;
    const pmMax = pm.scrollHeight - pm.clientHeight;
    if (emMax <= 0 || pmMax <= 0) return;
    pm.scrollTop = Math.min(pmMax, Math.max(0, (em.scrollTop / emMax) * pmMax));
  });
  mdEditEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const ta = mdEditEl!;
    const s = ta.selectionStart, en = ta.selectionEnd;
    const INDENT = '  ';
    if (e.shiftKey) {
      const before = ta.value.slice(0, s);
      const lineStart = before.lastIndexOf('\n') + 1;
      if (ta.value.slice(lineStart, lineStart + 2) === INDENT) {
        ta.setSelectionRange(lineStart, lineStart + 2);
        document.execCommand('insertText', false, '');
      }
    } else {
      document.execCommand('insertText', false, INDENT);
    }
    void en;
  });

  mdPreviewEl = document.createElement('div');
  mdPreviewEl.className = 'fv-md-preview fv-md-root';

  mdWorkspaceEl.append(mdEditEl, mdPreviewEl);
  editor.appendChild(mdWorkspaceEl);

  body.append(sidebar, divider, editor);
  mdShell.appendChild(body);
  document.body.appendChild(mdShell);

  // Esc exits fullscreen.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mdShell?.classList.contains('md-fullscreen')) {
      mdShell.classList.remove('md-fullscreen');
    }
  });

  // ── Load persisted files + mode ──
  chrome.storage.local.get([MD_KEY, MD_CUR_KEY, MD_MODE_KEY, MD_COLLAPSED_KEY]).then((data) => {
    const files = data[MD_KEY] as MdFile[] | undefined;
    if (Array.isArray(files) && files.length > 0) {
      mdFiles = files;
    } else {
      const now = Date.now();
      mdFiles = [{ id: mdUid(), title: '', content: '', updatedAt: now, createdAt: now }];
    }
    const cur = data[MD_CUR_KEY] as string | undefined;
    mdActiveId = (cur && mdFiles.some((f) => f.id === cur)) ? cur : mdFiles[0].id;
    const savedMode = data[MD_MODE_KEY] as MdMode | undefined;
    if (savedMode === 'edit' || savedMode === 'split' || savedMode === 'preview') {
      setMdMode(savedMode);
    }
    if (data[MD_COLLAPSED_KEY]) {
      mdShell?.classList.add('md-sidebar-collapsed');
      mdShell?.querySelector('.fv-memo-collapse-btn')?.setAttribute('aria-pressed', 'true');
    }
    loadMdIntoEditor(currentMd() ?? mdFiles[0]);
    renderMdList();
  }).catch(() => { /* ignore */ });
}

// Small bar button helper for the Markdown shell: icon + label.
function mkMdBarBtn(iconPath: string, label: string, onClick: (() => void) | null): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'fv-btn';
  b.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + iconPath + '</svg>'
    + '<span style="font-size:12px">' + label + '</span>';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

// Download a Markdown file. Uses text/markdown MIME and (for single-file
// export) prompts for the save location so it isn't silently dumped + auto-
// opened. Batch export (all files) skips the prompt to avoid N dialogs.
function mdDownload(filename: string, content: string, saveAs: boolean): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  if (typeof chrome !== 'undefined' && chrome.downloads) {
    chrome.downloads.download({ url, filename, saveAs })
      .catch(() => fallbackAnchorDownload(url, filename));
  } else {
    fallbackAnchorDownload(url, filename);
  }
}

function toggleMdShell(on: boolean): void {
  if (!mdShell) return;
  mdShell.style.display = on ? '' : 'none';
  const split = document.querySelector<HTMLElement>('.fv-pg-split');
  if (split) split.style.display = on ? 'none' : '';
  if (on) {
    renderMdPreview(); // keep the preview fresh on re-entry
    mdShell.classList.remove('fv-pg-fade');
    void mdShell.offsetWidth;
    mdShell.classList.add('fv-pg-fade');
  }
}
