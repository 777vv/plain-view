# CLAUDE.md

供 Claude Code 在本仓库工作时参考的项目说明。

## 项目概览

**Plain View** —— Chrome MV3 扩展,有两块能力:

1. **文件美化器**(原始功能):在浏览器里把 JSON / Markdown / SQL / YAML / CSV / LOG 等文本文件渲染成漂亮的视图。content script 自动检测格式,动态 import 渲染器。
2. **开发者工作台 Playground**(后加):独立页 `playground.html`,9 个常用工具模块,数据存在 `chrome.storage.local`。

- 所有渲染器/解码器都是手写 TypeScript,**无任何运行时依赖**(`dependencies: {}`)
- 无打包器:`tsc` + `scripts/fix-imports.js`(给相对 import 补 `.js` 后缀)即可出 `dist/`
- 品牌主色:rose-pink `#ED4588`。视觉方向是 **Type Specimen**(暖纸面 + rose 当"墨" + mono 显示体):rose 只在焦点环/活动态/样本标签处克制使用,主按钮是**纯色** rose 实心(不再是渐变)。新增 token:`--fv-font-display`(mono 展示体)、`--rose-brand`/`--rose-ink`(正文级,过 AA)/`--rose-tint`。亮主题正文链接用 `#d81b60`(`#ed4588` 在纸面上不过 AA,只留给大字/UI/焦点)
- 双主题:**Paper Light**(默认,暖白纸面,自有中性色非 GitHub Primer)/ **Warm Near-Black**(暖近黑,黑里掺品红让 rose 发光;暗色链接是 rose `#f56fa6` 不是 VS Code 青),存 `localStorage['fv_theme']`
- 文件查看器顶栏(`createToolbar`)现在真正渲染**样本刊头**:格式标签(small-caps rose + 发丝规线)+ 文件名(18px mono 标题)+ 元数据 caption(`{KB} · {行数} 行`,从 `raw` 现算)。之前 `format`/`filename`/`raw` 参数收了没用、左栏空白。工作台顶栏左栏是 `plain.view` wordmark

## 常用命令

```bash
npm run build      # tsc 编译 + 给相对 import 补 .js 后缀
npm run watch      # tsc --watch 增量编译
npm run package    # build + 打包成 release/plain-view.zip
```

改完 TS 后,在 `chrome://extensions` 点扩展卡片的「刷新」即可生效。
改 `styles/base.css` 不需要 build,刷新页面即可。

## 目录结构

```
src/
├── background/index.ts   # Service worker(MV3 模块):拦 file:// 的 .csv/.tsv 下载转 viewer.html;建右键菜单 "Format with Plain View"
├── content/index.ts      # 内容脚本(classic script,不能顶层 import):检测格式 + 动态 import 渲染器
├── viewer/index.ts       # 预览页(扩展页,模块):fetch ?src=<file URL> 后调 csv 渲染器
├── popup/popup.ts        # 弹窗:主题切换 + 各格式/工作台模块启用开关(存 chrome.storage.local['disabledFormats'])
├── renderers/            # 文件美化渲染器,每个导出 render(raw: string): void(csv 多一个 srcPath?)
│   ├── json.ts           #   JSON 树视图(默认全展开,剥 JSONP)
│   ├── markdown.ts       #   Markdown → HTML(带 XSS 防护 + data-line 注入供工作台滚动联动用)
│   ├── sql.ts            #   SQL 格式化 + 高亮 + 搜索(导出 formatSQL / highlight)
│   ├── yaml.ts           #   YAML 高亮
│   ├── csv.ts            #   CSV/TSV 表格(自动检测分隔符、排序、固定表头、双击编辑)
│   └── log.ts            #   LOG 高亮(error/warn/info/debug/trace 分色)
├── decoders/             # 工作台用的纯函数解码器
│   ├── base64.ts         #   processBase64: 标准 + URL-safe,自动判方向
│   ├── url.ts            #   processUrl + UrlParts: 拆 scheme/host/port/path/query/hash
│   └── qr.ts             #   generateQr: Level-H, version 1-40 自动选,**从 qrcode-generator (MIT) 移植** —— 不要自己手写 EC 表,之前手写的扫不出来
├── playground/           # 开发者工作台
│   ├── index.ts          #   主入口(boot IIFE,~1900 行):9 个模块、持久化、备忘录、Markdown 滚动联动
│   ├── diff.ts           #   Myers 差异算法(导出 diffLines / groupHunks / diffWords 等)
│   └── diffView.ts       #   IDEA 风格双栏 diff 视图(gutter + 行底色 + apply 按钮)
└── ui/
    ├── common.ts         #   setupPage / copyText(带 execCommand 兜底)/ escHtml / injectStyles
    ├── toolbar.ts        #   createToolbar(format, filename, raw, callbacks):顶栏 badge/raw/copy/search/theme/fontSize
    ├── themes.ts         #   THEMES / getStoredTheme / applyTheme / cycleTheme
    ├── fontSize.ts       #   FONT_SIZES / getStoredFontSize / applyFontSize / cycleFontSize(small/medium/large)
    └── i18n.ts           #   isZh() + t(zh, en):按 locale 取文案,工作台大量用
styles/base.css           # 所有渲染器 + 工作台共享样式(--fv-* token、亮/暗主题、工作台布局)
scripts/
├── fix-imports.js        # build 后置:给 dist/ 相对 import 补 .js 后缀
└── package.ps1           # release 打包(显式白名单,见下)
manifest.json             # MV3 manifest
popup.html / viewer.html / playground.html   # 三个扩展页入口
popup.css                 # 弹窗样式
```

## 工作台 Playground(`src/playground/index.ts`)

9 个模块,顺序固定:`json → markdown → sql → translate → url → base64 → diff → qr → memo`。每个模块可在 popup 里单独禁用(禁用的不显示为 chip)。状态持久化在 `chrome.storage.local['pg_state']`(模式、各模块草稿、diff 双栏内容、jsonView、b64Dir、splitRatio),防抖 300ms 保存。

| key | 模块 | 说明 |
|-----|------|------|
| json | JSON | 子模式 format / minify / escape / unescape |
| markdown | Markdown | **左侧滚动联动右侧输出**(见下坑) |
| sql | SQL | formatSQL + 高亮 |
| translate | 翻译 | 调 `api.mymemory.translated.net`(8s 超时);若译文是单个英文词,额外查 `dictionaryapi.dev` 取音标 |
| url | URL | 拆 URL 各部分 |
| base64 | Base64 | 子模式 auto / encode / decode |
| diff | 文本对比 | 双栏,Myers 算法 + IDEA 风格视图 |
| qr | 二维码 | decoders/qr.ts,Level-H,微信可扫 |
| memo | 备忘录 | 见下 |

### 备忘录(Memo)

数据模型:
```ts
type MemoFile = {
  id: string; title: string; content: string;
  updatedAt: number; createdAt: number;  // createdAt 只在新建时设一次,后续不改
  icon?: number;                           // MEMO_ICONS 的下标(0-19)
};
```
- 存储:`pg_memo_v2`(文件列表) + `pg_memo_cur`(当前 id);首次加载会清掉旧 key `pg_memo_1` / `pg_memo_2`
- `MEMO_ICONS`:20 个预设 emoji `📝📌⭐💡🔥🚀✅🎯📋🔖💼🎨📊🔔🌟🏷️💬🔑🧩⚡`
- `nextIcon()` 固定返回 `0`:**新建/导入的文件默认都用第一个图标 📝**,不再循环分配。想换图标点文件标题栏的图标 → 弹 20 格选择器手选
- 左侧文件列表支持 HTML5 拖拽排序、删除(带确认框)
- 导出用 `chrome.downloads.download({ saveAs: false })`(不要用 `<a download>.click()`,某些 Chrome 设置下会变成打开文件)
- 导入用藏在 `position:absolute;left:-9999px` 的 `<input type=file>`(display:none 下 .click() 在扩展环境里不可靠);导入后**直接 `chrome.storage.local.set`**,不要走 `saveMemo`(saveMemo 会先 flushEditorToMemo,用旧编辑器内容覆盖刚导入的内容)

## 关键约束(踩过的坑)

1. **content script 不能顶层 import 模块**。`src/content/index.ts` 被 Chrome 当 classic script 加载,顶层 `import` 会报错。用动态 `import(chrome.runtime.getURL('dist/x.js'))`,或文件内自写一份(我们的 `injectStyles` 就是自写)。
2. **viewer / background / popup / renderers / decoders / playground 都是模块**,可以正常 `import`。
3. **CSV/TSV 走特殊路径**。Chrome 默认把 `.csv` 当附件下载,所以:
   - `src/background/index.ts` 监听 `chrome.downloads.onCreated`,看到 `file://*.csv` 就 cancel + erase
   - `chrome.tabs.create('viewer.html?src=<file URL>')` 打开预览页
   - `src/viewer/index.ts` `fetch(src)` 拿内容,调 csv 渲染器
   - **这条路径需要用户在扩展详情里开「允许访问文件网址」**,否则 `fetch('file://...')` 失败
4. **CSV 单元格编辑**:`dblclick` 进编辑 → blur/Enter 提交。改动单元格加 `.fv-csv-dirty` 类,CSS 显示右上角 ✱。`serializeTable()` 优先读 `<input>.value` 再 fallback `textContent`,编辑中点复制/下载也拿得到最新值。
5. **CSV viewer 不要用 history.replaceState 改 URL**。早期试过把 `viewer.html?src=…` 改成假路径让渲染器读 `location.pathname` 拿文件名,刷新时报「无法访问文件」。**当前方案**:URL 保持 `viewer.html?src=…`,文件名通过 `render(raw, srcPath)` 参数传给 csv 渲染器。
6. **跨页共享数据用 `chrome.storage.local`**,不要用 `localStorage`(popup 跟 content script 在不同 origin)。`disabledFormats`、工作台 `pg_state`、备忘录都已迁;主题 `fv_theme` 仍在 localStorage,跨域不共享是已知问题。
7. **grid/flex 子项滚动条丢失**:`.fv-pg-pane` 是 grid item,默认 `min-height:auto` 会被撑高导致内部不滚。必须显式 `min-height:0; overflow:hidden`。`.fv-pg-numbered` 用 `min-height:100%` 而不是 `auto`(`auto` 会让输出区不滚)。
8. **Markdown 滚动联动很坑,改了 7+ 轮才对**。textarea 是自动撑高(不自滚),inputScroll 才是滚动容器,gutter 行通过 `attachWrappedGutter` 的镜像 div 携带真实每行高度(含软换行)。最终方案:用 gutter 行 offsetTop 累加算 visibleLine + 输出区 getBoundingClientRect + 块间插值。**只做单向(input→output)**,边界处 wheel 中继。改这块前先读完整套逻辑,别只动一处。
9. **二维码别自己写 EC 表**。手写的 H 级纠错表数据错了,微信/浏览器都扫不出。已整体替换为从 qrcode-generator 移植的算法(GF(256)、RS、自动 mask 评分)。
10. **新增一个文件格式**:在 `src/renderers/` 写 `xxx.ts` → 在 `src/content/index.ts` 的 `FileFormat` / `extMap` / content-type 检测里登记 → 在 `src/popup/popup.ts` 的 `FORMATS` / `extMap` 里登记。
11. **新增一个工作台模块**:在 `src/playground/index.ts` 的模块列表(`ALL_LABELS`)登记 → 建对应 pane → 在 popup 的开关列表里登记(否则不能单独禁用)。

## 打包

`npm run package` 会先 `npm run build`,再调 `scripts/package.ps1` 把扩展打包成 `release/plain-view.zip`。

### 打包白名单(只列「浏览器加载必需」的文件)

`scripts/package.ps1` 用**显式白名单**复制文件,**不要**改成全量拷贝 + 排除清单 —— 那样很容易漏掉新加的文档/配置文件,让用户多下几十 KB 没用的东西。

进 zip:
- `manifest.json`
- `popup.html` / `popup.css`
- `viewer.html`
- `playground.html`
- `dist/`(所有编译产物)
- `styles/`(所有 CSS)
- `icons/`(扩展图标)

**不进** zip(踩过的坑,逐条记下来,新增类似文件时不要漏):
- 文档:`README.md` / `CLAUDE.md` / `PRD.md` —— 用户下载是用扩展的,不需要看开发文档
- git 元文件:`.gitignore` / `.git/`
- 工具链配置:`package.json` / `package-lock.json` / `tsconfig.json`
- 源码:`src/`
- 依赖:`node_modules/`
- 构建脚本:`scripts/`
- 临时/辅助:`scripts/generate-icons.html`、`scripts/_push*.ps1`

`release/` 已在 `.gitignore`,本地打的 zip 不会污染 git。

### 验证 zip 内容

发布前可以用下面这段一次性命令列出当前 zip 里的所有文件,目测是否多/少:

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem; (
  [System.IO.Compression.ZipFile]::OpenRead('release/plain-view.zip')
).Entries | Sort-Object FullName | ForEach-Object FullName
```


## Skills 强制评估（必须遵守）

> **每次用户提问时，UserPromptSubmit Hook 会注入技能评估提示（以 `## 强制技能激活流程` 开头）。必须严格遵循！**


## 行为准则

减少常见 LLM 编码偏差。简单任务可适度放宽。

### 1. 写代码前先思考

- 假设要明说;不确定就问,不要默默选方向
- 多种解读时摆出来让用户挑,不要替用户决定
- 有更简单的做法就提出来,必要时反驳
- 看不懂就停;指出哪里不清楚,然后问

### 2. 简单优先

- 只解决用户问的问题,不多写
- 一次性代码不要抽象
- 不为「可能的未来」预留口子
- 不为不可能的场景写错误处理
- 200 行能压成 50 就压,问自己「资深工程师会说这太复杂吗?」

### 3. 改动外科手术化

- 只动跟任务直接相关的代码
- 不顺手「改进」邻近代码、注释、格式
- 不重构没坏的东西
- 你的改动导致的孤儿 import / 变量 / 函数,要删干净;**不**主动清理项目里其它原有的死代码,提一下让用户决定
- 标准:每一行 diff 都能直接追溯到用户的请求

### 4. 目标驱动

- 把任务转成可验证的目标(写测试 / 跑构建 / 看 UI)
- UI 改动必须在浏览器里实测过再说完成
- 类型通过 ≠ 功能正确;测试通过 ≠ 体验正确
