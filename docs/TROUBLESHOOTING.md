# Troubleshooting

This page focuses on the most common “it’s connected but not smooth yet” issues when self-hosting `CodeX-to-QQ`.

## Before opening an issue

Please collect:

```bash
npm run doctor
npm run doctor:json
npm run service:status
```

If the bot can still reply in QQ, also collect:

- `/status`
- `/diag`

Redact secrets, private message content, and sensitive paths before sharing anything publicly.

## The bot does not reply at all

Check these first:

1. `npm run doctor`
2. Are `QQBOT_APP_ID` and `QQBOT_CLIENT_SECRET` filled in?
3. Does `Codex CLI binary` pass in doctor output?
4. If you run as a service, does `npm run service:status` show it as running?

If doctor fails on QQ API:

- verify the bot credentials
- verify the bot is active on the QQ platform side
- verify the host can reach `https://bots.qq.com` and `https://api.sgroup.qq.com`

## The bot replies, but only in some chats

Possible reasons:

- the sender is not in `QQBOT_ALLOW_FROM`
- the group is not in `QQBOT_ALLOW_GROUPS`
- group support is disabled via `QQBOT_ENABLE_GROUP=false`
- in groups, you forgot to `@bot`

Use `/whoami` in the chat to inspect the current peer identifiers.

## QQ buttons do not show, or only some buttons show

That is expected on some QQ clients.

This project already degrades safely:

- unsupported custom keyboards auto-fallback to plain text
- you can use `/help quick`
- you can reply with numeric shortcuts such as `1`, `2`, `3`

If the fallback was triggered by QQ keyboard restrictions, this is usually not a service bug.

## I cannot find the dangerous-action confirmation anymore

Use:

```text
/confirm-action list
```

Or directly confirm the newest pending action:

```text
/confirm-action latest confirm
```

## Private chat keeps continuing the same session

That is by design.

Use:

- `/new` to start a fresh session
- `/sessions` to browse older sessions
- `/resume <id>` to switch back
- `/rename`, `/pin`, `/fork` to manage long-running work threads

## The QQ gateway reconnects often

Start with:

- `npm run doctor`
- `/diag`
- `npm run service:status`

Things to look at:

- unstable network on the host
- invalid / rotated QQ credentials
- repeated gateway session expiry
- background service restarts

The bridge already includes heartbeat ACK monitoring, reconnect backoff, and repeated-`4009` fresh-identify fallback.

## OCR does not seem to work

Check:

```bash
npm run doctor
```

If `IMAGE_OCR_MODE` is not `off`, doctor should show one of:

- `vision(swift)` on macOS
- `tesseract`

Notes:

- OCR is most useful for screenshots, UI captures, and error dialogs
- normal photos are intentionally treated more conservatively in `auto` mode
- if you do not need OCR, set `IMAGE_OCR_MODE=off`

## Service works, but foreground works better

Compare:

```bash
npm start
npm run service:status
```

Common reasons:

- stale service environment
- different `PATH`
- old `.env` values loaded before restart

After config changes, restart the service explicitly:

```bash
npm run service:restart
```

## What to include in a good bug report

- exact version or commit
- host OS and Node.js version
- whether you use foreground / `launchd` / `systemd`
- whether the issue is C2C-only, group-only, or both
- `npm run doctor` output
- `npm run doctor:json` output if possible
- `/diag` output if the bot is still reachable
- redacted logs and screenshots
