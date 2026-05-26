import { cycleTheme, getStoredTheme, themeLabel } from './themes';
import { cycleFontSize, getStoredFontSize, fontSizeLabel, FontSize } from './fontSize';
import { t, isZh } from './i18n';

const REPO_URL = 'https://github.com/777vv/plain-view';

// "主题：亮白" vs "Theme: Light" — colon style differs between locales.
const themeTip = (theme: ReturnType<typeof getStoredTheme>): string =>
  isZh() ? `主题：${themeLabel(theme)}` : `Theme: ${themeLabel(theme)}`;

const fontSizeTip = (size: FontSize): string =>
  isZh() ? `字号:${fontSizeLabel(size)}` : `Font size: ${fontSizeLabel(size)}`;

export interface ToolbarCallbacks {
  onRaw: (isRaw: boolean) => void;
  onCopy: () => void;
  onSearch?: (query: string) => void;
}

function icon(svg: string): string {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svg}</svg>`;
}

const ICONS = {
  raw:      icon('<polyline points="4 6 1 8 4 10"/><polyline points="12 6 15 8 12 10"/><line x1="9" y1="3" x2="7" y2="13"/>'),
  copy:     icon('<rect x="4" y="4" width="8" height="10" rx="1"/><path d="M6 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/>'),
  search:   icon('<circle cx="6.5" cy="6.5" r="4"/><line x1="10" y1="10" x2="14" y2="14"/>'),
  theme:    icon('<circle cx="8" cy="8" r="4"/><line x1="8" y1="1" x2="8" y2="3"/><line x1="8" y1="13" x2="8" y2="15"/><line x1="1" y1="8" x2="3" y2="8"/><line x1="13" y1="8" x2="15" y2="8"/>'),
  prevMatch: icon('<polyline points="4 10 8 6 12 10"/>'),
  nextMatch: icon('<polyline points="4 6 8 10 12 6"/>'),
  repo:     icon('<path d="M11 8v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4"/><polyline points="9 3 13 3 13 7"/><line x1="13" y1="3" x2="7" y2="9"/>'),
  fontSize: icon('<path d="M3 14 L8 3 L13 14"/><line x1="5" y1="10" x2="11" y2="10"/>'),
};

export function createToolbar(
  format: string,
  filename: string,
  raw: string,
  callbacks: ToolbarCallbacks,
): { toolbar: HTMLElement; searchBar: HTMLElement } {
  // ── Toolbar ───────────────────────────────────────────────────
  const toolbar = document.createElement('div');
  toolbar.className = 'fv-toolbar';

  const left = document.createElement('div');
  left.className = 'fv-toolbar-left';

  const badge = document.createElement('span');
  badge.className = 'fv-badge';
  badge.textContent = format;

  const fname = document.createElement('span');
  fname.className = 'fv-filename';
  fname.textContent = filename;
  fname.title = filename;

  left.append(badge, fname);

  const right = document.createElement('div');
  right.className = 'fv-toolbar-right';

  let searchBtn: HTMLButtonElement | null = null;
  if (callbacks.onSearch) {
    searchBtn = btn(ICONS.search, t('搜索 (Ctrl+F)', 'Search (Ctrl+F)'));
  }

  const rawBtn      = btn(ICONS.raw, t('切换原始内容', 'Show raw'));
  const copyBtn     = btn(ICONS.copy, t('复制', 'Copy'));
  const themeBtn    = btn(ICONS.theme, themeTip(getStoredTheme()));
  const fontSizeBtn = btn(ICONS.fontSize, fontSizeTip(getStoredFontSize()));
  const repoBtn     = btn(ICONS.repo, t('查看源码', 'View source'));

  const divider = document.createElement('div');
  divider.className = 'fv-divider';

  if (searchBtn) right.append(searchBtn, divider.cloneNode() as HTMLElement);
  right.append(rawBtn, copyBtn, divider, themeBtn, fontSizeBtn, divider.cloneNode() as HTMLElement, repoBtn);
  toolbar.append(left, right);

  // ── Search Bar ────────────────────────────────────────────────
  const searchBar = document.createElement('div');
  searchBar.className = 'fv-search-bar';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'fv-search-close';
  closeBtn.textContent = '×';
  closeBtn.dataset.tip = t('关闭搜索 (Esc)', 'Close search (Esc)');

  const prevBtn = document.createElement('button');
  prevBtn.className = 'fv-search-nav';
  prevBtn.innerHTML = ICONS.prevMatch;
  prevBtn.dataset.tip = t('上一个 (Shift+Enter)', 'Previous (Shift+Enter)');

  const nextBtn = document.createElement('button');
  nextBtn.className = 'fv-search-nav';
  nextBtn.innerHTML = ICONS.nextMatch;
  nextBtn.dataset.tip = t('下一个 (Enter)', 'Next (Enter)');

  const searchInput = document.createElement('input');
  searchInput.className = 'fv-search-input';
  searchInput.type = 'text';
  searchInput.placeholder = t('搜索…', 'Search…');

  const countSpan = document.createElement('span');
  countSpan.className = 'fv-search-count';

  searchBar.append(closeBtn, prevBtn, nextBtn, searchInput, countSpan);

  // ── Search state ──────────────────────────────────────────────
  let highlights: HTMLElement[] = [];
  let currentIdx = -1;

  function runSearch(q: string): void {
    callbacks.onSearch!(q);
    highlights = Array.from(document.querySelectorAll<HTMLElement>('.fv-highlight'));
    currentIdx = highlights.length > 0 ? 0 : -1;
    updateCount();
    if (currentIdx >= 0) scrollToMatch(currentIdx);
  }

  function navigate(dir: 1 | -1): void {
    if (highlights.length === 0) return;
    currentIdx = (currentIdx + dir + highlights.length) % highlights.length;
    updateCount();
    scrollToMatch(currentIdx);
  }

  function scrollToMatch(idx: number): void {
    highlights.forEach((el, i) => el.classList.toggle('fv-highlight-current', i === idx));
    highlights[idx]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function updateCount(): void {
    if (highlights.length === 0) {
      countSpan.textContent = searchInput.value.trim() ? t('无结果', 'No results') : '';
    } else {
      countSpan.textContent = `${currentIdx + 1} / ${highlights.length}`;
    }
  }

  // ── Events ────────────────────────────────────────────────────
  let isRaw = false;

  rawBtn.addEventListener('click', () => {
    isRaw = !isRaw;
    rawBtn.classList.toggle('active', isRaw);
    rawBtn.dataset.tip = isRaw
      ? t('显示格式化视图', 'Show formatted')
      : t('切换原始内容', 'Show raw');
    callbacks.onRaw(isRaw);
  });

  copyBtn.addEventListener('click', async () => {
    callbacks.onCopy();
    const orig = copyBtn.innerHTML;
    copyBtn.innerHTML = icon('<polyline points="3 8 6 11 13 4"/>');
    setTimeout(() => { copyBtn.innerHTML = orig; }, 1200);
  });

  themeBtn.addEventListener('click', () => {
    const next = cycleTheme();
    themeBtn.dataset.tip = themeTip(next);
  });

  fontSizeBtn.addEventListener('click', () => {
    const next = cycleFontSize();
    fontSizeBtn.dataset.tip = fontSizeTip(next);
  });

  repoBtn.addEventListener('click', () => {
    window.open(REPO_URL, '_blank', 'noopener,noreferrer');
  });

  if (searchBtn && callbacks.onSearch) {
    searchBtn.addEventListener('click', () => toggleSearch(true));

    searchInput.addEventListener('input', () => {
      runSearch(searchInput.value);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        toggleSearch(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        navigate(e.shiftKey ? -1 : 1);
      }
    });

    closeBtn.addEventListener('click', () => toggleSearch(false));
    prevBtn.addEventListener('click', () => navigate(-1));
    nextBtn.addEventListener('click', () => navigate(1));
  }

  function toggleSearch(open: boolean): void {
    searchBar.classList.toggle('visible', open);
    if (open) {
      searchInput.focus();
      searchInput.select();
    } else {
      searchInput.value = '';
      highlights.forEach(el => el.classList.remove('fv-highlight-current'));
      callbacks.onSearch?.('');
      highlights = [];
      currentIdx = -1;
      countSpan.textContent = '';
    }
  }

  // Ctrl+F shortcut
  if (callbacks.onSearch) {
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        toggleSearch(!searchBar.classList.contains('visible'));
      }
    });
  }

  return { toolbar, searchBar };
}

function btn(html: string, tip: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'fv-btn';
  b.innerHTML = html;
  b.dataset.tip = tip;
  return b;
}
