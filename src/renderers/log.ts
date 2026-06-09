import { createToolbar } from '../ui/toolbar';
import { setupPage, copyText } from '../ui/common';

type Level = 'error' | 'warn' | 'info' | 'debug' | 'trace' | '';

const LEVEL_RE = /\b(ERROR|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE|VERBOSE)\b/i;

export function render(raw: string): void {
  const filename = location.pathname.split('/').pop() || 'file.log';
  setupPage(filename);

  const lines = raw.split(/\r?\n/);

  const content = document.createElement('div');
  content.className = 'fv-content';
  content.id = 'fv-content';

  const logRoot = document.createElement('div');
  logRoot.className = 'fv-log-root';

  lines.forEach((text, i) => {
    const lineEl = buildLine(text, i + 1);
    logRoot.appendChild(lineEl);
  });

  content.appendChild(logRoot);

  const rawDiv = document.createElement('div');
  rawDiv.className = 'fv-raw-view';
  rawDiv.style.display = 'none';
  rawDiv.textContent = raw;
  content.appendChild(rawDiv);

  const { toolbar } = createToolbar('LOG', filename, raw, {
    onRaw: (isRaw) => {
      logRoot.style.display = isRaw ? 'none' : '';
      rawDiv.style.display = isRaw ? '' : 'none';
    },
    onCopy: () => { copyText(raw); },
  });

  document.body.prepend(toolbar);
  document.body.appendChild(content);
}

export function buildLine(text: string, lineNum: number): HTMLElement {
  const level = detectLevel(text);

  const line = document.createElement('div');
  line.className = `fv-log-line${level ? ` level-${level}` : ''}`;

  const numEl = document.createElement('span');
  numEl.className = 'fv-line-num';
  numEl.textContent = String(lineNum);

  const badge = document.createElement('span');
  badge.className = 'fv-log-level-badge';
  badge.textContent = level ? level.toUpperCase() : '';

  const textEl = document.createElement('span');
  textEl.className = 'fv-log-text';
  textEl.textContent = text;

  line.append(numEl, badge, textEl);
  return line;
}

function detectLevel(text: string): Level {
  const m = text.match(LEVEL_RE);
  if (!m) return '';
  const w = m[1].toUpperCase();
  if (w === 'ERROR' || w === 'FATAL') return 'error';
  if (w === 'WARN' || w === 'WARNING') return 'warn';
  if (w === 'INFO') return 'info';
  if (w === 'DEBUG') return 'debug';
  if (w === 'TRACE' || w === 'VERBOSE') return 'trace';
  return '';
}

