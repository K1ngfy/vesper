# VESPER

**粘贴之前，先过一遍暮星。**

![license](https://img.shields.io/badge/license-MIT-black)
![platform](https://img.shields.io/badge/Chrome%20%2F%20Edge-MV3-black)
![privacy](https://img.shields.io/badge/privacy-100%25%20local-black)

VESPER 是一款浏览器扩展（Chrome / Edge，Manifest V3）：在文本粘贴进 AI 平台（ChatGPT、Claude 等）之前，先在**本机**把敏感信息（邮箱、手机号、IP、密钥等）按用户自定规则替换为占位符。**全程本地处理，零服务器、零上传、零统计。**

## 功能

- **站点拦截**：在 ChatGPT / Claude 等 AI 站点粘贴文本时，自动在粘贴前脱敏（预览确认 / 自动替换 / 仅提醒三种模式）。
- **12 个内置检测器**：邮箱、中国手机号、IPv4、身份证号、OpenAI / AWS / GitHub Token、JWT、私钥块、数据库连接串、Bearer Token 等。
- **自定义规则**：关键词、正则、内置检测器三类；支持固定替换 / 编号占位 / 掩码三种替换方式；同值一致（同一邮箱全文共用一个编号）。
- **工作台**：双栏实时脱敏、命中高亮、命中清单点击定位、文件导入（>500KB 走 Web Worker）、还原模式。
- **还原**：占位符可还原回原文（编号/固定模式可逆；掩码不可逆）。
- **本地优先**：无任何网络外发、无统计 SDK、不读 Cookie / 账号凭据，规则与文本永不离开浏览器。

## 安装

### 方式一：下载打包好的扩展（普通用户）

到 [Releases](https://github.com/K1ngfy/vesper/releases) 下载最新 `vesper-x.x.x-chrome.zip`，解压后在 `chrome://extensions` 打开"开发者模式" → "加载已解压的扩展程序" → 选解压目录。

### 方式二：从源码构建（开发者）

```bash
npm install
npm run dev        # 开发模式（自动打开浏览器加载未打包扩展）
npm run build      # 产出 .output/chrome-mv3（可加载 / 上传商店）
npm run zip        # 打包商店 zip
npm test           # Vitest 单测（引擎 / 检测器）
npm run compile    # TypeScript 类型检查
npm run e2e        # Playwright E2E（先 npm run build + npx playwright install chromium；需图形界面，CI 用 xvfb-run）
```

> E2E 使用 Playwright 自带 Chromium：品牌 Chrome 137+ 会屏蔽 `--load-extension`，
> 无法用于扩展自动化测试。

本地加载：`chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选择 `.output/chrome-mv3`。

## 架构

```
entrypoints/
├─ background.ts      快捷键、右键菜单、消息路由、站点 content script 动态注册
├─ content.ts         站点拦截入口（registration: 'runtime'，按站点授权动态生效）
├─ popup/             Popup（总开关 / 方案切换 / 站点状态 / 三入口）
├─ options/           配置页（方案管理 | 站点拦截 | 设置与数据）
├─ workbench/         工作台（双栏实时脱敏 / Diff 高亮 / 命中清单 / 文件导入 / 还原）
└─ sidepanel/         侧边栏（复用工作台组件）
src/
├─ core/              引擎（纯 TS 零浏览器依赖）：engine / detectors / restore / presets
├─ content/           paste 监听、insertText 回填、adapters/（generic·chatgpt·claude）、Shadow DOM UI
├─ storage/           chrome.storage.local 封装（禁用 sync）
├─ ui/                共享组件（工作台、规则编辑器、选项 Tab）
└─ i18n/              zh-CN 文案集中管理
tests/                Vitest 单测（含需求文档 fixture）
e2e/                  Playwright 扩展 E2E
```

## 关键设计决策

- **防二次替换**：替换产物先置入私用区令牌（`\uE000..\uE001`），全部规则执行完统一回填；替换回调遇令牌即跳过。
- **同值一致**：numbered 模式按规则维护 `原值→占位符` Map，同一邮箱全文共用一个编号。
- **顺序即优先级**：规则按数组顺序执行，具体规则在前、宽泛规则在后（默认方案已按此排序）。
- **最小权限（D5）**：manifest 不含任何默认主机权限；用户在配置页启用站点时按域名逐个申请（optional_host_permissions）。content script 由 background 用 `chrome.scripting` 运行时注册，停用即注销。
- **回填安全**：textarea/input 走原型链 native value setter + 冒泡 input 事件（React 受控组件可用）；contenteditable 走 `execCommand('insertText')`；失败兜底复制到剪贴板，任何情况下不让用户丢文本。
- **站点适配抗漂移**：选择器集中在 `src/content/adapters/`，只用语义 ID/稳定类名（`#prompt-textarea`、`.ProseMirror`）；识别不到自动降级 generic。

## 权限清单（备商店审核）

| 权限 | 用途 |
|---|---|
| `storage` | 用户方案/站点/设置保存到 `chrome.storage.local` |
| `contextMenus` | 右键「用 VESPER 脱敏选中文本」 |
| `sidePanel` | 侧边栏形态工作台 |
| `scripting` | 按已授权站点动态注册/注销 content script（最小权限的实现手段） |
| `activeTab` | Popup 显示当前标签页站点的拦截状态 |
| `optional_host_permissions` | 用户添加站点时按域名逐个申请，默认不申请任何主机权限 |

## 隐私声明

VESPER processes all text locally on your device. It collects, stores remotely, and
transmits no data. Your rules and texts never leave your browser.

代码库不含任何 `fetch` / `XHR` / `WebSocket` 外发调用与统计 SDK；不读 Cookie、不碰账号凭据、不使用 `chrome.storage.sync`。

## 配色

**极简黑白**（2026-10-25 重构）：背景 `#ffffff`，文本 `#111111`，次级文本 `#6b7280`，
边框 `#e5e5e5`，主色（按钮/强调/星号）`#111111` 黑。原"深空蓝 + 星芒橙"品牌色已弃用。
所有颜色集中在 `src/ui/global.css` 的 CSS 变量；改动只需调变量即可全局生效。

## 这个插件做不了什么 / 合规红线

- 还原功能只对 numbered / fixed 可逆规则生效，mask 模式不可逆（UI 已明示）。
- 只处理 `text/plain` 粘贴；不做截图脱敏、不做 AI 语义识别（NER）。
- 只在用户已启用并授权的站点上拦截粘贴事件；无命中时不干预任何默认行为。
- 不绕过付费墙、不批量构造请求、不对外分发任何用户数据。
- 用户正则是用户责任：保存前会试跑校验，编辑器有灾难性回溯风险提示，但无法完全杜绝。

## 图标说明

`public/icon/` 下 16/32/48/96/128/512 PNG 由 `logo.jpg` 生成；替换 logo 后重跑：

```bash
for sz in 16 32 48 96 128 512; do sips -s format png -z $sz $sz logo.jpg --out public/icon/$sz.png; done
```

## 贡献

欢迎提 Issue / PR。提交前请跑 `npm run lint && npm run compile && npm test`。

## 许可证

MIT License — 见 [LICENSE](./LICENSE)。
