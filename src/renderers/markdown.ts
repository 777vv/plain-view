import { createToolbar } from '../ui/toolbar';
import { setupPage, escHtml, copyText } from '../ui/common';

export function render(raw: string): void {
  const filename = location.pathname.split('/').pop() || 'README.md';
  setupPage(filename);

  const content = document.createElement('div');
  content.className = 'fv-content';
  content.id = 'fv-content';

  const mdRoot = document.createElement('div');
  mdRoot.className = 'fv-md-root';
  mdRoot.innerHTML = mdToHtml(raw);
  // Make internal links work
  mdRoot.querySelectorAll('a[href^="#"]').forEach((a) => {
    (a as HTMLAnchorElement).addEventListener('click', (e) => {
      e.preventDefault();
      const id = (a as HTMLAnchorElement).hash.slice(1);
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    });
  });
  content.appendChild(mdRoot);

  const rawDiv = document.createElement('div');
  rawDiv.className = 'fv-raw-view';
  rawDiv.style.display = 'none';
  rawDiv.textContent = raw;
  content.appendChild(rawDiv);

  const { toolbar } = createToolbar('MD', filename, raw, {
    onRaw: (isRaw) => {
      mdRoot.style.display = isRaw ? 'none' : '';
      rawDiv.style.display = isRaw ? '' : 'none';
    },
    onCopy: () => { copyText(raw); },
  });

  document.body.prepend(toolbar);
  document.body.appendChild(content);
}

// ── Basic Markdown → HTML converter ──────────────────────────

export function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

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
      out.push(`<pre><code class="language-${escHtml(lang)}">${escHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    // Headings
    const hMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (hMatch) {
      const level = hMatch[1].length;
      const text  = inline(hMatch[2]);
      const slug  = hMatch[2].toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
      out.push(`<h${level} id="${slug}">${text}</h${level}>`);
      i++; continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      out.push('<hr>');
      i++; continue;
    }

    // Blockquote
    if (line.startsWith('> ') || line === '>') {
      const bqLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
        bqLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${mdToHtml(bqLines.join('\n'))}</blockquote>`);
      continue;
    }

    // Ordered / unordered list
    if (/^(\s*)([-*+]|\d+\.)\s/.test(line)) {
      const { html, nextIndex } = parseList(lines, i);
      out.push(html);
      i = nextIndex;
      continue;
    }

    // Table
    if (line.includes('|')) {
      const tableResult = parseTable(lines, i);
      if (tableResult) {
        out.push(tableResult.html);
        i = tableResult.nextIndex;
        continue;
      }
    }

    // Empty line → paragraph break
    if (line.trim() === '') {
      out.push('<p></p>');
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
    if (paraLines.length) out.push(`<p>${inline(paraLines.join('\n'))}</p>`);
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

