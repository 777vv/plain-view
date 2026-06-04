import { createToolbar } from '../ui/toolbar';
import { setupPage, escHtml, copyText } from '../ui/common';

export function render(raw: string): void {
  const filename = location.pathname.split('/').pop() || 'file.yaml';
  setupPage(filename);

  const content = document.createElement('div');
  content.className = 'fv-content';
  content.id = 'fv-content';

  const yamlRoot = document.createElement('pre');
  yamlRoot.className = 'fv-yaml-root';
  yamlRoot.innerHTML = highlight(raw);
  content.appendChild(yamlRoot);

  const rawDiv = document.createElement('div');
  rawDiv.className = 'fv-raw-view';
  rawDiv.style.display = 'none';
  rawDiv.textContent = raw;
  content.appendChild(rawDiv);

  const { toolbar, searchBar } = createToolbar('YAML', filename, raw, {
    onRaw: (isRaw) => {
      yamlRoot.style.display = isRaw ? 'none' : '';
      rawDiv.style.display = isRaw ? '' : 'none';
    },
    onCopy: () => { copyText(raw); },
  });

  document.body.prepend(searchBar, toolbar);
  document.body.appendChild(content);
}

// ── Regex-based YAML highlighter ─────────────────────────────

function highlight(yaml: string): string {
  return yaml
    .split('\n')
    .map(highlightLine)
    .join('\n');
}

function highlightLine(line: string): string {
  // Comments
  if (/^\s*#/.test(line)) return `<span class="fv-yaml-comment">${escHtml(line)}</span>`;

  // Document separators
  if (/^---/.test(line) || /^\.\.\./.test(line)) return `<span class="fv-yaml-tag">${escHtml(line)}</span>`;

  // Key: value
  const kvMatch = line.match(/^(\s*)([\w\-. ]+)(\s*:\s*)(.*)?$/);
  if (kvMatch) {
    const [, indent, key, colon, value] = kvMatch;
    const indentHtml = escHtml(indent);
    const keyHtml    = `<span class="fv-yaml-key">${escHtml(key)}</span>`;
    const colonHtml  = escHtml(colon);
    const valueHtml  = value ? highlightValue(value) : '';
    return `${indentHtml}${keyHtml}${colonHtml}${valueHtml}`;
  }

  // List item
  const listMatch = line.match(/^(\s*-\s*)(.*)?$/);
  if (listMatch) {
    const [, bullet, value] = listMatch;
    return `${escHtml(bullet)}${value ? highlightValue(value) : ''}`;
  }

  // Anchors / aliases
  if (/&\w+|^\*\w+/.test(line)) {
    return line.replace(/(&\w+|\*\w+)/g, `<span class="fv-yaml-anchor">$1</span>`);
  }

  return escHtml(line);
}

function highlightValue(v: string): string {
  const t = v.trim();

  // Anchor / alias at start
  if (t.startsWith('&') || t.startsWith('*')) {
    return `<span class="fv-yaml-anchor">${escHtml(v)}</span>`;
  }
  // Quoted strings
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return `<span class="fv-yaml-string">${escHtml(v)}</span>`;
  }
  // Booleans
  if (/^(true|false|yes|no|on|off)$/i.test(t)) {
    return `<span class="fv-yaml-boolean">${escHtml(v)}</span>`;
  }
  // Null
  if (/^(null|~)$/i.test(t) || t === '') {
    return `<span class="fv-yaml-null">${t ? escHtml(v) : '~'}</span>`;
  }
  // Numbers
  if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) || /^0x[\da-fA-F]+$/.test(t)) {
    return `<span class="fv-yaml-number">${escHtml(v)}</span>`;
  }
  // Block indicators (| >) — keep as text
  if (t === '|' || t === '|+' || t === '|-' || t === '>' || t === '>+' || t === '>-') {
    return `<span class="fv-yaml-tag">${escHtml(v)}</span>`;
  }
  // Tags
  if (t.startsWith('!')) {
    return `<span class="fv-yaml-tag">${escHtml(v)}</span>`;
  }
  // Plain string
  return `<span class="fv-yaml-string">${escHtml(v)}</span>`;
}

