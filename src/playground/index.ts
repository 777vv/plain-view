// Playground page — paste any text and format it on the fly.

import { setupPage, copyText, injectStyles } from '../ui/common';
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

// ── DOM building ──────────────────────────────────────────────
// All of these are initialized synchronously inside `build()` (called from the
// boot IIFE) before any other code references them; the `!` assertions tell
// TypeScript to trust that.
let input!: HTMLTextAreaElement;
let output!: HTMLDivElement;
let outputHeader!: HTMLElement;
let chips!: HTMLElement;
let copyBtn!: HTMLButtonElement;
let split!: HTMLElement;
let currentMode: Mode = 'json';

let diffShell!: HTMLElement;
let diffLeft!:  HTMLTextAreaElement;
let diffRight!: HTMLTextAreaElement;
let diffRefresh: (() => void) | null = null;
let diffDebounce: ReturnType<typeof setTimeout> | null = null;

let memoTimer: ReturnType<typeof setTimeout> | null = null;

let refreshInputGutter: (() => void) | null = null;

let enabledFeatures: Set<string> = new Set();

async function loadEnabledFeatures(): Promise<void> {
  const data = await chrome.storage.local.get('disabledFormats');
  const disabled = new Set((data['disabledFormats'] as string[]) ?? []);
  const all = ['json','markdown','sql','translate','url','base64','diff','qr','memo'];
  enabledFeatures = new Set(all.filter((id) => !disabled.has(id)));
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

function rebuildChips(): void {
  loadEnabledFeatures().then(() => {
    const visible = ALL_LABELS.filter((l) => enabledFeatures.has(l.key));
    chips.innerHTML = '';
    visible.forEach(({ key, zh, en }) => {
      const c = document.createElement('button');
      c.className = 'fv-pg-chip';
      c.dataset.mode = key;
      c.textContent = isZh() ? zh : en;
      c.addEventListener('click', () => switchMode(key));
      chips.appendChild(c);
    });
    if (!visible.some((l) => l.key === currentMode)) {
      switchMode(visible[0].key);
    } else {
      updateChips();
    }
  });
}

// ── Boot ──────────────────────────────────────────────────────
(async () => {
  await injectStyles();
  setupPage(t('Plain View 工作台', 'Plain View Playground'));
  document.body.classList.add('fv-playground-body');

  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    if (data[STORAGE_KEY] && typeof data[STORAGE_KEY] === 'object') {
      state = data[STORAGE_KEY] as StoredState;
    }
  } catch { /* fresh state */ }
  if (state.mode) currentMode = state.mode;
  if (!state.inputs) state.inputs = {};

  await loadEnabledFeatures();

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
  if (changes['disabledFormats']) rebuildChips();
});

// Mode-specific input placeholder. Shown on the left-side textarea.
const PLACEHOLDERS: Record<SingleMode, { zh: string; en: string }> = {
  json:      { zh: '在此粘贴或拖入 JSON 文件,例如 {"a":1}',       en: 'Paste or drop a JSON file, e.g. {"a":1}' },
  markdown:  { zh: '在此粘贴或拖入 Markdown 文件',                 en: 'Paste or drop a Markdown file' },
  sql:       { zh: '在此粘贴或拖入 SQL 文件',                      en: 'Paste or drop a SQL file' },
  base64:    { zh: '在这里粘贴 Base64 / 文本',                     en: 'Paste Base64 text (or plain text to encode)' },
  url:       { zh: '在这里粘贴 URL',                               en: 'Paste a URL here' },
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

    // Measure each logical line's rendered height
    mirror.innerHTML = '';
    const blocks: HTMLDivElement[] = [];
    for (const ln of lines) {
      const d = document.createElement('div');
      d.style.cssText = 'white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;';
      d.textContent = ln === '' ? '​' : ln;
      mirror.appendChild(d);
      blocks.push(d);
    }

    // Rebuild gutter rows with matching heights
    gutterInner.innerHTML = '';
    for (let i = 0; i < lines.length; i++) {
      const g = document.createElement('div');
      g.className = 'fv-pg-gutter-ln';
      g.textContent = String(i + 1);
      g.style.height = blocks[i].offsetHeight + 'px';
      gutterInner.appendChild(g);
    }
  }

  return refresh;
}

function build(): void {
  // ── Toolbar ─────────────────────────────────────────────────
  const toolbar = document.createElement('div');
  toolbar.className = 'fv-toolbar';

  const left = document.createElement('div');
  left.className = 'fv-toolbar-left';

  const right = document.createElement('div');
  right.className = 'fv-toolbar-right';

  copyBtn = iconBtn(ICONS.copy,  t('复制结果', 'Copy result'));
  copyBtn.addEventListener('click', () => {
    // memo mode: copy the active memo's content directly.
    const txt = currentMode === 'memo' ? (currentMemo()?.content ?? null) : currentOutputText();
    if (txt == null || txt === '') return;
    copyText(txt).then(() => {
      const orig = copyBtn.innerHTML;
      copyBtn.innerHTML = ICONS.check;
      setTimeout(() => { copyBtn.innerHTML = orig; }, 1200);
    });
  });

  const clearBtn = iconBtn(ICONS.clear, t('清空当前格式', 'Clear current format'));
  clearBtn.addEventListener('click', () => {
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
    } else if (currentMode === 'diff') {
      diffLeft.value  = '';
      diffRight.value = '';
      state.diffLeft  = '';
      state.diffRight = '';
      if (diffRefresh) diffRefresh();
    } else {
      input.value = '';
      if (state.inputs) state.inputs[currentMode as SingleMode] = '';
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
  chips = document.createElement('div');
  chips.className = 'fv-pg-chips';
  ALL_LABELS.filter((l) => enabledFeatures.has(l.key)).forEach(({ key, zh, en }) => {
    const c = document.createElement('button');
    c.className = 'fv-pg-chip';
    c.dataset.mode = key;
    c.textContent = isZh() ? zh : en;
    c.addEventListener('click', () => {
      switchMode(key);
    });
    chips.appendChild(c);
  });
  document.body.append(chips);
  updateChips();

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
  const inputScroll = document.createElement('div');
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
    syncInput();
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(runFormat, 120);
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

  const inputObserver = new ResizeObserver(() => syncInput());
  inputObserver.observe(input);

  // Drag-and-drop file → load content + auto-switch mode
  input.addEventListener('dragover', (e) => { e.preventDefault(); });
  input.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase();
    const extToMode: Record<string, Mode> = {
      json: 'json', md: 'markdown', markdown: 'markdown', sql: 'sql',
    };
    const mode = ext ? extToMode[ext] : undefined;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      if (mode) {
        if (mode !== 'diff' && mode !== 'memo') {
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
  function applySplitRatio(): void {
    const clamped = Math.max(0.15, Math.min(0.85, splitRatio));
    splitRatio = clamped;
    split.style.gridTemplateColumns =
      `${(clamped * 100).toFixed(2)}% 6px ${((1 - clamped) * 100).toFixed(2)}%`;
  }
  applySplitRatio();

  let dragging = false;
  paneDivider.addEventListener('mousedown', (e) => {
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

  // Diff shell: separate layout (hidden by default).
  buildDiffShell();
  buildMemoShell();
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
  chips.querySelectorAll<HTMLElement>('.fv-pg-chip').forEach((c) => {
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
  if (mode !== 'diff' && mode !== 'memo') {
    input.value = (state.inputs && state.inputs[mode]) ?? '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (refreshInputGutter) refreshInputGutter();
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

function currentOutputText(): string | null { return lastResultText; }

// Enable/disable the copy button based on whether there is anything to copy
// in the current mode. Called after every mode switch and format run.
function updateCopyBtnState(): void {
  if (!copyBtn) return;
  let hasContent: boolean;
  if (currentMode === 'memo') {
    hasContent = !!currentMemo()?.content;
  } else if (currentMode === 'diff') {
    hasContent = false; // diff has no single "result" to copy
  } else {
    hasContent = lastResultText != null && lastResultText !== '';
  }
  copyBtn.disabled = !hasContent;
  copyBtn.dataset.tip = hasContent ? t('复制结果', 'Copy result') : t('无内容可复制', 'Nothing to copy');
}

function runFormat(): void {
  toggleDiffShell(currentMode === 'diff');
  toggleMemoShell(currentMode === 'memo');
  if (currentMode === 'diff' || currentMode === 'memo') return;

  const raw = input.value;
  lastResultText = null;
  resetOutputHeader();

  if (!raw.trim()) {
    showEmptyOutput();
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
      case 'markdown':  renderMarkdown(raw); break;
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
    + '<div class="fv-pg-empty-text">' + t('在左侧粘贴内容，即可在此查看结果', 'Paste content on the left to see formatted output here') + '</div>';
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

function renderMarkdown(raw: string): void {
  const root = document.createElement('div');
  root.className = 'fv-md-root';
  root.innerHTML = mdToHtml(raw);
  output.appendChild(root);
  lastResultText = root.innerText;
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
    if (!text) return;

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
      const translated = await translateChunk(text, sl, tl);
      const pre = document.createElement('pre');
      pre.className = 'fv-pg-sec-body';
      pre.style.whiteSpace = 'pre-wrap';
      pre.textContent = translated;
      resultArea.innerHTML = '';
      resultArea.appendChild(pre);
      trLastResult = translated;
      trLastText = text;
      lastResultText = translated;
    } catch {
      resultArea.innerHTML = '';
      resultArea.appendChild(buildErrorPlaceholder(
        t('翻译失败', 'Translation failed'),
        t('请检查网络连接后重试', 'Check your network and try again'),
      ));
    }
  }

  function mkTrBtn(label: string, sl: string, tl: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'fv-btn';
    b.style.cssText = 'font-size:13px;padding:5px 14px;border:1px solid var(--fv-focus);color:#fff;background:#d81b60;border-radius:6px;';
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

async function translateChunk(text: string, sl: string, tl: string): Promise<string> {
  const pair = `${sl}|${tl}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${pair}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  const result = json.responseData?.translatedText;
  if (!result || result.includes('MYMEMORY WARNING')) throw new Error('quota');
  return result;
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
};

let memoShell: HTMLElement | null = null;
let memoFiles: MemoFile[] = [];
let memoActiveId: string | null = null;
// id of the file currently being dragged (for manual reordering).
let memoDragId: string | null = null;
// Cached handles to the editor elements (built once in buildMemoShell).
let memoListEl: HTMLElement | null = null;
let memoTitleEl: HTMLInputElement | null = null;
let memoBodyEl: HTMLTextAreaElement | null = null;

const MEMO_KEY = 'pg_memo_v2';
const MEMO_CUR_KEY = 'pg_memo_cur';
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

function renderMemoList(): void {
  if (!memoListEl) return;
  memoListEl.textContent = '';
  for (const f of memoFiles) {
    const item = document.createElement('div');
    item.className = 'fv-memo-item' + (f.id === memoActiveId ? ' active' : '');
    item.draggable = true;
    item.dataset.id = f.id;

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
  const f: MemoFile = { id: memoUid(), title: '', content: '', updatedAt: now, createdAt: now };
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
    const f: MemoFile = { id: memoUid(), title: '', content: '', updatedAt: now, createdAt: now };
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
  bar.appendChild(title);

  const exportBtn = document.createElement('button');
  exportBtn.className = 'fv-btn';
  exportBtn.dataset.tip = t('导出当前 TXT', 'Export current as TXT');
  exportBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8m-3-3 3 3 3-3"/><path d="M2 10v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3"/></svg>'
    + '<span style="font-size:12px">' + t('导出', 'Export') + '</span>';
  exportBtn.addEventListener('click', () => {
    const f = currentMemo();
    if (!f) return;
    const name = (f.title || 'memo').replace(/[\\/:*?"<>|]/g, '_').trim() || 'memo';
    downloadText(name + '.txt', f.content);
  });
  bar.appendChild(exportBtn);
  memoShell.appendChild(bar);

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;display:grid;grid-template-columns:240px 4px 1fr;grid-template-rows:1fr;min-height:0;';

  // ── Left sidebar: new-file button + scrollable file list ──
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

  const divider = document.createElement('div');
  divider.style.cssText = 'background:var(--fv-border);';

  // ── Right editor: title input + body textarea (no line-number gutter) ──
  const editor = document.createElement('div');
  editor.className = 'fv-memo-editor';

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

  const bodyTa = document.createElement('textarea');
  bodyTa.className = 'fv-memo-body';
  bodyTa.spellcheck = false;
  bodyTa.placeholder = t('在此输入备忘内容…', 'Type your notes here…');
  bodyTa.addEventListener('input', () => { saveMemo(); });
  memoBodyEl = bodyTa;

  editor.append(titleInput, bodyTa);

  body.append(sidebar, divider, editor);
  memoShell.appendChild(body);
  document.body.appendChild(memoShell);

  // Load saved files (or seed a default one), then activate.
  chrome.storage.local.get([MEMO_KEY, MEMO_CUR_KEY]).then((data) => {
    const files = data[MEMO_KEY] as MemoFile[] | undefined;
    const now = Date.now();
    memoFiles = Array.isArray(files) && files.length > 0
      ? files
      : [{ id: memoUid(), title: '', content: '', updatedAt: now, createdAt: now }];
    // Backfill createdAt on legacy records (pre-dating the sort feature).
    for (const f of memoFiles) {
      if (typeof f.createdAt !== 'number') f.createdAt = f.updatedAt;
    }
    memoActiveId = (data[MEMO_CUR_KEY] as string | undefined) ?? memoFiles[0].id;
    if (!memoFiles.some((f) => f.id === memoActiveId)) memoActiveId = memoFiles[0].id;
    const active = memoFiles.find((f) => f.id === memoActiveId) ?? memoFiles[0];
    memoActiveId = active.id;
    loadMemoIntoEditor(active);
    renderMemoList();
    if (memoFiles.length === 0 || !files || files.length === 0) saveMemo();
  }).catch(() => { /* ignore */ });

  // Clear legacy two-pane data on first run of v2.
  chrome.storage.local.remove(MEMO_LEGACY_KEYS).catch(() => { /* ignore */ });
}

function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
