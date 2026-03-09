# Contributing

Thanks for helping improve `codex-cli-qq`.

## Environment

- Node.js `>=20`
- npm
- macOS for `launchd` scripts
- Linux with `systemd --user` if you want to test the Linux service path

Codex CLI and real QQ bot credentials are only required for full end-to-end testing.

## Quick Start

```bash
npm install
cp .env.example .env
npm run ci
```

If you want to test against the real QQ gateway:

```bash
npm run doctor
npm start
```

## Development Rules

- keep changes focused and small
- preserve existing `.env` compatibility when possible
- prefer adding options over breaking defaults
- update `README.md` / `.env.example` when behavior changes
- avoid committing secrets, logs, `data/`, or `workspaces/`

## Validation

Before opening a PR, run:

```bash
npm run ci
```

If you changed service scripts, also run shell syntax checks:

```bash
bash -n scripts/*.sh
```

If you changed QQ gateway behavior and have credentials available:

```bash
npm run doctor
```

## Pull Request Notes

Please include:

- what changed
- why it changed
- user-visible impact
- validation performed
- screenshots or message samples if the UX changed

## Good First Contributions

- command UX polish
- better diagnostics / audit formatting
- README and FAQ improvements
- Linux support refinements
- test coverage for command parsing and session behavior
