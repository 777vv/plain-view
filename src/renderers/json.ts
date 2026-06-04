import { createToolbar } from '../ui/toolbar';
import { setupPage, copyText } from '../ui/common';

export function render(raw: string): void {
  let data: unknown;
  try {
    data = JSON.parse(stripJsonp(raw));
  } catch {
    return;
  }

  const filename = location.pathname.split('/').pop() || location.hostname;
  setupPage(filename + ' — JSON');

  const pretty = JSON.stringify(data, null, 2);

  const content = document.createElement('div');
  content.className = 'fv-content';
  content.id = 'fv-content';

  const treeWrap = document.createElement('div');
  treeWrap.appendChild(buildNode(data, null, true, 0));
  content.appendChild(treeWrap);

  const rawDiv = document.createElement('div');
  rawDiv.className = 'fv-raw-view';
  rawDiv.style.display = 'none';
  rawDiv.textContent = pretty;
  content.appendChild(rawDiv);

  const { toolbar } = createToolbar('JSON', filename, raw, {
    onRaw: (isRaw) => {
      treeWrap.style.display = isRaw ? 'none' : '';
      rawDiv.style.display = isRaw ? '' : 'none';
    },
    onCopy: () => { copyText(pretty); },
  });

  document.body.prepend(toolbar);
  document.body.appendChild(content);
}

// Strip a JSONP wrapper like `callback({...});` → `{...}`. Only strips when
// both the leading `name(` and trailing `)` (optionally followed by `;`) are
// found, so plain JSON is left untouched.
function stripJsonp(raw: string): string {
  const t = raw.trim();
  const m = t.match(/^[\w.$]+\s*\(([\s\S]*)\)\s*;?\s*$/);
  return m ? m[1] : t;
}

// ── Tree builder ──────────────────────────────────────────────

function buildNode(value: unknown, key: string | null, isLast: boolean, depth: number): HTMLElement {
  if (Array.isArray(value))
    return buildCollection(value, key, isLast, depth, true);
  if (value !== null && typeof value === 'object')
    return buildCollection(value as Record<string, unknown>, key, isLast, depth, false);
  return buildPrimitive(value, key, isLast);
}

function buildPrimitive(value: unknown, key: string | null, isLast: boolean): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'fv-node';

  const row = document.createElement('div');
  row.className = 'fv-node-row';

  // Empty space in place of toggle arrow — keeps alignment
  const spacer = span('fv-toggle-spacer', '');
  row.appendChild(spacer);

  if (key !== null) {
    row.appendChild(span('fv-key', `"${key}"`));
    row.appendChild(span('fv-colon', ': '));
  }

  if (typeof value === 'string') {
    const str = `"${escapeStr(value)}"`;
    if (/^https?:\/\//.test(value)) {
      const a = document.createElement('a');
      a.className = 'fv-string fv-url-link';
      a.href = value;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = str;
      row.appendChild(a);
    } else {
      row.appendChild(span('fv-string', str));
    }
  } else if (typeof value === 'number') {
    row.appendChild(span('fv-number', String(value)));
  } else if (typeof value === 'boolean') {
    row.appendChild(span('fv-boolean', String(value)));
  } else {
    row.appendChild(span('fv-null', 'null'));
  }

  if (!isLast) row.appendChild(span('fv-comma', ','));
  wrapper.appendChild(row);
  return wrapper;
}

function buildCollection(
  value: unknown[] | Record<string, unknown>,
  key: string | null,
  isLast: boolean,
  depth: number,
  isArray: boolean,
): HTMLElement {
  const entries: [string | null, unknown][] = isArray
    ? (value as unknown[]).map((v) => [null, v])
    : Object.entries(value as Record<string, unknown>);

  const count = entries.length;
  const open  = isArray ? '[' : '{';
  const close = isArray ? ']' : '}';

  const node = document.createElement('div');
  node.className = 'fv-node';

  // ── Header row ─────────────────────────────────────────────
  const headerRow = document.createElement('div');
  headerRow.className = 'fv-node-row';

  if (count > 0) {
    // Arrow — ONLY this element triggers collapse/expand
    const toggle = span('fv-toggle fv-toggle-btn', '▼');
    toggle.title = 'Click to collapse/expand';
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const collapsed = node.classList.toggle('fv-collapsed');
      toggle.textContent = collapsed ? '▶' : '▼';
    });
    headerRow.appendChild(toggle);
  } else {
    headerRow.appendChild(span('fv-toggle-spacer', ''));
  }

  if (key !== null) {
    // Key is plain text — no click handler
    headerRow.appendChild(span('fv-key', `"${key}"`));
    headerRow.appendChild(span('fv-colon', ': '));
  }

  headerRow.appendChild(span('fv-bracket', open));

  if (count === 0) {
    headerRow.appendChild(span('fv-bracket', close));
    if (!isLast) headerRow.appendChild(span('fv-comma', ','));
    node.appendChild(headerRow);
    return node;
  }

  // Count badge
  const label = isArray
    ? `${count} item${count !== 1 ? 's' : ''}`
    : `${count} key${count !== 1 ? 's' : ''}`;
  headerRow.appendChild(span('fv-length', ` ${label} `));

  // Collapsed hint (shown only when collapsed)
  headerRow.appendChild(span('fv-collapsed-hint', `…${close}${isLast ? '' : ','}`));

  node.appendChild(headerRow);

  // ── Children ───────────────────────────────────────────────
  const children = document.createElement('div');
  children.className = 'fv-node-children';

  entries.forEach(([k, v], i) => {
    children.appendChild(buildNode(v, k, i === entries.length - 1, depth + 1));
  });

  node.appendChild(children);

  // ── Closing row ────────────────────────────────────────────
  const closeRow = document.createElement('div');
  closeRow.className = 'fv-node-close fv-node-row';
  closeRow.appendChild(span('fv-toggle-spacer', ''));
  closeRow.appendChild(span('fv-bracket', close));
  if (!isLast) closeRow.appendChild(span('fv-comma', ','));
  node.appendChild(closeRow);

  return node;
}

// ── Helpers ───────────────────────────────────────────────────

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

function escapeStr(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

