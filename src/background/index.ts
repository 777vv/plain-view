// Background service worker.

export {}; // mark as a module

// ── CSV/TSV download interception ─────────────────────────────
// Chrome auto-downloads local .csv/.tsv files instead of displaying them, so
// the content script never gets a chance to run. We cancel the download and
// reopen the file in the extension's viewer page.
chrome.downloads.onCreated.addListener((item) => {
  const url = item.finalUrl || item.url || '';
  if (!/^file:\/\//i.test(url)) return;
  if (!/\.(csv|tsv)$/i.test(url)) return;

  chrome.downloads.cancel(item.id)
    .then(() => chrome.downloads.erase({ id: item.id }))
    .catch(() => { /* download may already be gone */ });

  const viewer = chrome.runtime.getURL('viewer.html') + '?src=' + encodeURIComponent(url);
  chrome.tabs.create({ url: viewer });
});

// ── Context menu: "Open in Plain View Playground" ─────────────
const MENU_ID = 'plain-view-playground';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    // i18n via browser locale — service worker can't import shared helpers cleanly
    title: (navigator.language || '').toLowerCase().startsWith('zh')
      ? '用 Plain View 格式化'
      : 'Open in Plain View',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID) return;
  const text = info.selectionText ?? '';
  // Pass content via chrome.storage.local (no URL length limit, accessible to
  // extension pages). Playground reads then deletes immediately.
  const key = 'fv_playground_handoff_' + Date.now();
  chrome.storage.local.set({ [key]: text }).then(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL('playground.html') + '#k=' + key });
  }).catch(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL('playground.html') });
  });
});
