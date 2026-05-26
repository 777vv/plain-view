# CLAUDE.md

供 Claude Code 在本仓库工作时参考的项目说明。

## 项目概览

**Plain View** —— Chrome MV3 扩展,在浏览器里美化 JSON / Markdown / SQL / YAML / CSV / LOG 等文本文件。

- 所有渲染器都是手写 TypeScript,**无任何运行时依赖**
- 无打包器:`tsc` + `scripts/fix-imports.js`(给相对 import 补 `.js` 后缀)即可出 `dist/`
- 支持的格式列表见 `src/content/index.ts` 的 `FileFormat` 类型 + `extMap`
- 渲染器在 `src/renderers/*.ts`,每个导出 `render(raw: string): void`(csv 多一个 `srcPath?` 参数)

## 常用命令

```bash
npm run build      # tsc 编译 + 给相对 import 补 .js 后缀
npm run watch      # 增量编译
npm run package    # build + 打包成 release/plain-view.zip
```

改完 TS 后,在 `chrome://extensions` 点扩展卡片的「刷新」即可生效。
改 `styles/base.css` 不需要 build,刷新页面即可。

## 目录结构

```
src/
├── background/index.ts   # Service worker:监听 chrome.downloads,拦截 file:// 的 .csv/.tsv 下载,转跳到 viewer.html
├── content/index.ts      # 内容脚本(classic script,无法 import 模块):检测格式 + 动态 import 渲染器
├── viewer/index.ts       # 预览页(扩展页,是模块):fetch 文件 URL 后调 csv 渲染器
├── popup/popup.ts        # 扩展弹窗:主题切换 + 各格式启用/禁用开关
├── renderers/            # 各格式渲染器
│   ├── json.ts           #   JSON 树视图(默认全展开)
│   ├── markdown.ts       #   Markdown → HTML(带 XSS 防护:屏蔽 javascript:/data: 等)
│   ├── sql.ts            #   SQL 格式化 + 高亮 + 搜索
│   ├── yaml.ts           #   YAML 高亮
│   ├── csv.ts            #   CSV/TSV 表格(双击编辑、排序、固定表头)
│   └── log.ts            #   LOG 高亮
└── ui/
    ├── common.ts         # 共享 helper:setupPage / escHtml / download / injectStyles
    ├── toolbar.ts        # 顶栏(badge / raw / copy / download / search / theme)
    └── themes.ts         # 亮白 + 暗黑双主题
styles/base.css           # 所有渲染器共享的样式
scripts/
├── fix-imports.js        # build 后置脚本
└── package.ps1           # `npm run package` 调用,生成 release zip
manifest.json             # MV3 manifest
popup.html / viewer.html  # 扩展页 HTML
```

## 关键约束(踩过的坑)

1. **content script 不能 import 模块**。`src/content/index.ts` 被 Chrome 当 classic script 加载,顶层 `import` 会报错。要么用动态 `import(chrome.runtime.getURL('dist/x.js'))`,要么文件内自己写一份(我们的 `injectStyles` 就是这么处理)。
2. **viewer / background / popup / renderers 都是模块**,可以 `import` 自 `src/ui/common.ts`。
3. **CSV/TSV 走特殊路径**。Chrome 默认把 `.csv` 当附件下载,所以:
   - `src/background/index.ts` 监听 `chrome.downloads.onCreated`,看到 `file://*.csv` 就 cancel + erase
   - `chrome.tabs.create('viewer.html?src=<file URL>')` 打开预览页
   - `src/viewer/index.ts` `fetch(src)` 拿到内容,调 csv 渲染器
   - **这条路径需要用户在扩展详情里开「允许访问文件网址」**,否则 `fetch('file://...')` 失败
4. **CSV 单元格编辑**:`dblclick` 进入编辑 → blur/Enter 提交。改动单元格加 `.fv-csv-dirty` 类,CSS 显示右上角 ✱。`serializeTable()` 优先读 `<input>.value` 再 fallback `textContent`,所以编辑过程中点复制/下载也拿得到最新值。
5. **CSV viewer 不要用 history.replaceState 改 URL**。早期试过把 `viewer.html?src=…` 改成假路径 `chrome-extension://…/file.csv` 让渲染器读 `location.pathname` 拿文件名,刷新时浏览器报「无法访问文件」。**当前方案**:URL 保持 `viewer.html?src=…`,文件名通过 `render(raw, srcPath)` 参数传给 csv 渲染器。
6. **跨页共享数据用 `chrome.storage.local`**,不要用 `localStorage`(popup 跟 content script 在不同 origin)。当前禁用格式列表(`disabledFormats`)已迁;主题(`fv_theme`)仍在 `localStorage`,跨域不共享是已知问题。
7. **XML 已删除**。Chrome 内置 XML viewer 把页面包了一层 HTML,但维护成本高、用户少。
8. **新增一个格式**:在 `src/renderers/` 写 `xxx.ts` → 在 `src/content/index.ts` 的 `FileFormat` / `extMap` / content-type 检测里登记 → 在 `src/popup/popup.ts` 的 `FORMATS` / `extMap` 里登记。

## 打包

`npm run package` 会先 `npm run build`,再调 `scripts/package.ps1` 把扩展打包成 `release/plain-view.zip`。

### 打包白名单(只列「浏览器加载必需」的文件)

`scripts/package.ps1` 用**显式白名单**复制文件,**不要**改成全量拷贝 + 排除清单 —— 那样很容易漏掉新加的文档/配置文件,让用户多下几十 KB 没用的东西。

进 zip:
- `manifest.json`
- `popup.html` / `popup.css`
- `viewer.html`
- `dist/`(所有编译产物)
- `styles/`(所有 CSS)

**不进** zip(踩过的坑,逐条记下来,新增类似文件时不要漏):
- 文档:`README.md` / `CLAUDE.md` / `PRD.md` —— 用户下载是用扩展的,不需要看开发文档
- git 元文件:`.gitignore` / `.git/`
- 工具链配置:`package.json` / `package-lock.json` / `tsconfig.json`
- 源码:`src/`
- 依赖:`node_modules/`
- 构建脚本:`scripts/`

`release/` 已在 `.gitignore`,本地打的 zip 不会污染 git。

### 验证 zip 内容

发布前可以用下面这段一次性命令列出当前 zip 里的所有文件,目测是否多/少:

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem; (
  [System.IO.Compression.ZipFile]::OpenRead('release/plain-view.zip')
).Entries | Sort-Object FullName | ForEach-Object FullName
```

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
