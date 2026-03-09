# CodeX-to-QQ

[![CI](https://github.com/ankadada/CodeX-to-QQ/actions/workflows/ci.yml/badge.svg)](https://github.com/ankadada/CodeX-to-QQ/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/ankadada/CodeX-to-QQ)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3C873A)](https://nodejs.org/)
[![Release](https://img.shields.io/badge/release-v0.2.0-2563EB)](./docs/releases/v0.2.0.md)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-111827)](./README_CN.md#支持平台)

[English](./README.md) · [安全说明](./SECURITY.md) · [贡献指南](./CONTRIBUTING.md) · [更新记录](./CHANGELOG.md)

![CodeX-to-QQ Logo](./docs/assets/logo.svg)

这是一个自建的 `QQ -> Codex CLI` 桥接服务，适合把 Codex 接进 QQ 单聊或群聊 `@bot` 工作流里使用。

它的目标不是一次性 demo，而是做成一个适合长期运行的桥接层：会话、工作区、进展反馈、附件处理、后台服务、诊断与审计都尽量补齐。

## 核心特性

- 独立 QQ Bot 凭证和独立 `.env`
- 支持 QQ 单聊 C2C 与群聊 `@bot`
- 每个 QQ 会话独立 Codex session / workspace
- 支持 `/status`、`/progress`、`/stop`、`/new`、`/sessions`
- 支持处理中的进展更新、排队、取消、自愈重试
- 支持附件下载、图片输入、文档文本抽取
- 支持上下文压缩、旧 session 自动恢复
- 支持短控制消息快捷按钮
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

## 长期运行

### macOS (`launchd`)

```bash
npm run install:launchd
npm run service:status:launchd
```

### Linux (`systemd --user`)

```bash
npm run install:systemd
npm run service:status:systemd
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
- `/whoami`
- `/status`
- `/state`
- `/diag`
- `/stats`
- `/audit`
- `/session`
- `/sessions`
- `/history`
- `/new`
- `/start`
- `/files`
- `/progress`
- `/cancel`
- `/stop`
- `/reset`
- `/resume <session_id|clear>`
- `/profile default|code|docs|review|image`
- `/mode safe`
- `/mode dangerous`
- `/model <name|default>`
- `/effort low|medium|high|default`

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
- `RETRACT_PROGRESS_MESSAGES=false`：默认建议关闭，QQ 会明显提示撤回
- `DELIVERY_AUDIT_MAX=120`：保留最近审计记录

## 体验说明

- 私聊里可以用 `/new` 主动开新会话
- `/sessions` + `/resume <id>` 可以切回旧会话
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
