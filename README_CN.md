# CodeX-to-QQ

[![CI](https://github.com/ankadada/CodeX-to-QQ/actions/workflows/ci.yml/badge.svg)](https://github.com/ankadada/CodeX-to-QQ/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/ankadada/CodeX-to-QQ)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3C873A)](https://nodejs.org/)
[![Release](https://img.shields.io/github/v/release/ankadada/CodeX-to-QQ?sort=semver)](https://github.com/ankadada/CodeX-to-QQ/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-111827)](./README_CN.md#支持平台)

[English](./README.md) · [安全说明](./SECURITY.md) · [贡献指南](./CONTRIBUTING.md) · [更新记录](./CHANGELOG.md)

![CodeX-to-QQ Logo](./docs/assets/logo.svg)

这是一个自建的 `QQ -> Codex CLI` 桥接服务，适合把 Codex 接进 QQ 单聊或群聊 `@bot` 工作流里使用。

它的目标不是一次性 demo，而是做成一个适合长期运行的桥接层：会话、工作区、进展反馈、附件处理、后台服务、诊断与审计都尽量补齐。

## 核心特性

- 独立 QQ Bot 凭证和独立 `.env`
- 支持 QQ 单聊 C2C 与群聊 `@bot`
- 每个 QQ 会话独立 Codex session / workspace
- 支持 `/status`、`/progress`、`/queue`、`/retry`、`/stop`、`/new`、`/sessions`、`/rename`、`/pin`、`/fork`、`/workspace`、`/repo`、`/changed`、`/patch`、`/open`、`/export`、`/branch`、`/diff`、`/commit`、`/rollback`、`/version`
- 支持处理中的进展更新、排队、取消、自愈重试
- 支持附件下载、图片输入、文档文本抽取、可选图片 OCR
- 支持上下文压缩、旧 session 自动恢复
- 支持短控制消息快捷按钮、纯文本模式下的数字快捷菜单，以及危险命令确认流
- 支持 macOS `launchd` 与 Linux `systemd --user`

## 截图

### 聊天体验

![聊天体验](./docs/assets/hero-chat.svg)

### 会话 / 诊断 / Profile

![会话与诊断](./docs/assets/session-tools.svg)

## 适用场景

适合：

- 个人自建使用
- 小范围可信团队内部使用
- 已经在本机或自有主机运行 Codex CLI 的用户

不太适合直接裸跑的场景：

- 面向陌生用户的大范围开放
- 开启 `dangerous` 模式后给多人共用
- 对附件下载、文件修改极度敏感的主机环境

## 风险提示

这个项目可以：

- 触发 Codex CLI 执行任务
- 下载附件到本地
- 让 Codex 读写 workspace 文件
- 在 `dangerous` 模式下更自由地执行

如果你不是纯自用，请先读 [`SECURITY.md`](./SECURITY.md)。

## 支持平台

- macOS：前台运行 + `launchd`
- Linux：前台运行 + `systemd --user`
- Windows：暂未正式支持

## 环境要求

- Node.js `>=20`
- npm
- 已安装 Codex CLI，并能通过 `PATH` 或 `CODEX_BIN` 找到
- 一个独立的 QQ Bot `AppID / ClientSecret`

## 快速开始

1. 复制配置：

```bash
cp .env.example .env
```

仓库自带的 `.env.example` 已把所有支持的运行参数都列出来了，直接按需改值即可。

2. 填入你自己的 QQ Bot 凭证：

- `QQBOT_APP_ID`
- `QQBOT_CLIENT_SECRET`

3. 安装依赖：

```bash
npm install
```

4. 运行检查：

```bash
npm run ci
npm run doctor
```

5. 前台启动：

```bash
npm start
```

6. 或直接安装成后台服务：

```bash
npm run install:service
npm run service:status
```

7. 常用服务生命周期命令：

```bash
npm run service:restart
npm run uninstall:service
```

## 长期运行

### macOS (`launchd`)

```bash
npm run install:launchd
npm run service:status:launchd
npm run service:restart:launchd
npm run uninstall:launchd
```

### Linux (`systemd --user`)

```bash
npm run install:systemd
npm run service:status:systemd
npm run service:restart:systemd
npm run uninstall:systemd
```

### 查看日志

```bash
npm run logs
```

Linux 下也可以直接：

```bash
journalctl --user -u codex-cli-qq.service -f
```

## 命令列表

- 直接发普通消息：交给 Codex 处理
- `/help`
- `/help quick`
- `/whoami`
- `/status`
- `/state`
- `/diag`
- `/doctor`
- `/version`
- `/stats`
- `/audit`
- `/session`
- `/sessions`
- `/rename <标题>`
- `/pin [session_id|clear]`
- `/fork [source_session_id] [标题]`
- `/history`
- `/new`
- `/start`
- `/files`
- `/workspace [show|recent|set <path|index>|reset]`
- `/repo [status|log|path]`
- `/changed`
- `/patch [file]`
- `/open <file>`
- `/export diff [working|staged|all]`
- `/branch [name]`
- `/diff [working|staged|all]`
- `/commit <message>`
- `/rollback [tracked|all]`
- `/progress`
- `/queue`
- `/cancel`
- `/stop`
- `/retry`
- `/reset`
- `/resume <session_id|clear>`
- `/confirm-action list`
- `/profile default|code|docs|review|image`
- `/mode safe`
- `/mode dangerous`
- `/model <name|default>`
- `/effort low|medium|high|default`

## 常用场景

- **先快速上手**
  - 发 `/help quick`
  - 再直接发一句普通话，让 Codex 开始工作
- **继续上一个任务**
  - 直接继续发消息
  - 如果要重跑刚才那次，发 `/retry`
- **切回旧会话**
  - 发 `/sessions`
  - 直接回数字，或用 `/resume <编号|id>`
- **切到另一个项目目录**
  - 发 `/workspace recent`
  - 直接回数字，或用 `/workspace set demo`
- **检查改动**
  - 发 `/changed`
  - 再用 `/diff`、`/open <文件>`、`/patch`
- **高风险操作**
  - 例如 `/rollback all`、`/mode dangerous`
  - 系统会先要求你确认，若提示刷走了可发 `/confirm-action list`

## 推荐配置

- `QQBOT_ALLOW_FROM=*`：仅在你明确知道谁能私聊你 bot 时再放开
- `QQBOT_ALLOW_GROUPS=`：群聊建议做白名单
- `QQBOT_ENABLE_GROUP=true`：开启群聊 `@bot`
- `DEFAULT_MODE=dangerous`：适合你自己完全信任的自建环境
- `SHOW_REASONING=false`：避免长输出刷屏
- `DOWNLOAD_ATTACHMENTS=true`：让 Codex 直接读附件
- `EXTRACT_ATTACHMENT_TEXT=true`：更适合“总结这个文件”这类场景
- `MAX_GLOBAL_ACTIVE_RUNS=2`：避免机器被打满
- `COMPACT_CONTEXT_ON_THRESHOLD=true`：上下文过长时先压缩再续聊
- `SEND_ACK_ON_RECEIVE=true`：收到消息先给确认
- `PROACTIVE_FINAL_REPLY_AFTER_MS=30000`：慢任务优先主动补发最终结果
- `AUTO_PROGRESS_PING_MS=15000`：处理中周期性进展
- `MAX_AUTO_PROGRESS_PINGS=2`：限制自动进展次数
- `PHASE_PROGRESS_NOTIFY=true`：关键阶段主动回报
- `ENABLE_QUICK_ACTIONS=true`：短消息附带快捷按钮
- `QUICK_ACTION_RETRY_MS=21600000`：如果某个 QQ 会话不支持自定义按钮，会自动降级成纯文本，并在稍后自动重试
- `TEXT_SHORTCUT_TTL_MS=600000`：纯文本数字快捷菜单保留时长
- `PENDING_ACTION_TTL_MS=600000`：危险操作确认菜单保留时长
- `RETRACT_PROGRESS_MESSAGES=false`：默认建议关闭，QQ 会明显提示撤回
- `DELIVERY_AUDIT_MAX=120`：保留最近审计记录
- `QQ_API_TIMEOUT_MS=15000`：QQ API 请求超时
- `QQ_DOWNLOAD_TIMEOUT_MS=30000`：附件下载超时
- `IMAGE_OCR_MODE=auto`：图片 OCR（`auto` / `on` / `off`），`auto` 更偏向截图/界面图
- `MAX_IMAGE_OCR_CHARS_PER_FILE=1200`：单张图片最多注入多少 OCR 文本

## 体验说明

- 私聊里可以用 `/new` 主动开新会话
- `/sessions` + `/resume <编号|id>` 可以切回旧会话
- `/rename`、`/pin`、`/fork` 可以把常用会话当成长期工作线程来管理
- `/queue` 可查看运行中和排队中的任务，`/retry` 可以重试最近一次已执行请求
- `/workspace set demo` 可快速切到 `WORKSPACE_ROOT/demo`，也可以直接设置绝对路径绑定现有项目
- `/workspace recent` 可列出最近路径，直接回数字即可切换
- 每个 workspace 同时也是一个轻量 Git 仓库，所以可以直接在 QQ 里用 `/repo`、`/branch`、`/diff`、`/commit`、`/rollback`
- `/changed`、`/patch`、`/open`、`/export diff` 让你能直接在 QQ 里查看和导出实际产物
- `/rollback all`、`/mode dangerous` 这类高风险操作现在会先要求确认
- 忘了刚才的确认提示也没关系，发 `/confirm-action list` 就能找回，`/confirm-action latest confirm` 可直接处理最新一条
- 如果 QQ 当前会话不支持自定义按钮，系统会自动降级为纯文本，避免重复报错但仍正常回复
- `/help` 会根据当前会话是否为纯文本模式，自动切成更适合 QQ 手打的短命令菜单，并附带可直接回复的数字快捷项；也可以直接发 `/help quick`
- 图片在作为图像输入交给 Codex 之外，还可以额外抽取 OCR 文本；`auto` 模式更偏向截图/报错界面，避免普通照片过度注入文本
- QQ 客户端对按钮展示会有端差异
- 进展消息撤回默认关闭，因为 QQ 的撤回提示通常比保留旧消息更烦

## 运行时文件

这些都不会进 git：

- `.env`
- `logs/`
- `data/`
- `workspaces/`

附件默认会落到：

```text
workspaces/<peer>/.attachments/<messageId>/
```

## 常见问题

### 为什么按钮有时显示不全？

QQ 客户端在不同平台、不同宽度下会裁剪或折叠按钮。这个项目已经尽量按移动端友好的多行布局来做，但显示仍取决于 QQ 客户端。

### 为什么默认不撤回进展消息？

因为 QQ 会明显显示“对方撤回了一条消息”，实际体验通常更差。

### `dangerous` 模式能不能开？

能，但建议仅限你自己或可信环境使用，不要直接面向陌生人开放。

### 为什么强调要用独立 QQ Bot？

为了减少凭证混用、权限混乱，以及后续轮换或吊销凭证时的影响范围。

## 开发与贡献

见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 安全说明

见 [`SECURITY.md`](./SECURITY.md)。

## 更新记录

见 [`CHANGELOG.md`](./CHANGELOG.md)。

## 许可证

[MIT](./LICENSE)
