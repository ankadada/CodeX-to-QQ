# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

## 0.2.1 - 2026-03-10

### Added

- bundled `.env.example` with all supported runtime options
- restart and uninstall service scripts for both `launchd` and `systemd --user`
- `/version` command for faster support and environment reporting
- `/confirm-action list` and `/confirm-action latest ...` recovery flow for risky-command confirmations
- session lifecycle commands: `/rename`, `/pin`, `/fork`, `/queue`, `/retry`
- workspace git workflow commands: `/repo`, `/branch`, `/diff`, `/commit`, `/rollback`
- artifact inspection/export commands: `/changed`, `/patch`, `/open`, `/export diff`
- reusable session-history utility module with tests
- adaptive `/help` output for text-only QQ sessions

### Improved

- `doctor` now reports version info, directory writability, and platform-aware service status
- local `npm run check` now validates shell scripts too
- session history now keeps titles, pin state, parent lineage, prompt previews, and answer previews
- quick-action keyboards now auto-detect unsupported QQ peers and quietly downgrade to plain text with timed re-probing
- `/status` and `/diag` now include more actionable next-step hints for text-only mode, queues, pending confirmations, and reconnect state
- confirmation previews no longer get consumed just by checking status/details
- each peer workspace now auto-seeds a local `.gitignore` so attachments stay out of commits by default

### Notes

- private QQ sessions now have a more complete text-only fallback, including numeric shortcut menus and `/help quick`
- image OCR is optional and currently best for screenshots / UI captures rather than ordinary photos

## 0.2.0 - 2026-03-09

Initial public-ready release.

### Added

- QQ C2C and group `@bot` support
- per-peer Codex session and workspace isolation
- progress, cancel, status, session, history, diagnostics, stats, and audit commands
- attachment download, image input forwarding, and text extraction
- context compaction and automatic session recovery
- queueing, global concurrency control, and proactive final replies
- quick-action keyboards for short control messages
- launchd support and Linux systemd user-service scripts
- doctor script, CI, and basic automated tests

### Improved

- friendlier Chinese UX for status / progress / cancellation
- more stable QQ gateway reconnect and heartbeat handling
- private-chat new-session flow
- audit and telemetry persistence

### Notes

- progress-card message retraction is disabled by default because QQ visibly shows recall notices
- `dangerous` mode remains intended for trusted self-hosted use only
