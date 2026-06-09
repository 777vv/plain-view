import { createToolbar } from '../ui/toolbar';
import { setupPage, copyText } from '../ui/common';

export function render(raw: string, srcPath?: string): void {
  const path = srcPath ?? location.pathname;
  const isTsv = path.toLowerCase().endsWith('.tsv');
  const delimiter = isTsv ? '\t' : detectDelimiter(raw);
  const rows = parseCSV(raw, delimiter);
  if (rows.length === 0) return;

  const filename = path.split('/').pop() || 'file.csv';

  setupPage(filename);

  const content = document.createElement('div');
  content.className = 'fv-content';
  content.id = 'fv-content';

  const wrap = document.createElement('div');
  wrap.className = 'fv-csv-wrap';

  const table = buildTable(rows);
  wrap.appendChild(table);
  content.appendChild(wrap);

  const rawDiv = document.createElement('div');
  rawDiv.className = 'fv-raw-view';
  rawDiv.style.display = 'none';
  rawDiv.textContent = raw;
  content.appendChild(rawDiv);

  const { toolbar } = createToolbar(isTsv ? 'TSV' : 'CSV', filename, raw, {
    onRaw: (isRaw) => {
      wrap.style.display = isRaw ? 'none' : '';
      rawDiv.style.display = isRaw ? '' : 'none';
    },
    onCopy: () => { copyText(serializeTable(table, delimiter)); },
  });

  document.body.prepend(toolbar);
  document.body.appendChild(content);
}

export function buildTable(rows: string[][]): HTMLTableElement {
  const [header, ...body] = rows;
  const table = document.createElement('table');
  table.className = 'fv-csv-table';

  // Header
  const thead = table.createTHead();
  const trh = thead.insertRow();
  const thNum = document.createElement('th');
  thNum.textContent = '#';
  thNum.className = 'fv-row-num';
  trh.appendChild(thNum);

  const sortState: { col: number; asc: boolean } = { col: -1, asc: true };

  header.forEach((cell, ci) => {
    const th = document.createElement('th');
    th.textContent = cell;
    th.addEventListener('click', () => {
      const wasAsc = sortState.col === ci && sortState.asc;
      sortState.col = ci;
      sortState.asc = !wasAsc;

      table.querySelectorAll('th').forEach((h) => h.classList.remove('sort-asc', 'sort-desc'));
      th.classList.add(sortState.asc ? 'sort-asc' : 'sort-desc');

      const tbodyRows = Array.from(tbody.rows);
      tbodyRows.sort((a, b) => {
        const av = a.cells[ci + 1]?.textContent || '';
        const bv = b.cells[ci + 1]?.textContent || '';
        const diff = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
        return sortState.asc ? diff : -diff;
      });
      tbodyRows.forEach((r) => tbody.appendChild(r));
      // Re-number
      renumber(tbody);
    });
    trh.appendChild(th);
  });

  // Body
  const tbody = table.createTBody();
  body.forEach((row, ri) => {
    const tr = tbody.insertRow();
    const tdNum = tr.insertCell();
    tdNum.className = 'fv-row-num';
    tdNum.textContent = String(ri + 1);
    row.forEach((cell) => {
      const td = tr.insertCell();
      td.textContent = cell;
      makeEditable(td);
    });
  });

  return table;
}

// Double-click a cell to edit it; Enter or clicking away commits the value.
// A changed (still-unsaved) cell is marked with the fv-csv-dirty class.
function makeEditable(td: HTMLTableCellElement): void {
  td.addEventListener('dblclick', () => {
    if (td.firstElementChild) return; // already editing
    const original = td.textContent ?? '';
    const input = document.createElement('input');
    input.className = 'fv-csv-edit';
    input.value = original;
    td.textContent = '';
    td.appendChild(input);
    input.focus();
    input.select();

    const commit = (): void => {
      td.textContent = input.value;
      if (input.value !== original) td.classList.add('fv-csv-dirty');
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    });
  });
}

function renumber(tbody: HTMLTableSectionElement): void {
  Array.from(tbody.rows).forEach((r, i) => {
    const first = r.cells[0];
    if (first?.classList.contains('fv-row-num')) first.textContent = String(i + 1);
  });
}

// Serialize the current (possibly edited) table back to CSV/TSV text.
function serializeTable(table: HTMLTableElement, delimiter: string): string {
  const esc = (v: string): string =>
    /["\r\n]/.test(v) || v.includes(delimiter)
      ? '"' + v.replace(/"/g, '""') + '"'
      : v;

  // Prefer the input's current value if a cell is mid-edit (the dblclick
  // input hasn't been blurred yet), otherwise read textContent.
  const cellValue = (c: HTMLTableCellElement): string => {
    const input = c.querySelector('input');
    return input ? input.value : (c.textContent ?? '');
  };

  // slice(1) drops the leading row-number cell
  const rowToLine = (cells: HTMLTableCellElement[]): string =>
    cells.slice(1).map((c) => esc(cellValue(c))).join(delimiter);

  const lines: string[] = [];
  const head = table.tHead?.rows[0];
  if (head) lines.push(rowToLine(Array.from(head.cells)));
  for (const tr of Array.from(table.tBodies[0]?.rows ?? [])) {
    lines.push(rowToLine(Array.from(tr.cells)));
  }
  return lines.join('\n');
}

// ── CSV parser ────────────────────────────────────────────────

export function detectDelimiter(raw: string): string {
  const first = raw.slice(0, 2000);
  const commas = (first.match(/,/g) || []).length;
  const semis  = (first.match(/;/g) || []).length;
  const pipes  = (first.match(/\|/g) || []).length;
  const tabs   = (first.match(/\t/g) || []).length;
  return [
    [',', commas], [';', semis], ['|', pipes], ['\t', tabs],
  ].sort((a, b) => (b[1] as number) - (a[1] as number))[0][0] as string;
}

export function parseCSV(raw: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let row: string[] = [];
  let cell = '';
  let inQuote = false;

  for (let i = 0; i < lines.length; i++) {
    const ch = lines[i];
    if (inQuote) {
      if (ch === '"') {
        if (lines[i + 1] === '"') { cell += '"'; i++; }
        else inQuote = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === delimiter) {
      row.push(cell); cell = '';
    } else if (ch === '\n') {
      row.push(cell); cell = '';
      rows.push(row);          // preserve intentionally-blank rows
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  // Skip only the empty row produced by a trailing newline (single empty cell)
  if (!(row.length === 1 && row[0] === '')) rows.push(row);

  // Normalize row lengths
  const maxLen = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return rows.map((r) => { while (r.length < maxLen) r.push(''); return r; });
}

