// Content script — no top-level import/export (classic script context).
// Uses dynamic import() to lazily load the correct renderer. We can't share
// helpers with src/ui/common.ts here because content scripts are not modules.

type FileFormat = 'json' | 'markdown' | 'sql' | 'yaml' | 'csv' | 'log';

function getRawContent(): string {
  // Chrome wraps raw text/JSON responses in <pre>
  const pre = document.querySelector('pre');
  if (pre) return pre.textContent ?? '';
  return document.body?.textContent ?? '';
}

function detectFormat(): FileFormat | null {
  const { pathname } = location;
  const lower = pathname.toLowerCase();
  const contentType: string = (document as Document & { contentType?: string }).contentType ?? '';

  // 1. Content-Type
  if (/application\/json|text\/json/.test(contentType)) return 'json';
  if (/application\/(x-)?yaml|text\/(x-)?yaml/.test(contentType)) return 'yaml';
  if (/text\/csv/.test(contentType)) return 'csv';
  if (/text\/(x-)?markdown/.test(contentType)) return 'markdown';

  // 2. URL file extension
  const ext = lower.split('?')[0].split('.').pop() ?? '';
  const extMap: Record<string, FileFormat> = {
    json: 'json', jsonp: 'json',
    md: 'markdown', markdown: 'markdown',
    sql: 'sql',
    yaml: 'yaml', yml: 'yaml',
    csv: 'csv', tsv: 'csv',
    log: 'log', txt: 'log',
  };
  if (ext in extMap) return extMap[ext];

  // 3. Content sniffing (only for text/plain or unknown content types)
  const isPlainText = contentType === '' || /text\/plain/.test(contentType);
  if (!isPlainText) return null;

  const sample = getRawContent().trimStart().slice(0, 300);
  if (!sample) return null;

  // JSON: starts with { or [, and actually parses
  if (sample[0] === '{' || sample[0] === '[') {
    try {
      JSON.parse(getRawContent());
      return 'json';
    } catch { /* not JSON */ }
  }

  // YAML front-matter or typical key: value structure
  if (/^---\r?\n/.test(sample)) return 'yaml';
  if (/^[\w\-. ]+:\s+\S/.test(sample) && sample.split('\n').slice(0, 5).filter((l) => /^\w[\w\-.]*:\s/.test(l)).length >= 2) return 'yaml';

  // Markdown: heading, bold, or list at start
  if (/^#{1,6}\s/.test(sample) || /^\*{1,2}\S/.test(sample) || /^- /.test(sample)) return 'markdown';

  return null;
}

function injectStyles(): Promise<void> {
  let link = document.getElementById('fv-base-styles') as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = chrome.runtime.getURL('styles/base.css');
    link.id   = 'fv-base-styles';
    (document.head ?? document.documentElement).appendChild(link);
  }
  return new Promise((resolve) => {
    if (link!.sheet) { resolve(); return; }
    link!.addEventListener('load',  () => resolve(), { once: true });
    link!.addEventListener('error', () => resolve(), { once: true });
  });
}

(async () => {
  try {
    if (location.protocol === 'chrome-extension:' || location.protocol === 'devtools:') return;
    if (!document.body) return;

    const format = detectFormat();
    if (!format) return;

    // Honor the popup's per-format disable toggle.
    const { disabledFormats } = await chrome.storage.local.get('disabledFormats');
    if (Array.isArray(disabledFormats) && disabledFormats.includes(format)) return;

    const raw = getRawContent();
    if (!raw.trim()) return;

    await injectStyles();

    const rendererUrl = chrome.runtime.getURL(`dist/renderers/${format}.js`);
    const renderer = await import(rendererUrl) as { render: (raw: string) => void };
    renderer.render(raw);

    // Smart selection (double-click token expand + whole-token match highlight).
    // Runs in this isolated world: it shares the page DOM/Selection and uses
    // <mark> wrapping for highlights (the isolated world can't render CSS Custom
    // Highlights). A nicety — never block rendering.
    try {
      const mod = await import(chrome.runtime.getURL('dist/ui/selection.js')) as {
        enableSmartSelection: () => void;
      };
      mod.enableSmartSelection();
    } catch { /* ignore */ }
  } catch (err) {
    console.warn('[Plain View]', err);
  }
})();
