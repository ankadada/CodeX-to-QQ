#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const QQBOT_APP_ID = String(process.env.QQBOT_APP_ID || '').trim();
const QQBOT_CLIENT_SECRET = String(process.env.QQBOT_CLIENT_SECRET || '').trim();
const CODEX_BIN = String(process.env.CODEX_BIN || 'codex').trim() || 'codex';

const checks = [];

function pushCheck(name, ok, details) {
  checks.push({ name, ok, details: String(details || '').trim() });
}

function buildSpawnEnv(env) {
  const out = { ...env };
  const delimiter = path.delimiter;
  const entries = String(out.PATH || '').split(delimiter).filter(Boolean);
  const extras = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  for (const entry of extras) {
    if (!entries.includes(entry)) entries.push(entry);
  }
  out.PATH = entries.join(delimiter);
  return out;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    env: buildSpawnEnv(process.env),
    encoding: 'utf8',
    timeout: options.timeoutMs || 20000,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.error) {
    return { ok: false, details: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      details: String(result.stderr || result.stdout || `exit=${result.status}`).trim(),
    };
  }
  return { ok: true, details: String(result.stdout || '').trim() };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

function launchdStatus() {
  if (process.platform !== 'darwin') return { ok: true, details: 'non-macOS host, skipped' };
  const label = `gui/${process.getuid()}/com.atou.codex-cli-qq`;
  return runCommand('launchctl', ['print', label], { timeoutMs: 10000 });
}

async function main() {
  pushCheck('.env / QQBOT_APP_ID', Boolean(QQBOT_APP_ID), QQBOT_APP_ID ? 'present' : 'missing');
  pushCheck('.env / QQBOT_CLIENT_SECRET', Boolean(QQBOT_CLIENT_SECRET), QQBOT_CLIENT_SECRET ? 'present' : 'missing');

  const codexVersion = runCommand(CODEX_BIN, ['--version']);
  pushCheck('Codex CLI binary', codexVersion.ok, codexVersion.details || CODEX_BIN);

  const stateFile = path.join(ROOT, 'data', 'state.json');
  pushCheck('State file', fs.existsSync(stateFile), stateFile);

  const launchd = launchdStatus();
  pushCheck('launchd service', launchd.ok, launchd.ok ? 'running or loadable' : launchd.details);

  if (QQBOT_APP_ID && QQBOT_CLIENT_SECRET) {
    try {
      const token = await fetchJson('https://bots.qq.com/app/getAppAccessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: QQBOT_APP_ID,
          clientSecret: QQBOT_CLIENT_SECRET,
        }),
      });
      pushCheck('QQ access token', Boolean(token?.access_token), token?.access_token ? 'ok' : JSON.stringify(token));

      if (token?.access_token) {
        const gateway = await fetchJson('https://api.sgroup.qq.com/gateway', {
          headers: {
            Authorization: `QQBot ${token.access_token}`,
          },
        });
        pushCheck('QQ gateway API', Boolean(gateway?.url), gateway?.url || JSON.stringify(gateway));
      }
    } catch (err) {
      pushCheck('QQ API', false, err instanceof Error ? err.message : String(err));
    }
  }

  const failures = checks.filter((item) => !item.ok);
  const summary = failures.length === 0 ? 'PASS' : 'FAIL';
  console.log(`codex-cli-qq doctor: ${summary}`);
  for (const item of checks) {
    console.log(`${item.ok ? '✅' : '❌'} ${item.name}${item.details ? ` — ${item.details}` : ''}`);
  }

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('doctor crashed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
