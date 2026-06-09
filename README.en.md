# Plain View

> [中文](README.md) · **English**

A Chromium-based browser extension that turns your browser into a friendly viewer for **JSON / Markdown / SQL / YAML / CSV / LOG** files, plus a built-in **Playground** with translation, diff, QR code generation, Base64/URL encoding, memo, and more. Zero runtime dependencies, hand-written, no bundler.

**Repositories:** [GitHub](https://github.com/777vv/plain-view) · [Gitee](https://gitee.com/vv777/plain-view)

---

## Highlights

### File Viewer

- **6 formats out of the box**: `JSON` · `Markdown` · `SQL` · `YAML` · `CSV / TSV` · `LOG / TXT`
- **JSON formatting** — syntax highlighting, collapsible tree, minify/escape/unescape
- **Markdown rendering** — headings, lists, tables, code blocks; XSS-safe
- **SQL pretty-print + highlight** — auto-formats, line numbers
- **YAML / CSV / LOG highlighting** — format-specific color schemes
- **CSV table editing** — double-click to edit cells, sticky header, download interception
- **Light / dark themes**, adjustable font size, search and copy

### Playground

- **JSON format/minify/escape** — paste on the left, see results on the right, error line detection
- **Markdown live preview** — WYSIWYG
- **SQL format** — keyword highlighting + line numbers
- **Base64 encode/decode** — auto-detects direction
- **URL decode** — query parameters parsed into a table
- **Translate** — Chinese ↔ English, long text chunked automatically
- **Diff** — IDEA-style side-by-side view, line-level + word-level highlights, accept hunks one by one
- **QR Code** — generate from text, download as PNG
- **Memo** — dual-pane plain-text notes, auto-save, export as TXT

### General

- Line numbers and current-line highlight in all editable areas
- Drag & drop `.json` / `.md` / `.sql` files onto the input
- Feature toggles (popup) to show/hide modules
- i18n: Chinese / English

---

## Install (regular users — no build needed)

### 1. Download

- **GitHub:** [plain-view.zip](https://github.com/777vv/plain-view/releases/latest/download/plain-view.zip)
- **Gitee:** [plain-view.zip](https://gitee.com/vv777/plain-view/releases/download/v0.1.0/plain-view.zip)

### 2. Unzip

Extract to a permanent location.

### 3. Load the extension

#### Chrome

1. Open `chrome://extensions`
2. Enable "Developer mode" (top-right)
3. Click "Load unpacked" (top-left)
4. Select the unzipped directory

#### Edge

1. Open `edge://extensions`
2. Enable "Developer mode" (left sidebar)
3. Click "Load unpacked"
4. Select the unzipped directory

---

## Build from source

```bash
git clone https://github.com/777vv/plain-view.git
cd plain-view
npm install
npm run build
```

Compiled output in `dist/`. Load the project root in `chrome://extensions`.

`npm run package` produces `release/plain-view.zip`.

---

## Usage

- **Web files**: open any `.json` / `.md` / `.sql` URL — auto-rendered
- **Local files**: drag into the browser
- **Playground**: click the extension icon → "Open Playground"
- **Toolbar**: toggle raw/formatted, copy, theme, font size, view source
- **Popup**: feature toggles to show/hide modules

---

## Project layout

```
src/
├── background/      # Service Worker: intercepts CSV/TSV downloads
├── content/         # Content script: format detection → renderer
├── viewer/          # CSV/TSV preview page
├── popup/           # Extension popup + feature toggles
├── playground/      # Playground: JSON/MD/SQL/Base64/URL/Translate/Diff/QR/Memo
├── decoders/        # Base64, URL parsing, QR generation
├── renderers/       # Per-format renderers (json/markdown/sql/yaml/csv/log)
└── ui/              # Shared: toolbar, themes, font size, i18n, common helpers
styles/
└── base.css         # All renderers + playground styles
scripts/
├── fix-imports.js   # Appends .js to relative imports in tsc output
└── package.ps1      # Packaging script
manifest.json
popup.html / viewer.html / playground.html
```
