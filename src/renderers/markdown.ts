import { createToolbar } from '../ui/toolbar';
import { setupPage, escHtml, copyText } from '../ui/common';
import { t } from '../ui/i18n';

let mdRoot: HTMLElement | null = null;
let rawDiv: HTMLElement | null = null;
let outlineWrapEl: HTMLElement | null = null;
let contentEl: HTMLElement | null = null;
let currentRaw = '';
let currentFilename = '';
let dragLineEl: HTMLElement | null = null;
let mdOutlineW = 240;
let mdOutlineCollapsed = false;
const OUTLINE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="4" x2="13" y2="4"/><line x1="3" y1="8" x2="13" y2="8"/><line x1="3" y1="12" x2="13" y2="12"/></svg>';
const OUTLINE_W_KEY = 'fv_md_outline_w';
const OUTLINE_COLLAPSED_KEY = 'fv_md_outline_collapsed';
const OUTLINE_MIN = 160, OUTLINE_MAX = 480, OUTLINE_RAIL = 38;

export function render(raw: string): void {
  currentRaw = raw;
  // location.pathname percent-encodes non-ASCII (e.g. 中文 → %E4%B8%AD), so
  // decode it to show the real filename. decodeURIComponent can throw on a
  // malformed sequence — fall back to the raw value in that case.
  const rawName = location.pathname.split('/').pop() || 'README.md';
  try { currentFilename = decodeURIComponent(rawName); }
  catch { currentFilename = rawName; }
  setupPage(currentFilename);

  const content = document.createElement('div');
  content.className = 'fv-content fv-md-page';
  content.id = 'fv-content';

  mdRoot = document.createElement('div');
  mdRoot.className = 'fv-md-root';

  rawDiv = document.createElement('div');
  rawDiv.className = 'fv-raw-view';
  rawDiv.style.display = 'none';

  // Outline sidebar (Word-style navigation pane). The toggle sits in the pane
  // header so it stays reachable even when the pane collapses to a slim rail.
  const outlineWrap = document.createElement('div');
  outlineWrap.className = 'fv-md-outline-wrap';
  const outlineHeader = document.createElement('div');
  outlineHeader.className = 'fv-md-outline-header';
  const outlineToggle = document.createElement('button');
  outlineToggle.type = 'button';
  outlineToggle.className = 'fv-btn fv-md-outline-toggle';
  outlineToggle.dataset.tip = t('收起大纲', 'Collapse outline');
  outlineToggle.setAttribute('aria-label', t('大纲', 'Outline'));
  outlineToggle.innerHTML = OUTLINE_ICON;
  outlineToggle.addEventListener('click', () => setOutlineCollapsed(!mdOutlineCollapsed));
  outlineHeader.appendChild(outlineToggle);
  const outline = document.createElement('div');
  outline.className = 'fv-md-outline';
  outlineWrap.append(outlineHeader, outline);
  outlineWrapEl = outlineWrap;
  contentEl = content;

  // Draggable divider between the pane and the content.
  const dragLine = document.createElement('div');
  dragLine.className = 'fv-md-outline-drag';
  dragLine.title = t('拖动调整宽度', 'Drag to resize');
  dragLine.addEventListener('mousedown', startOutlineResize);
  dragLineEl = dragLine;

  content.append(outlineWrap, mdRoot, rawDiv);
  document.body.appendChild(dragLine);

  // Restore saved width / collapsed state, then apply.
  mdOutlineW = Number(localStorage.getItem(OUTLINE_W_KEY)) || 240;
  setOutlineCollapsed(localStorage.getItem(OUTLINE_COLLAPSED_KEY) === '1', true);

  renderInto(raw);

  const { toolbar } = createToolbar('MD', currentFilename, raw, {
    onRaw: (isRaw) => {
      if (mdRoot) mdRoot.style.display = isRaw ? 'none' : '';
      if (rawDiv) rawDiv.style.display = isRaw ? '' : 'none';
      if (outlineWrapEl) outlineWrapEl.style.display = isRaw ? 'none' : '';
    },
    onCopy: () => { copyText(currentRaw); },
  });

  addOpenButton(toolbar);
  addHistoryButton(toolbar);

  document.body.prepend(toolbar);
  document.body.appendChild(content);

  void recordHistory(location.href, currentFilename);
}

// Re-render the markdown body without rebuilding the toolbar (used by Open and
// History). NOTE: must not call setupPage — it clears document.body.
function loadContent(raw: string, filename: string): void {
  currentRaw = raw;
  currentFilename = filename;
  document.title = filename;
  renderInto(raw);
  const fn = document.querySelector('.fv-filename');
  if (fn) fn.textContent = filename;
  const meta = document.querySelector('.fv-meta');
  if (meta) meta.textContent = metaText(raw);
  // Opening a new file shows the rendered view, not raw.
  if (mdRoot) mdRoot.style.display = '';
  if (rawDiv) rawDiv.style.display = 'none';
}

function renderInto(raw: string): void {
  if (!mdRoot || !rawDiv) return;
  mdRoot.innerHTML = mdToHtml(raw);
  // Make internal links work
  mdRoot.querySelectorAll('a[href^="#"]').forEach((a) => {
    (a as HTMLAnchorElement).addEventListener('click', (e) => {
      e.preventDefault();
      const id = (a as HTMLAnchorElement).hash.slice(1);
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    });
  });
  rawDiv.textContent = raw;
  buildOutline();
}

// Build the outline (table of contents) from the rendered headings. Clicking
// an entry smooth-scrolls to that heading.
function buildOutline(): void {
  if (!outlineWrapEl || !mdRoot) return;
  const outline = outlineWrapEl.querySelector<HTMLElement>('.fv-md-outline');
  if (!outline) return;
  outline.innerHTML = '';
  const heads = mdRoot.querySelectorAll('h1, h2, h3, h4, h5, h6');
  let n = 0;
  heads.forEach((h) => {
    const level = parseInt(h.tagName[1], 10);
    if (!h.id) h.id = 'md-sec-' + n;
    n++;
    const a = document.createElement('a');
    a.className = 'fv-md-outline-item h' + level;
    a.textContent = h.textContent || '';
    a.href = '#' + h.id;
    a.title = h.textContent || '';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    outline.appendChild(a);
  });
}

function metaText(raw: string): string {
  const bytes = new Blob([raw]).size;
  const size = bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KB' : bytes + ' B';
  const lines = raw.length === 0 ? 0 : raw.split('\n').length;
  return size + ' · ' + lines + ' ' + t('行', 'lines');
}

function prependRight(toolbar: HTMLElement, el: HTMLElement): void {
  const right = toolbar.querySelector('.fv-toolbar-right');
  if (right) right.insertBefore(el, right.firstChild);
  else toolbar.appendChild(el);
}

// ── Open file (file picker) ───────────────────────────────────
const OPEN_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M8 9.5V6M6.5 7.5L8 6l1.5 1.5"/></svg>';

function addOpenButton(toolbar: HTMLElement): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.md,.markdown,text/markdown,text/plain';
  // Off-screen (not display:none) so .click() reliably opens the dialog.
  input.style.cssText = 'position:absolute;left:-9999px;top:0;opacity:0;';
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const text = String(r.result);
      loadContent(text, f.name);
      // Picker files have no path (browser limitation); keep a content
      // snapshot so the history entry can be reopened.
      void recordHistory(null, f.name, text);
    };
    r.readAsText(f);
    input.value = ''; // allow reopening the same file
  });
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fv-btn';
  btn.innerHTML = OPEN_ICON + '<span style="font-size:12px">' + t('打开', 'Open') + '</span>';
  btn.addEventListener('click', () => input.click());
  prependRight(toolbar, btn);
}

// ── History dropdown (recently viewed files, by URL) ──────────
const HISTORY_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><polyline points="8 4.5 8 8 10.5 9.5"/></svg>';
const MD_HISTORY_KEY = 'fv_md_history';
const MD_HISTORY_MAX = 20;
interface MdHistItem { url: string; name: string; ts: number; content?: string; }

function addHistoryButton(toolbar: HTMLElement): void {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fv-btn';
  btn.innerHTML = HISTORY_ICON + '<span style="font-size:12px">' + t('历史', 'History') + '</span>';
  const drop = document.createElement('div');
  drop.className = 'fv-memo-export-drop fv-md-hist-drop';
  drop.style.display = 'none';
  drop.style.minWidth = '220px';

  async function renderDrop(): Promise<void> {
    const list = await loadHistory();
    drop.innerHTML = '';
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'fv-memo-export-item';
      empty.style.color = 'var(--fv-text-muted)';
      empty.style.cursor = 'default';
      empty.textContent = t('暂无历史', 'No history yet');
      drop.appendChild(empty);
      return;
    }
    for (const h of list) {
      const row = document.createElement('div');
      row.className = 'fv-md-hist-item';
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'fv-md-hist-name';
      name.textContent = h.name;
      name.title = h.url || t('通过「打开」按钮加载', 'Loaded via Open');
      name.addEventListener('click', (ev) => {
        ev.stopPropagation();
        drop.style.display = 'none';
        openHistory(h);
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'fv-md-hist-del';
      del.setAttribute('aria-label', t('删除', 'Delete'));
      del.title = t('从历史删除', 'Remove from history');
      del.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await removeFromHistory(h);
        await renderDrop(); // refresh the open dropdown, no confirm prompt
      });
      row.append(name, del);
      drop.appendChild(row);
    }
  }

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (drop.style.display === 'none') {
      await renderDrop();
      drop.style.display = '';
      drop.classList.remove('fv-overlay-in');
      void drop.offsetWidth;
      drop.classList.add('fv-overlay-in');
    } else {
      drop.style.display = 'none';
    }
  });

  wrap.append(btn, drop);
  prependRight(toolbar, wrap);
  document.addEventListener('click', (e) => {
    if (drop.style.display === 'none') return;
    if (wrap.contains(e.target as Node)) return;
    drop.style.display = 'none';
  });
}

// Apply the current pane width + collapsed state to the DOM. Width goes to the
// pane, the drag handle, and the content's left padding in lockstep.
function applyOutlineWidth(includeContent = true): void {
  const w = mdOutlineCollapsed ? OUTLINE_RAIL : mdOutlineW;
  if (outlineWrapEl) outlineWrapEl.style.width = w + 'px';
  if (dragLineEl) {
    dragLineEl.style.left = w + 'px';
    dragLineEl.style.display = mdOutlineCollapsed ? 'none' : '';
  }
  // content padding-left forces a costly reflow of the rendered document, so
  // during a drag we skip it (includeContent=false) and only align on release.
  if (includeContent && contentEl) contentEl.style.paddingLeft = w + 'px';
}

function setOutlineCollapsed(collapsed: boolean, skipSave = false): void {
  mdOutlineCollapsed = collapsed;
  outlineWrapEl?.classList.toggle('collapsed', collapsed);
  applyOutlineWidth();
  const btn = outlineWrapEl?.querySelector<HTMLButtonElement>('.fv-md-outline-toggle');
  if (btn) btn.dataset.tip = collapsed ? t('展开大纲', 'Expand outline') : t('收起大纲', 'Collapse outline');
  if (!skipSave) localStorage.setItem(OUTLINE_COLLAPSED_KEY, collapsed ? '1' : '0');
}

// Drag the divider to resize the pane (only meaningful when expanded).
function startOutlineResize(e: MouseEvent): void {
  e.preventDefault();
  document.body.classList.add('md-resizing');
  // rAF-throttle: mousemove fires faster than 60fps, but each applyOutlineWidth
  // reflows the (potentially long) document — coalescing to one apply per frame
  // keeps the drag smooth.
  let nextW = mdOutlineW;
  let frame = 0;
  const onMove = (ev: MouseEvent): void => {
    nextW = Math.max(OUTLINE_MIN, Math.min(OUTLINE_MAX, ev.clientX));
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; mdOutlineW = nextW; applyOutlineWidth(false); });
  };
  const onUp = (): void => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.classList.remove('md-resizing');
    if (frame) cancelAnimationFrame(frame);
    mdOutlineW = nextW;
    applyOutlineWidth();
    localStorage.setItem(OUTLINE_W_KEY, String(mdOutlineW));
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Open a history entry. file:// or http(s):// URLs navigate (≈ typing the
// path into the address bar + Enter); the content script renders on arrival
// and re-records history. Picker-loaded files kept a content snapshot (the
// browser exposes no path), so reopen from that.
function openHistory(h: MdHistItem): void {
  if (h.url) { location.href = h.url; return; }
  if (h.content != null) { loadContent(h.content, h.name); return; }
  alert(t('该文档无法重新打开。', 'This document cannot be reopened.'));
}

// Record a viewed document. `url` is null for picker-loaded files (the browser
// exposes no path); for those we keep a content snapshot so history can reopen
// them. Dedupe key = url, or 'local:'+name when there's no url.
async function recordHistory(url: string | null, name: string, content?: string): Promise<void> {
  const key = url || ('local:' + name);
  const list = await loadHistory();
  const filtered = list.filter((h) => (h.url || ('local:' + h.name)) !== key);
  filtered.unshift({ url: url ?? '', name, ts: Date.now(), content: url ? undefined : content });
  await chrome.storage.local.set({ [MD_HISTORY_KEY]: filtered.slice(0, MD_HISTORY_MAX) });
}

async function loadHistory(): Promise<MdHistItem[]> {
  const data = await chrome.storage.local.get(MD_HISTORY_KEY);
  const list = data[MD_HISTORY_KEY];
  return Array.isArray(list) ? list as MdHistItem[] : [];
}

async function removeFromHistory(item: MdHistItem): Promise<void> {
  const list = await loadHistory();
  const key = item.url || ('local:' + item.name);
  const filtered = list.filter((h) => (h.url || ('local:' + h.name)) !== key);
  await chrome.storage.local.set({ [MD_HISTORY_KEY]: filtered });
}

// ── Basic Markdown → HTML converter ──────────────────────────

export function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];

  // Inject a data-line attribute (the 0-based source line index) into the
  // first opening tag of an HTML chunk. Used for scroll-sync mapping.
  const withLine = (html: string, line: number): string =>
    html.replace(/^<(\w+)/, `<$1 data-line="${line}"`);

  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const startLine = i;

    // Fenced code block
    const fenceMatch = line.match(/^(`{3,}|~{3,})([\w-]*)/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang  = fenceMatch[2];
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // closing fence
      out.push(withLine(`<pre><code class="language-${escHtml(lang)}">${escHtml(codeLines.join('\n'))}</code></pre>`, startLine));
      continue;
    }

    // Headings
    const hMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (hMatch) {
      const level = hMatch[1].length;
      const text  = inline(hMatch[2]);
      const slug  = hMatch[2].toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
      out.push(withLine(`<h${level} id="${slug}">${text}</h${level}>`, startLine));
      i++; continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      out.push(withLine('<hr>', startLine));
      i++; continue;
    }

    // Blockquote
    if (line.startsWith('> ') || line === '>') {
      const bqLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
        bqLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      // Recurse, then shift inner data-line values by the blockquote's source
      // offset so they reference the original line numbers.
      const inner = mdToHtml(bqLines.join('\n'));
      const shifted = inner.replace(/data-line="(\d+)"/g, (_m, n: string) =>
        `data-line="${startLine + parseInt(n, 10)}"`);
      out.push(withLine(`<blockquote>${shifted}</blockquote>`, startLine));
      continue;
    }

    // Ordered / unordered list
    if (/^(\s*)([-*+]|\d+\.)\s/.test(line)) {
      const { html, nextIndex } = parseList(lines, i);
      out.push(withLine(html, startLine));
      i = nextIndex;
      continue;
    }

    // Table
    if (line.includes('|')) {
      const tableResult = parseTable(lines, i);
      if (tableResult) {
        out.push(withLine(tableResult.html, startLine));
        i = tableResult.nextIndex;
        continue;
      }
    }

    // Empty line → paragraph break
    if (line.trim() === '') {
      out.push(withLine('<p></p>', startLine));
      i++; continue;
    }

    // Paragraph
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].match(/^#{1,6}\s/) &&
           !lines[i].match(/^(`{3,}|~{3,})/) && !lines[i].match(/^(\s*)([-*+]|\d+\.)\s/) &&
           !lines[i].startsWith('> ')) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) out.push(withLine(`<p>${inline(paraLines.join('\n'))}</p>`, startLine));
  }

  return out.join('\n');
}

function parseList(lines: string[], start: number): { html: string; nextIndex: number } {
  const isOrdered = /^\s*\d+\./.test(lines[start]);
  const tag = isOrdered ? 'ol' : 'ul';
  const items: string[] = [];
  let i = start;

  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)/);
    if (!m) break;
    items.push(m[3]);
    i++;
    // Continuation lines (indented)
    while (i < lines.length && /^\s{2,}/.test(lines[i]) && !lines[i].match(/^(\s*)([-*+]|\d+\.)\s/)) {
      items[items.length - 1] += '\n' + lines[i].trim();
      i++;
    }
  }

  const html = `<${tag}>${items.map((t) => {
    // Handle task list items
    const task = t.match(/^\[([ x])\]\s+(.*)/i);
    if (task) {
      const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
      return `<li><input type="checkbox"${checked} disabled>${inline(task[2])}</li>`;
    }
    return `<li>${inline(t)}</li>`;
  }).join('')}</${tag}>`;

  return { html, nextIndex: i };
}

function parseTable(lines: string[], start: number): { html: string; nextIndex: number } | null {
  if (start + 1 >= lines.length) return null;
  const sep = lines[start + 1];
  if (!/^\s*\|?[\s|:-]+\|?\s*$/.test(sep)) return null;

  const headers = splitTableRow(lines[start]);
  if (!headers.length) return null;

  const aligns = sep.split('|').filter((c) => c.trim()).map((c) => {
    c = c.trim();
    if (c.startsWith(':') && c.endsWith(':')) return 'center';
    if (c.endsWith(':')) return 'right';
    return 'left';
  });

  let i = start + 2;
  const rows: string[][] = [];
  while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
    rows.push(splitTableRow(lines[i]));
    i++;
  }

  const ths = headers.map((h, ci) => `<th style="text-align:${aligns[ci] || 'left'}">${inline(h)}</th>`).join('');
  const trs = rows.map((r) =>
    `<tr>${r.map((c, ci) => `<td style="text-align:${aligns[ci] || 'left'}">${inline(c)}</td>`).join('')}</tr>`
  ).join('');

  return { html: `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`, nextIndex: i };
}

function splitTableRow(line: string): string[] {
  return line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

// ── Inline Markdown formatting ─────────────────────────────────

// Reject dangerous URL schemes (javascript:, data:, vbscript:, …) so they
// can't ride inside [text](url) or ![alt](src). Anything not on the allowlist
// (or not a relative/anchor link) collapses to '#'.
function safeUrl(url: string): string {
  const t = url.trim();
  if (/^(https?|mailto|ftp|tel):/i.test(t)) return t.replace(/"/g, '%22');
  if (/^[/#?]/.test(t) || t.startsWith('./') || t.startsWith('../')) return t.replace(/"/g, '%22');
  return '#';
}

function inline(text: string): string {
  // Stash inline-code spans first so their literal content is preserved and
  // their backticks don't get escaped or chewed by later patterns.
  const codes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(escHtml(c));
    return `\x00C${codes.length - 1}\x00`;
  });

  // Escape any remaining HTML so user-supplied <script>, on*-handlers, etc.
  // become inert before we inject our own tags.
  text = escHtml(text);

  text = text
    .replace(/\*{3}([^*]+)\*{3}/g, '<strong><em>$1</em></strong>')
    .replace(/_{3}([^_]+)_{3}/g, '<strong><em>$1</em></strong>')
    .replace(/\*{2}([^*]+)\*{2}/g, '<strong>$1</strong>')
    .replace(/_{2}([^_]+)_{2}/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) =>
      `<img src="${safeUrl(src)}" alt="${alt}">`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) =>
      `<a href="${safeUrl(href)}">${label}</a>`)
    // Auto-link bare URLs, but not ones that are already inside an attribute
    // (preceded by `="` or `=`) from the previous link/image replacements.
    .replace(/(?<![="])https?:\/\/[^\s<]+/g, (u) => `<a href="${safeUrl(u)}">${u}</a>`)
    .replace(/  \n/g, '<br>');

  return text.replace(/\x00C(\d+)\x00/g, (_, i) => `<code>${codes[+i]}</code>`);
}

