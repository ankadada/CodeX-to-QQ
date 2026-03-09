# CodeX-to-QQ

[![CI](https://github.com/ankadada/CodeX-to-QQ/actions/workflows/ci.yml/badge.svg)](https://github.com/ankadada/CodeX-to-QQ/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/ankadada/CodeX-to-QQ)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3C873A)](https://nodejs.org/)
[![Release](https://img.shields.io/badge/release-v0.2.0-2563EB)](./docs/releases/v0.2.0.md)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-111827)](./README.md#supported-platforms)

[中文说明](./README_CN.md) · [Security](./SECURITY.md) · [Contributing](./CONTRIBUTING.md) · [Changelog](./CHANGELOG.md)

Self-hosted `QQ -> Codex CLI` bridge for private chat and group `@bot` workflows.

It is designed for people who want to talk to Codex from QQ while keeping sessions, workspaces, long-running service behavior, and attachment handling under their own control.

## Highlights

- independent QQ bot credentials and `.env`
- QQ C2C and group `@bot` support
- per-peer Codex session and workspace isolation
- `/status`, `/progress`, `/stop`, `/new`, `/sessions`, `/diag`, `/stats`, `/audit`
- progress updates, queueing, cancellation, and session recovery
- attachment download, image input forwarding, and text extraction
- context compaction and retry-on-stale-session behavior
- quick-action keyboards for short control messages
- launchd support on macOS and systemd user-service support on Linux

## Screenshots

### Chat UX

![Chat UX](./docs/assets/hero-chat.svg)

### Session / Diagnostics / Profiles

![Session / Diagnostics / Profiles](./docs/assets/session-tools.svg)

## Who this is for

Good fit:

- personal self-hosted use
- trusted small-team internal use
- power users who already run Codex CLI locally

Not a great fit without extra hardening:

- broad public multi-user deployments
- untrusted users with `dangerous` mode enabled
- hosts where downloaded attachments or generated file edits are unacceptable

## Safety Notes

This project can:

- execute Codex CLI tasks
- download attachments to local disk
- let Codex read/write workspace files
- run in `dangerous` mode

If you are exposing it beyond yourself, read [`SECURITY.md`](SECURITY.md) first.

## Supported Platforms

- macOS: foreground run + `launchd`
- Linux: foreground run + `systemd --user`
- Windows: not officially supported yet

## Requirements

- Node.js `>=20`
- npm
- Codex CLI installed and available on `PATH` or via `CODEX_BIN`
- a dedicated QQ bot AppID / ClientSecret

## Quick Start

1. Copy config:

```bash
cp .env.example .env
```

2. Fill in your dedicated QQ bot credentials:

- `QQBOT_APP_ID`
- `QQBOT_CLIENT_SECRET`

3. Install dependencies:

```bash
npm install
```

4. Run checks:

```bash
npm run ci
npm run doctor
```

5. Start in foreground:

```bash
npm start
```

6. Or install as a long-running service for the current OS:

```bash
npm run install:service
npm run service:status
```

## Long-Running Service

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

### Logs

Foreground / macOS:

```bash
npm run logs
```

Linux systemd:

```bash
journalctl --user -u codex-cli-qq.service -f
```

## Commands

- send a normal message: hand it to Codex
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

## Recommended Defaults

- `QQBOT_ALLOW_FROM=*`: allow all direct-message senders only if you trust the host/user scope
- `QQBOT_ALLOW_GROUPS=`: leave empty for all groups, or set explicit allowlist values
- `QQBOT_ENABLE_GROUP=true`: enable group `@bot`
- `DEFAULT_MODE=dangerous`: convenient for personal-only trusted use
- `SHOW_REASONING=false`: avoid flooding QQ
- `DOWNLOAD_ATTACHMENTS=true`: let Codex read downloaded files directly
- `EXTRACT_ATTACHMENT_TEXT=true`: improve “summarize this document” style prompts
- `MAX_GLOBAL_ACTIVE_RUNS=2`: avoid saturating the machine
- `COMPACT_CONTEXT_ON_THRESHOLD=true`: summarize before forcing a hard reset
- `SEND_ACK_ON_RECEIVE=true`: confirm receipt quickly
- `PROACTIVE_FINAL_REPLY_AFTER_MS=30000`: switch to proactive reply for slow tasks
- `AUTO_PROGRESS_PING_MS=15000`: periodic progress updates
- `MAX_AUTO_PROGRESS_PINGS=2`: cap periodic progress messages
- `PHASE_PROGRESS_NOTIFY=true`: send milestone progress updates in private chat
- `ENABLE_QUICK_ACTIONS=true`: attach quick-action keyboards to short control messages
- `RETRACT_PROGRESS_MESSAGES=false`: recommended; QQ visibly shows recall notices
- `DELIVERY_AUDIT_MAX=120`: keep recent delivery/run audit entries

## UX Notes

- private chat can proactively open a fresh session with `/new`
- `/sessions` + `/resume <id>` lets you jump back to older sessions
- quick-action keyboards are optimized for QQ mobile layout, but client rendering can still vary
- progress recall is disabled by default because QQ shows a visible “message recalled” notice

## Files and Data

Runtime-generated files are intentionally ignored by git:

- `.env`
- `logs/`
- `data/`
- `workspaces/`

Downloaded attachments are stored under:

```text
workspaces/<peer>/.attachments/<messageId>/
```

## FAQ

### Why are some buttons not fully visible?

QQ client layouts vary by platform and viewport width. This project uses a mobile-friendlier multi-row layout, but QQ may still compress or hide parts of the keyboard depending on the client.

### Why is progress recall disabled by default?

Because QQ shows an explicit recall notice, which usually feels noisier than simply leaving the old progress message in place.

### Can I use `dangerous` mode?

Yes, but it is intended for trusted self-hosted use. Do not share a `dangerous` deployment with untrusted users.

### Why use a dedicated QQ bot?

To avoid credential confusion, isolate permissions, and reduce blast radius if you rotate or revoke secrets.

### Why does the project keep `data/` and `workspaces/` locally?

They store session state, audit history, downloaded attachments, and per-peer workspaces so Codex can continue context-aware work across chats.

## Development

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security

See [`SECURITY.md`](SECURITY.md).

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md).

## License

[MIT](LICENSE)
