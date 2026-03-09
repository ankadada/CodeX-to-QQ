# Changelog

All notable changes to this project will be documented in this file.

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
