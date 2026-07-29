// Viewer page — renders a local file that Chrome would otherwise download.
// The background worker navigates here with ?src=<file:// URL>; we fetch the
// file's contents and hand them to the matching renderer.

import { injectStyles } from '../ui/common';
import { enableSmartSelection } from '../ui/selection';

function showError(msg: string): void {
  document.body.textContent = msg;
  document.body.style.cssText =
    'font-family: -apple-system, Segoe UI, sans-serif; padding: 40px; font-size: 14px; white-space: pre-wrap; line-height: 1.6;';
}

(async () => {
  const src = new URL(location.href).searchParams.get('src');
  if (!src) { showError('未指定文件。'); return; }

  let raw: string;
  try {
    const resp = await fetch(src);
    raw = await resp.text();
  } catch {
    showError(
      '无法读取本地文件。\n\n' +
      '请打开 chrome://extensions，找到 Plain View，进入「详细信息」，\n' +
      '开启「允许访问文件网址」开关后，重新拖入文件。',
    );
    return;
  }

  await injectStyles();

  // Chrome only auto-downloads CSV/TSV among the formats we support, so the
  // viewer always renders with the csv renderer (it handles TSV internally).
  // The viewer's own URL (viewer.html?src=…) is kept intact so a page refresh
  // simply re-fetches the file; the real path is passed to the renderer so it
  // can show the right filename and detect .tsv.
  const renderer = await import(chrome.runtime.getURL('dist/renderers/csv.js')) as {
    render: (raw: string, srcPath?: string) => void;
  };
  renderer.render(raw, new URL(src).pathname);
  enableSmartSelection();
})();
