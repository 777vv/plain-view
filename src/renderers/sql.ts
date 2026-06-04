import { createToolbar } from '../ui/toolbar';
import { setupPage, escHtml, copyText } from '../ui/common';

// Core SQL keywords
const KEYWORDS = new Set([
  'SELECT','FROM','WHERE','AND','OR','NOT','IN','EXISTS','BETWEEN','LIKE','IS','NULL',
  'INSERT','INTO','VALUES','UPDATE','SET','DELETE','TRUNCATE',
  'CREATE','ALTER','DROP','TABLE','VIEW','INDEX','SEQUENCE','SCHEMA','DATABASE',
  'JOIN','LEFT','RIGHT','INNER','OUTER','FULL','CROSS','ON','USING',
  'GROUP','BY','ORDER','HAVING','LIMIT','OFFSET','FETCH','ROWS','ONLY',
  'UNION','INTERSECT','EXCEPT','ALL','DISTINCT',
  'CASE','WHEN','THEN','ELSE','END','IF',
  'BEGIN','COMMIT','ROLLBACK','TRANSACTION','SAVEPOINT',
  'PRIMARY','FOREIGN','KEY','REFERENCES','UNIQUE','CHECK','DEFAULT','CONSTRAINT',
  'AS','WITH','RECURSIVE',
  'GRANT','REVOKE','ON','TO','FROM','PUBLIC','ROLE',
]);

const FUNCTIONS = new Set([
  'COUNT','SUM','AVG','MIN','MAX','COALESCE','NULLIF','GREATEST','LEAST',
  'UPPER','LOWER','TRIM','LTRIM','RTRIM','SUBSTRING','SUBSTR','REPLACE','CONCAT',
  'LENGTH','CHAR_LENGTH','POSITION','INSTR','LOCATE',
  'NOW','CURRENT_DATE','CURRENT_TIME','CURRENT_TIMESTAMP','SYSDATE',
  'DATE','TIME','YEAR','MONTH','DAY','HOUR','MINUTE','SECOND',
  'CAST','CONVERT','TO_CHAR','TO_DATE','TO_NUMBER',
  'ROUND','FLOOR','CEIL','CEILING','ABS','MOD','POWER','SQRT',
  'ROW_NUMBER','RANK','DENSE_RANK','LAG','LEAD','FIRST_VALUE','LAST_VALUE','OVER','PARTITION',
  'JSON_VALUE','JSON_QUERY','JSON_OBJECT','JSON_ARRAY',
  'STRING_AGG','GROUP_CONCAT','LISTAGG',
  'ISNULL','IFNULL','NVL','DECODE',
]);

export function render(raw: string): void {
  const filename = location.pathname.split('/').pop() || 'query.sql';
  setupPage(filename);

  const formatted = formatSQL(raw);

  const content = document.createElement('div');
  content.className = 'fv-content';
  content.id = 'fv-content';

  const sqlRoot = document.createElement('pre');
  sqlRoot.className = 'fv-sql-root';
  sqlRoot.innerHTML = highlight(formatted);
  content.appendChild(sqlRoot);

  const rawDiv = document.createElement('div');
  rawDiv.className = 'fv-raw-view';
  rawDiv.style.display = 'none';
  rawDiv.textContent = raw;
  content.appendChild(rawDiv);

  const { toolbar, searchBar } = createToolbar('SQL', filename, raw, {
    onRaw: (isRaw) => {
      sqlRoot.style.display = isRaw ? 'none' : '';
      rawDiv.style.display = isRaw ? '' : 'none';
    },
    onCopy: () => { copyText(formatted); },
  });

  document.body.prepend(searchBar, toolbar);
  document.body.appendChild(content);
}

// ── SQL formatter ─────────────────────────────────────────────

// Clause keywords that start a new line at column 0 (only at depth 0)
const CLAUSE_BREAK = new Set([
  'SELECT','FROM','WHERE','HAVING','GROUP','ORDER',
  'LIMIT','OFFSET','UNION','INTERSECT','EXCEPT',
  'INSERT','UPDATE','DELETE','CREATE','ALTER','DROP',
  'VALUES','SET',
]);

// Condition continuations: new line with 2-space indent (only at depth 0)
const INDENT_BREAK = new Set(['AND', 'OR', 'ON']);

// JOIN prefix words that need to merge with the following JOIN keyword
const JOIN_MODIFIER = new Set(['LEFT','RIGHT','INNER','OUTER','FULL','CROSS']);

// After these keywords, content is indented and commas cause line breaks
const INDENT_CONTENT = new Set(['SELECT', 'SET']);

// Only these statements break a top-level paren list onto multiple lines
// (column definitions). Other parens — IN (…), VALUES (…), INSERT column
// lists — stay inline to avoid needlessly tall output.
const LIST_BREAK_CLAUSE = new Set(['CREATE']);

function formatSQL(sql: string): string {
  const tokens = tokenize(sql.replace(/\r\n/g, '\n').replace(/\t/g, '  '));
  const lines: string[] = [];
  let line = '';
  let depth = 0;          // paren nesting depth
  let listDepth = -1;     // depth where paren-list comma-formatting is active
  let currentClause = ''; // last top-level clause keyword (SELECT, FROM, SET, etc.)
  let joinMode = false;

  function flush(): void {
    const t = line.trimEnd();
    if (t.trim()) lines.push(t);
    line = '';
  }

  function append(v: string): void {
    line += (line === '' || line.endsWith(' ') ? '' : ' ') + v;
  }

  for (const tok of tokens) {
    const up = tok.value.toUpperCase();

    if (tok.type === 'keyword') {
      if (depth > 0) {
        // Inside parens: never break — keywords are column attrs, function args, etc.
        append(tok.value);
        joinMode = false;
      } else if (JOIN_MODIFIER.has(up)) {
        if (joinMode) { line += ' ' + tok.value; }
        else { flush(); line = tok.value; joinMode = true; }
      } else if (up === 'JOIN') {
        if (joinMode) { line += ' ' + tok.value; }
        else { flush(); line = tok.value; }
        joinMode = false;
      } else if (CLAUSE_BREAK.has(up)) {
        flush();
        if (INDENT_CONTENT.has(up)) {
          lines.push(tok.value); // keyword on its own line (SELECT / SET)
          line = '    ';         // first item gets 4-space indent
        } else {
          line = tok.value;
        }
        currentClause = up; joinMode = false;
      } else if (INDENT_BREAK.has(up)) {
        flush(); line = '  ' + tok.value; joinMode = false;
      } else {
        append(tok.value); joinMode = false;
      }

    } else if (tok.type === 'paren-open') {
      const isFunc = endsWithFunction(line);
      // Space before paren only for a top-level list paren (CREATE TABLE x (…),
      // INSERT INTO x (…), VALUES (…)). Function calls and nested parens get none.
      line += (isFunc || depth > 0) ? '(' : ' (';
      depth++;
      if (depth === 1 && !isFunc && LIST_BREAK_CLAUSE.has(currentClause)) {
        flush();       // push e.g. "CREATE TABLE name (" as its own line
        listDepth = 1;
        line = '    '; // indent for first list item
      }
      joinMode = false;

    } else if (tok.type === 'paren-close') {
      depth--;
      if (listDepth === 1 && depth === 0) {
        flush();       // push last list item
        line = ')';    // ) on its own line; trailing tokens (ENGINE=...) append to it
        listDepth = -1;
      } else {
        line += ')';
      }
      joinMode = false;

    } else if (tok.type === 'semicolon') {
      if (line.trim()) { lines.push(line.trimEnd() + ';'); }
      else if (lines.length > 0) { lines[lines.length - 1] += ';'; }
      lines.push('');
      line = ''; depth = 0; listDepth = -1; currentClause = ''; joinMode = false;

    } else {
      const v = tok.value;
      if (/^\s+$/.test(v)) {
        continue; // skip raw whitespace — preserve joinMode across spaces
      }
      if (v === ',') {
        if (listDepth === 1 && depth === 1) {
          // inside a paren list (CREATE TABLE cols, VALUES, etc.)
          line += ','; flush(); line = '    ';
        } else if (depth === 0 && INDENT_CONTENT.has(currentClause)) {
          // SELECT column list or SET assignments at top level
          line += ','; flush(); line = '    ';
        } else {
          line += ','; // GROUP BY a, b — keep on same line
        }
      } else if (v === '.' || line.trimEnd().endsWith('.') || line.trimEnd().endsWith('(')) {
        line += v; // no space after dot or open-paren
      } else {
        line += (line === '' || line.endsWith(' ') ? '' : ' ') + v;
      }
      joinMode = false;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join('\n');
}

function endsWithFunction(line: string): boolean {
  const last = line.trimEnd().split(/[\s,!<>=+\-*/%&|~@(]/).filter(Boolean).pop()?.toUpperCase() ?? '';
  return FUNCTIONS.has(last);
}

// ── Tokenizer ─────────────────────────────────────────────────

type TokenType = 'keyword' | 'function' | 'string' | 'number' | 'comment' |
                 'paren-open' | 'paren-close' | 'semicolon' | 'operator' | 'other';
interface Token { type: TokenType; value: string; }

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < sql.length) {
    // Block comment
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const v = end === -1 ? sql.slice(i) : sql.slice(i, end + 2);
      tokens.push({ type: 'comment', value: v });
      i += v.length; continue;
    }
    // Line comment
    if ((sql[i] === '-' && sql[i + 1] === '-') || (sql[i] === '#')) {
      const end = sql.indexOf('\n', i);
      const v = end === -1 ? sql.slice(i) : sql.slice(i, end + 1);
      tokens.push({ type: 'comment', value: v });
      i += v.length; continue;
    }
    // Strings
    if (sql[i] === "'" || sql[i] === '"' || sql[i] === '`') {
      const q = sql[i];
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === q) { j++; break; }
        j++;
      }
      tokens.push({ type: 'string', value: sql.slice(i, j) });
      i = j; continue;
    }
    // Numbers
    if (/\d/.test(sql[i]) || (sql[i] === '.' && /\d/.test(sql[i + 1] || ''))) {
      let j = i;
      while (j < sql.length && /[\d._]/.test(sql[j])) j++;
      tokens.push({ type: 'number', value: sql.slice(i, j) });
      i = j; continue;
    }
    // Identifiers / keywords
    if (/[a-zA-Z_]/.test(sql[i])) {
      let j = i;
      while (j < sql.length && /[\w$]/.test(sql[j])) j++;
      const word = sql.slice(i, j);
      const upper = word.toUpperCase();
      let type: TokenType = 'other';
      if (KEYWORDS.has(upper))  type = 'keyword';
      if (FUNCTIONS.has(upper)) type = 'function';
      tokens.push({ type, value: word });
      i = j; continue;
    }
    // Parens
    if (sql[i] === '(') { tokens.push({ type: 'paren-open',  value: '(' }); i++; continue; }
    if (sql[i] === ')') { tokens.push({ type: 'paren-close', value: ')' }); i++; continue; }
    if (sql[i] === ';') { tokens.push({ type: 'semicolon',   value: ';' }); i++; continue; }
    // Operators (two-char first)
    if (/[=<>!+\-*/%^&|~]/.test(sql[i])) {
      const two = sql.slice(i, i + 2);
      if (['!=','<>','<=','>=','||','**',':='].includes(two)) {
        tokens.push({ type: 'operator', value: two }); i += 2; continue;
      }
      tokens.push({ type: 'operator', value: sql[i] });
      i++; continue;
    }
    // Whitespace & others
    tokens.push({ type: 'other', value: sql[i] });
    i++;
  }
  return tokens;
}

// ── HTML highlighter ──────────────────────────────────────────

function highlight(sql: string): string {
  const tokens = tokenize(sql);
  return tokens.map((t) => {
    const esc = escHtml(t.value);
    switch (t.type) {
      case 'keyword':  return `<span class="fv-sql-keyword">${esc}</span>`;
      case 'function': return `<span class="fv-sql-function">${esc}</span>`;
      case 'string':   return `<span class="fv-sql-string">${esc}</span>`;
      case 'number':   return `<span class="fv-sql-number">${esc}</span>`;
      case 'comment':  return `<span class="fv-sql-comment">${esc}</span>`;
      case 'operator': return `<span class="fv-sql-operator">${esc}</span>`;
      default:         return esc;
    }
  }).join('');
}

