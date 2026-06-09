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
  clear:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h10"/><path d="M5 5V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M5 5l1 9a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1l1-9"/></svg>',
  fontSize: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14 L8 3 L13 14"/><line x1="5" y1="10" x2="11" y2="10"/></svg>',
  repo:     '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 8v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4"/><polyline points="9 3 13 3 13 7"/><line x1="13" y1="3" x2="7" y2="9"/></svg>',
  pin:      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1l2 4 4 1-3 3 1 4-4-2-4 2 1-4-3-3 4-1 2-4z"/></svg>',
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

function build(): void {
  // ── Toolbar ─────────────────────────────────────────────────
  const toolbar = document.createElement('div');
  toolbar.className = 'fv-toolbar';

  const left = document.createElement('div');
  left.className = 'fv-toolbar-left';

  const right = document.createElement('div');
  right.className = 'fv-toolbar-right';

  const copyBtn  = iconBtn(ICONS.copy,  t('复制结果', 'Copy result'));
  copyBtn.addEventListener('click', () => {
    const txt = currentOutputText();
    if (txt != null) copyText(txt);
  });

  const clearBtn = iconBtn(ICONS.clear, t('清空当前格式', 'Clear current format'));
  clearBtn.addEventListener('click', () => {
    if (currentMode === 'memo') {
      const a = document.getElementById('fv-memo-1') as HTMLTextAreaElement | null;
      const b = document.getElementById('fv-memo-2') as HTMLTextAreaElement | null;
      if (a) a.value = '';
      if (b) b.value = '';
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
  const split = document.createElement('div');
  split.className = 'fv-pg-split';

  // Input pane: header + numbered layout (gutter + textarea)
  const inputPane = document.createElement('div');
  inputPane.className = 'fv-pg-pane';
  const inputHeader = document.createElement('div');
  inputHeader.className = 'fv-pg-pane-header';
  inputHeader.textContent = t('输入', 'Input');

  // Gutter for the input textarea — shares font-size/line-height with the
  // textarea so every row stays aligned. Padding-top matches textarea's 14px.
  const inputGutter = document.createElement('div');
  inputGutter.className = 'fv-pg-gutter';
  inputGutter.style.position = 'static';
  inputGutter.style.paddingTop = '14px';
  const inputGutterInner = document.createElement('div');
  inputGutter.appendChild(inputGutterInner);

  // Textarea fills the content area
  const inputContent = document.createElement('div');
  inputContent.className = 'fv-pg-content';
  inputContent.style.position = 'relative';

  input = document.createElement('textarea');
  input.className = 'fv-pg-input';
  input.spellcheck = false;

  let debounce: ReturnType<typeof setTimeout> | null = null;
  let inputLineCount = 1;

  function refreshInputGutterFn(): void {
    const lines = Math.max(1, input.value.split('\n').length);
    if (lines === inputLineCount) return;
    inputLineCount = lines;
    while (inputGutterInner.childElementCount > lines) inputGutterInner.removeChild(inputGutterInner.lastChild!);
    while (inputGutterInner.childElementCount < lines) {
      const d = document.createElement('div');
      d.className = 'fv-pg-gutter-ln';
      inputGutterInner.appendChild(d);
    }
    for (let i = 0; i < lines; i++) {
      (inputGutterInner.children[i] as HTMLElement).textContent = String(i + 1);
    }
  }

  input.addEventListener('input', () => {
    if (currentMode !== 'diff' && currentMode !== 'memo' && state.inputs) {
      state.inputs[currentMode] = input.value;
    }
    scheduleSave();
    refreshInputGutterFn();
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(runFormat, 120);
  });

  // Sync gutter scroll position with the textarea's content position.
  // Since we hide the textarea's native scrollbar, we use the parent's scroll.
  input.addEventListener('scroll', () => {
    inputGutterInner.style.transform = `translateY(${-input.scrollTop}px)`;
  });

  // On resize (e.g. font-size toggle), update the gutter.
  refreshInputGutter = refreshInputGutterFn;

  const inputObserver = new ResizeObserver(() => refreshInputGutterFn());
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

  const inputWrap = document.createElement('div');
  inputWrap.className = 'fv-pg-numbered';
  inputWrap.style.flex = '1';
  inputWrap.style.minHeight = '0';
  input.style.width = '100%';
  input.style.height = '100%';
  inputContent.appendChild(input);
  inputWrap.append(inputGutter, inputContent);
  inputPane.append(inputHeader, inputWrap);

  // Current-line highlight for the main input
  addLineHighlight(input, inputContent);

  // Output pane: header (sub-chips slot) + output body
  const outputPane = document.createElement('div');
  outputPane.className = 'fv-pg-pane';
  outputHeader = document.createElement('div');
  outputHeader.className = 'fv-pg-pane-header';
  outputHeader.textContent = t('结果', 'Result');

  output = document.createElement('div');
  output.className = 'fv-pg-output';
  output.tabIndex = 0;
  outputPane.append(outputHeader, output);

  split.append(inputPane, outputPane);
  document.body.append(split);

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
  if (mode !== 'diff' && mode !== 'memo') {
    input.value = (state.inputs && state.inputs[mode]) ?? '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (refreshInputGutter) refreshInputGutter();
  applyPlaceholder();
  scheduleSave();
  updateChips();
  runFormat();
}

// ── Formatting pipeline ───────────────────────────────────────
let lastResultText: string | null = null;

// Translation cache
let trLastText = '';
let trLastResult = '';

function currentOutputText(): string | null { return lastResultText; }

function runFormat(): void {
  toggleDiffShell(currentMode === 'diff');
  toggleMemoShell(currentMode === 'memo');
  if (currentMode === 'diff' || currentMode === 'memo') return;

  const raw = input.value;
  lastResultText = null;
  resetOutputHeader();

  if (!raw.trim()) {
    output.innerHTML = '';
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
}

// ── Renderers (output side) ───────────────────────────────────
type JsonView = 'format' | 'minify' | 'escape' | 'unescape';

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
    if (txt != null) copyText(txt);
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
  const { wrap, refreshGutter } = withGutter(root);
  output.appendChild(wrap);
  refreshGutter(Math.max(1, raw.split('\n').length));
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
    b.style.cssText = 'font-size:13px;padding:5px 14px;border:1px solid var(--fv-focus);color:#fff;background:#0550ae;border-radius:6px;';
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
  const SCALE = 18;
  const QUIET = 4;
  const total = qr.size + QUIET * 2;
  const grid = document.createElement('div');
  grid.className = 'fv-pg-qr';
  grid.style.cssText =
    `display:grid;` +
    `grid-template-columns:repeat(${qr.size},${SCALE}px);` +
    `grid-template-rows:repeat(${qr.size},${SCALE}px);` +
    `padding:${QUIET * SCALE}px;` +
    `background:#fff;` +
    `width:${qr.size * SCALE}px;` +
    `box-sizing:content-box;`;

  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      const m = document.createElement('b');
      m.style.cssText = `display:block;width:${SCALE}px;height:${SCALE}px;` +
        `background:${qr.matrix[r][c] ? '#000' : '#fff'};`;
      grid.appendChild(m);
    }
  }

  // Also build a canvas for the download button
  const canvas = document.createElement('canvas');
  const cpx = (qr.size + QUIET * 2) * SCALE;
  canvas.width = cpx;
  canvas.height = cpx;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cpx, cpx);
  ctx.fillStyle = '#000';
  for (let r = 0; r < qr.size; r++)
    for (let c = 0; c < qr.size; c++)
      if (qr.matrix[r][c])
        ctx.fillRect((c + QUIET) * SCALE, (r + QUIET) * SCALE, SCALE, SCALE);

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
  if (on && diffRefresh) diffRefresh();
}

// ── Current-line highlight ─────────────────────────────────────
// Adds a background overlay behind a textarea that highlights the line
// the cursor is on. The textarea must already be in a position:relative
// container and have `background: transparent` for the overlay to show.
function addLineHighlight(ta: HTMLTextAreaElement, container: HTMLElement): () => void {
  const hl = document.createElement('div');
  hl.className = 'fv-pg-line-hl';
  hl.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;' +
    'pointer-events:none;overflow:hidden;padding:14px;' +
    'font-family:var(--fv-font-mono);font-size:var(--fv-font-size);' +
    'line-height:var(--fv-line-height);white-space:pre;';

  const inner = document.createElement('div');
  hl.appendChild(inner);
  container.insertBefore(hl, ta);

  // Make the textarea transparent so the overlay shows through
  const prevBg = ta.style.background || getComputedStyle(ta).background;
  ta.dataset.prevBg = prevBg;
  ta.style.background = 'transparent';
  ta.style.backgroundImage = 'none';

  let currentLine = 0;

  function getLine(): number {
    const val = ta.value;
    const pos = ta.selectionStart;
    if (pos < 0) return 0;
    let line = 0;
    for (let i = 0; i < pos; i++) {
      if (val[i] === '\n') line++;
    }
    return line;
  }

  function paint(): void {
    const lines = Math.max(1, ta.value.split('\n').length);
    const line = getLine();
    if (line === currentLine && inner.childElementCount === lines) return;
    currentLine = line;

    inner.innerHTML = '';
    for (let i = 0; i < lines; i++) {
      const d = document.createElement('div');
      if (i === line) d.className = 'fv-pg-line-hl-active';
      d.textContent = '​'; // zero-width space, keeps row height
      inner.appendChild(d);
    }
  }

  function syncScroll(): void {
    inner.style.transform = `translateY(${-ta.scrollTop}px)`;
    hl.scrollLeft = ta.scrollLeft;
  }

  // Disable wrapping so each logical line = one visual row
  ta.wrap = 'off';

  function paintSoon(): void { requestAnimationFrame(paint); }

  ta.addEventListener('keydown', paintSoon);
  ta.addEventListener('click', paint);
  ta.addEventListener('focus', paint);
  ta.addEventListener('scroll', syncScroll);
  ta.addEventListener('input', paintSoon);
  paint();
  syncScroll();

  return () => {
    ta.style.background = ta.dataset.prevBg || '';
    delete ta.dataset.prevBg;
    hl.remove();
  };
}

// ── Memo mode ─────────────────────────────────────────────────
let memoShell: HTMLElement | null = null;

const MEMO_KEY_1 = 'pg_memo_1';
const MEMO_KEY_2 = 'pg_memo_2';

function saveMemo(): void {
  if (memoTimer) clearTimeout(memoTimer);
  memoTimer = setTimeout(() => {
    const a = document.getElementById('fv-memo-1') as HTMLTextAreaElement | null;
    const b = document.getElementById('fv-memo-2') as HTMLTextAreaElement | null;
    chrome.storage.local.set({
      [MEMO_KEY_1]: a?.value ?? '',
      [MEMO_KEY_2]: b?.value ?? '',
    }).catch(() => { /* ignore */ });
  }, 300);
}

function buildMemoShell(): void {
  memoShell = document.createElement('div');
  memoShell.className = 'fv-pg-diff-shell';
  memoShell.style.display = 'none';

  const bar = document.createElement('div');
  bar.className = 'fv-pg-diff-bar';
  bar.style.justifyContent = 'space-between';

  const exportBtn = document.createElement('button');
  exportBtn.className = 'fv-btn';
  exportBtn.dataset.tip = t('导出 TXT', 'Export TXT');
  exportBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8m-3-3 3 3 3-3"/><path d="M2 10v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3"/></svg>'
    + '<span style="font-size:12px">' + t('导出', 'Export') + '</span>';
  exportBtn.addEventListener('click', () => {
    const a = document.getElementById('fv-memo-1') as HTMLTextAreaElement | null;
    const b = document.getElementById('fv-memo-2') as HTMLTextAreaElement | null;
    if (a) downloadText('memo-1.txt', a.value);
    if (b) downloadText('memo-2.txt', b.value);
  });
  bar.appendChild(exportBtn);
  memoShell.appendChild(bar);

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;display:grid;grid-template-columns:1fr 4px 1fr;grid-template-rows:1fr;min-height:0;';

  const left = mkMemoPane(t('备忘录 1', 'Memo 1'), 'fv-memo-1');
  const right = mkMemoPane(t('备忘录 2', 'Memo 2'), 'fv-memo-2');
  const divider = document.createElement('div');
  divider.style.cssText = 'background:var(--fv-border);';

  body.append(left, divider, right);
  memoShell.appendChild(body);
  document.body.appendChild(memoShell);

  // Load saved content
  chrome.storage.local.get([MEMO_KEY_1, MEMO_KEY_2]).then((data) => {
    const a = document.getElementById('fv-memo-1') as HTMLTextAreaElement | null;
    const b = document.getElementById('fv-memo-2') as HTMLTextAreaElement | null;
    if (a) a.value = (data[MEMO_KEY_1] as string) ?? '';
    if (b) b.value = (data[MEMO_KEY_2] as string) ?? '';
  }).catch(() => { /* ignore */ });
}

function mkMemoPane(title: string, id: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;min-width:0;min-height:0;flex:1;background:var(--fv-bg);';

  const head = document.createElement('div');
  head.className = 'fv-pg-pane-header';
  head.textContent = title;
  wrap.appendChild(head);

  // Scroll-synced gutter, same as the main playground input
  const gutter = document.createElement('div');
  gutter.className = 'fv-pg-gutter';
  gutter.style.position = 'static';
  gutter.style.paddingTop = '14px';
  const gutterInner = document.createElement('div');
  gutter.appendChild(gutterInner);

  const contentWrap = document.createElement('div');
  contentWrap.className = 'fv-pg-content';
  contentWrap.style.cssText = 'min-height:0;position:relative;';

  const ta = document.createElement('textarea');
  ta.id = id;
  ta.className = 'fv-pg-input';
  ta.style.cssText = 'width:100%;height:100%;';
  ta.spellcheck = false;

  function refreshGutter(): void {
    const lines = Math.max(1, ta.value.split('\n').length);
    while (gutterInner.childElementCount > lines) gutterInner.removeChild(gutterInner.lastChild!);
    while (gutterInner.childElementCount < lines) {
      const d = document.createElement('div');
      d.className = 'fv-pg-gutter-ln';
      gutterInner.appendChild(d);
    }
    for (let i = 0; i < lines; i++) {
      (gutterInner.children[i] as HTMLElement).textContent = String(i + 1);
    }
  }

  ta.addEventListener('input', () => { saveMemo(); refreshGutter(); });
  ta.addEventListener('scroll', () => {
    gutterInner.style.transform = `translateY(${-ta.scrollTop}px)`;
  });
  refreshGutter();

  const row = document.createElement('div');
  row.className = 'fv-pg-numbered';
  row.style.flex = '1';
  row.style.minHeight = '0';
  contentWrap.appendChild(ta);
  addLineHighlight(ta, contentWrap);
  row.append(gutter, contentWrap);
  wrap.appendChild(row);
  return wrap;
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
}
