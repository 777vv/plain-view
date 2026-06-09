# Plain View

> **中文** · [English](README.en.md)

基于 Chromium 的浏览器扩展。把浏览器变成 **JSON / Markdown / SQL / YAML / CSV / LOG** 文件的友好查看器，同时内置**工作台**提供翻译、文本对比、二维码生成、Base64/URL 编解码、备忘录等实用工具。零运行时依赖、纯手写、无打包器。

**源码仓库:** [GitHub](https://github.com/777vv/plain-view) · [Gitee](https://gitee.com/vv777/plain-view)

---

## 亮点

### 文件查看器

- **6 种格式开箱即用**:`JSON` · `Markdown` · `SQL` · `YAML` · `CSV / TSV` · `LOG / TXT`
- **JSON 格式化** — 语法高亮、可折叠树(主流览器)、压缩/转义/去转义
- **Markdown 渲染** — 标题、列表、表格、代码块;`javascript:` / `data:` 等危险协议自动屏蔽
- **SQL 美化 + 高亮** — 自动格式化,关键字/字符串/数字分色,行号显示
- **YAML / CSV / LOG 高亮** — 各格式专属配色
- **CSV 表格编辑** — 双击单元格直接编辑,表头固定,自动拦截下载改为预览
- **亮白 / 暗黑双主题**,字号可调,支持搜索和复制

### 工作台(Playground)

- **JSON 格式化/压缩/转义** — 左侧粘贴,右侧出结果,错误定位到行号
- **Markdown 实时预览** — 所见即所得
- **SQL 格式化** — 关键字高亮 + 行号
- **Base64 编解码** — 自动检测方向,支持编码和解码
- **URL 编解码** — 参数解析为表格
- **翻译** — 中英互译,支持长文本分段
- **文本对比** — IDEA 风格并排视图,行级+词级差异高亮,中间箭头逐块接受
- **二维码生成** — 输入文本即生成,可下载 PNG
- **备忘录** — 双栏纯文本便签,自动保存,可导出 TXT

### 通用

- 所有可编辑区域有行号、当前行高亮
- 拖拽 `.json` / `.md` / `.sql` 文件到输入框自动加载
- 功能开关(弹窗)可控制各模块显隐
- 中英双语界面

---

## 安装(普通用户:免构建)

### 1. 下载发布包

直接下载已编译好的 zip,无需 Node.js / npm:

- **GitHub:** [plain-view.zip](https://github.com/777vv/plain-view/releases/latest/download/plain-view.zip)
- **Gitee(国内更快):** [plain-view.zip](https://gitee.com/vv777/plain-view/releases/download/v0.1.0/plain-view.zip)

### 2. 解压

把 zip 解压到你想长期放置扩展的目录(浏览器加载时要指向这个目录)。

### 3. 加载扩展

#### Chrome

1. 打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 左上角点击「加载未打包的扩展程序」
4. 选择解压出来的目录(含 `manifest.json`)

#### Edge

1. 打开 `edge://extensions`
2. 左侧打开「开发人员模式」
3. 点击「加载解压缩的扩展」
4. 选择解压出来的目录

---

## 从源码构建(开发者)

```bash
git clone https://github.com/777vv/plain-view.git
cd plain-view
npm install
npm run build
```

构建产物在 `dist/`,然后照「加载扩展」选项目根目录。

`npm run package` 打包为 `release/plain-view.zip`。

---

## 使用

- **网页文件**:打开 `.json` / `.md` / `.sql` 等 URL,自动渲染
- **本地文件**:拖入浏览器即可
- **工作台**:点扩展图标 →「打开工作台」
- **工具栏**:切换原始/格式化、复制、主题、字号、查看源码
- **弹窗**:功能开关控制各模块显隐

---

## 项目结构

```
src/
├── background/      # Service Worker:拦截 CSV/TSV 下载
├── content/         # 内容脚本:检测格式并加载渲染器
├── viewer/          # CSV/TSV 预览页
├── popup/           # 扩展弹窗 + 功能开关
├── playground/      # 工作台:JSON/MD/SQL/Base64/URL/翻译/文本对比/二维码/备忘录
├── decoders/        # Base64 编解码、URL 解析、QR 生成
├── renderers/       # 文件格式渲染器(json/markdown/sql/yaml/csv/log)
└── ui/              # 共享组件:toolbar/themes/fontSize/i18n/common
styles/
└── base.css         # 所有渲染器 + 工作台样式
scripts/
├── fix-imports.js   # 给 tsc 输出的 import 补 .js 后缀
└── package.ps1      # 打包脚本
manifest.json
popup.html / viewer.html / playground.html
```
