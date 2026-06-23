import { t } from '../ui/i18n';

// Sync the popup theme with the main app. The main app stores its theme in
// localStorage under 'fv_theme'; since the popup shares the extension origin,
// it can read the same value. Apply it before rendering to avoid a flash.
const savedTheme = localStorage.getItem('fv_theme');
if (savedTheme === 'github-dark') {
  document.documentElement.setAttribute('data-fv-theme', 'github-dark');
}

// All features that appear as chips in the playground. The `fileFormats`
// subset also controls content-script rendering (see src/content/index.ts).
const FEATURES: { id: string; zh: string; en: string }[] = [
  { id: 'json',      zh: 'JSON',        en: 'JSON' },
  { id: 'markdown',  zh: 'Markdown',    en: 'Markdown' },
  { id: 'sql',       zh: 'SQL',         en: 'SQL' },
  { id: 'translate', zh: '翻译',         en: 'Translate' },
  { id: 'url',       zh: 'URL 编解码',   en: 'URL Decode' },
  { id: 'base64',    zh: 'Base64 编解码', en: 'Base64' },
  { id: 'diff',      zh: '文本对比',     en: 'Compare' },
  { id: 'qr',        zh: '二维码',       en: 'QR Code' },
  { id: 'memo',      zh: '备忘录',       en: 'Memo' },
];

const STORAGE_KEY = 'disabledFormats';

async function getDisabled(): Promise<Set<string>> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return new Set((data[STORAGE_KEY] as string[]) ?? []);
}

async function setDisabled(disabled: Set<string>): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: [...disabled] });
}

// ── Init ──────────────────────────────────────────────────────

const disabled = await getDisabled();

// Remove ghost entries for features that no longer exist
const knownIds = new Set(FEATURES.map((f) => f.id));
let cleaned = false;
for (const id of disabled) {
  if (!knownIds.has(id)) { disabled.delete(id); cleaned = true; }
}
if (cleaned) setDisabled(disabled);

// Open Playground
const playgroundLabel = document.getElementById('open-playground-label');
if (playgroundLabel) playgroundLabel.textContent = t('打开工作台', 'Open Playground');
document.getElementById('open-playground')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('playground.html') });
});

// i18n the section label
const sectionLabel = document.getElementById('section-label');
if (sectionLabel) sectionLabel.textContent = t('功能开关', 'Features');

const toggleContainer = document.getElementById('feature-toggles')!;

FEATURES.forEach(({ id, zh, en }) => {
  const row = document.createElement('div');
  row.className = 'format-row';

  const nameEl = document.createElement('span');
  nameEl.className = 'format-name';
  nameEl.textContent = t(zh, en);

  const switchWrap = document.createElement('label');
  switchWrap.className = 'toggle-switch';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !disabled.has(id);

  input.addEventListener('change', () => {
    if (input.checked) {
      disabled.delete(id);
    } else {
      // Don't allow turning off the last enabled feature
      const enabled = FEATURES.filter((f) => !disabled.has(f.id) && f.id !== id);
      if (enabled.length === 0) {
        input.checked = true;
        return;
      }
      disabled.add(id);
    }
    setDisabled(disabled);
  });

  const track = document.createElement('span');
  track.className = 'toggle-track';

  switchWrap.append(input, track);
  row.append(nameEl, switchWrap);
  toggleContainer.appendChild(row);
});
