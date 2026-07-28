# Plain View

> **[中文](README.md)** · English

A Chromium-based browser extension (unzipped size is less than 300KB). It transforms your browser into a friendly viewer for **JSON/Markdown/SQL** and other files. Simultaneously, it features a built-in **Playground**, which integrates commonly used tools such as JSON formatting, real-time Markdown preview, SQL beautification, Base64 encoding/decoding, URL parsing, translation, text comparison, QR code generation, and memos.

**Source Code:** [GitHub](https://github.com/777vv/plain-view) · [Gitee](https://gitee.com/vv777/plain-view)

---

## Highlights

### File Viewer

- **6 Formats Out-of-the-Box**: `JSON` · `Markdown` · `SQL` · `YAML` · `CSV / TSV` · `LOG / TXT`
- **JSON Formatting** — Syntax highlighting, foldable trees (major browsers), compress/escape/unescape
- **Markdown Rendering** — Headers, lists, tables, code blocks; automatic blocking of dangerous protocols like `javascript:` / `data:`
- **SQL Beautification + Highlighting** — Automatic formatting, color-coded keywords/strings/numbers, line number display
- **YAML / CSV / LOG Highlighting** — Format-specific color schemes
- **CSV Table Editing** — Direct cell editing via double-click, fixed headers, automatic interception of downloads for preview
- **Light/Dark Themes**, adjustable font size, supports search and copy

### Playground

- **JSON Format/Compress/Escape** — Paste on the left, results on the right, error localization by line number
- **Real-time Markdown Preview** — WYSIWYG
- **SQL Formatting** — Keyword highlighting + line numbers
- **Base64 Encoding/Decoding** — Automatic direction detection, supports both encoding and decoding
- **URL Encoding/Decoding** — Parameter parsing displayed as a table
- **Translation** — English-Chinese mutual translation, supports long text segmentation
- **Text Comparison** — IDEA-style side-by-side view, line-level and word-level difference highlighting, block-by-block acceptance via center arrows
- **QR Code Generation** — Generate instantly upon text input, downloadable as PNG
- **Memos** — Dual-column plain text notes, auto-save, exportable as TXT

### General

- Line numbers and current line highlighting for all editable areas
- Drag and drop `.json` / `.md` / `.sql` files into input boxes for automatic loading
- Feature toggles (via popup) to control the visibility of different modules
- Bilingual interface (English/Chinese)

---

## Installation (Regular Users: No Build Required)

### 1. Download the Release Package

Directly download the pre-compiled zip; no Node.js / npm required:

- **GitHub:** [plain-view.zip](https://github.com/777vv/plain-view/releases/latest/download/plain-view.zip)
- **Gitee (Faster in China):** [plain-view.zip](https://gitee.com/vv777/plain-view/releases/download/v0.1.0/plain-view.zip)

### 2. Unzip

Unzip the file to a directory where you intend to keep the extension permanently (the browser will need to point to this directory).

### 3. Load Extension

#### Chrome

1. Enter `chrome://extensions` in the address bar or open Manage Extensions.
2. Enable 「Developer mode」 in the top right corner.
3. Click 「Load unpacked」 in the top left corner.
4. Select the unzipped directory (the one containing `manifest.json`).

#### Edge

1. Enter `edge://extensions` in the address bar or open Manage Extensions.
2. Enable 「Developer mode」 in the bottom left.
3. Click 「Load unpacked」.
4. Select the unzipped directory.

---

## Playground Preview

![p1.png](/picture/p1.png)

![p2.png](/picture/p2.png)

![p3.png](/picture/p3.png)

## Build from Source (Developers)

```bash
git clone https://github.com/777vv/plain-view.git
cd plain-view
npm install
npm run build
```

Build artifacts are located in `dist/`. Then, follow the "Load Extension" steps and select the project root directory.

`npm run package` packages the project into `release/plain-view.zip`. After getting the zip, simply unzip it and follow the "Load Extension" steps according to your browser.

---

## Usage

- **Web Files**: Open URLs ending in `.json` / `.md` / `.sql`, etc., for automatic rendering.
- **Local Files**: Drag and drop files directly into the browser.
- **Playground**: Click the extension icon $\rightarrow$ 「Open Playground」.
- **Toolbar**: Toggle between Raw/Formatted views, copy, change themes, adjust font size, or view source code.
- **Popup**: Use feature switches to control module visibility.

---

## Project Structure

```
src/
├── background/      # Service Worker: Intercepts CSV/TSV downloads
├── content/         # Content Script: Detects format and loads renderer
├── viewer/          # CSV/TSV preview page
├── popup/           # Extension popup + feature toggles
├── playground/      # Playground: JSON/MD/SQL/Base64/URL/Translation/Text Diff/QR/Memos
├── decoders/        # Base64 encoding/decoding, URL parsing, QR generation
├── renderers/       # File format renderers (json/markdown/sql/yaml/csv/log)
└── ui/              # Shared components: toolbar/themes/fontSize/i18n/common
styles/
└── base.css         # Styles for all renderers + Playground
scripts/
├── fix-imports.js   # Appends .js extension to tsc output imports
└── package.ps1      # Packaging script
manifest.json
popup.html / viewer.html / playground.html
```

## Contact Author
For any questions, please contact the author via WeChat: vwvwbdwvwv
