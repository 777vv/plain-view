import { t } from '../ui/i18n';

// Sync the popup theme with the main app. The main app stores its theme in
// localStorage under 'fv_theme'; since the popup shares the extension origin,
// it can read the same value. Apply it before rendering to avoid a flash.
const savedTheme = localStorage.getItem('fv_theme');
if (savedTheme === 'github-dark') {
  document.documentElement.setAttribute('data-fv-theme', 'github-dark');
}

// Feature toggles + reordering now live inside the Playground itself (the gear
// button on the module tab row), so the popup is just a launcher.
const playgroundLabel = document.getElementById('open-playground-label');
if (playgroundLabel) playgroundLabel.textContent = t('打开工作台', 'Open Playground');
document.getElementById('open-playground')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('playground.html') });
});
