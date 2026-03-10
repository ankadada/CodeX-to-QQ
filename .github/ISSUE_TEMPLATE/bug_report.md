---
name: Bug report
about: Report a reproducible bug
title: "[Bug] "
labels: bug
assignees: ""
---

## Summary

Describe the problem in 1-3 sentences.

## Environment

- OS:
- Node version:
- Codex CLI version:
- Deployment mode: `launchd` / `systemd` / foreground
- QQ mode: `c2c` / `group`
- Project version / commit:

## Reproduction

1.
2.
3.

## Expected

What should have happened?

## Actual

What happened instead?

## Logs / Screenshots

Paste only redacted logs and screenshots.

## Diagnostics

Please include, when possible:

- `npm run doctor`
- `npm run doctor:json`
- `npm run service:status`
- `/diag` output (if the bot can still reply)

Do **not** include:

- `.env`
- `QQBOT_CLIENT_SECRET`
- private message content you do not want public
- full workspace paths if they reveal sensitive information
