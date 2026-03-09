# Security Policy

`codex-cli-qq` is a self-hosted bridge that can execute Codex CLI tasks, download attachments, and optionally run in `dangerous` mode. Treat it like a remote shell helper, not a casual toy bot.

## Supported Versions

Security fixes are best-effort for:

- the latest `main` branch
- the latest tagged release

Older snapshots may not receive patches.

## Reporting a Vulnerability

Please avoid posting unpatched vulnerabilities, secrets, or exploit details in public issues.

When reporting:

- include the affected version / commit
- include reproduction steps
- redact all secrets, tokens, message IDs, user IDs, and workspace paths unless strictly required
- state whether `dangerous` mode, attachment download, or group access is enabled

If you publish this project in your own repository, configure a private security contact channel before inviting outside users.

## Security Boundaries

This project intentionally crosses multiple trust boundaries:

- QQ messages can trigger Codex CLI runs
- attachments can be downloaded to local disk
- Codex can read/write workspace files
- `dangerous` mode bypasses sandbox / approval prompts inside Codex

Because of that:

- do not run this service for untrusted users unless you understand the risk
- do not reuse an existing production bot credential set
- do not share a `dangerous` deployment with a broad user base
- do not run it as `root`

## Recommended Safe Defaults

For public or shared deployments, prefer:

- `DEFAULT_MODE=safe`
- strict `QQBOT_ALLOW_FROM`
- strict `QQBOT_ALLOW_GROUPS`
- `DOWNLOAD_ATTACHMENTS=true` only if you trust senders
- dedicated service account / host / workspace root
- periodic cleanup of `workspaces/`, `logs/`, and `data/`

For private self-use on your own machine, `dangerous` mode can be reasonable, but it is still your responsibility.

## Secret Handling

Never commit:

- `.env`
- `data/`
- `workspaces/`
- raw logs containing tokens or private content

Rotate credentials immediately if:

- `QQBOT_CLIENT_SECRET` is exposed
- logs or screenshots reveal session identifiers or sensitive content
- you accidentally publish your private `.env`

## Known Risk Areas

Review these areas carefully before wider deployment:

- attachment download and text extraction
- long-running service permissions
- command aliases that trigger session or mode changes
- audit logs containing message content summaries
- any use of `dangerous` mode on shared infrastructure
