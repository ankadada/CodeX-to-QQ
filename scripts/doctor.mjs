#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDoctorSuggestions } from '../src/doctor-report.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const PACKAGE_JSON_FILE = path.join(ROOT, 'package.json');
const LOG_DIR = path.join(ROOT, 'logs');
const DATA_DIR = path.join(ROOT, 'data');

const QQBOT_APP_ID = String(process.env.QQBOT_APP_ID || '').trim();
const QQBOT_CLIENT_SECRET = String(process.env.QQBOT_CLIENT_SECRET || '').trim();
const CODEX_BIN = String(process.env.CODEX_BIN || 'codex').trim() || 'codex';
const WORKSPACE_ROOT = path.resolve(ROOT, String(process.env.WORKSPACE_ROOT || './workspaces').trim() || './workspaces');
const IMAGE_OCR_MODE = String(process.env.IMAGE_OCR_MODE || 'auto').trim().toLowerCase() || 'auto';
const OUTPUT_JSON = process.argv.includes('--json');

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
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.atou.codex-cli-qq.plist');
  if (!fs.existsSync(plistPath)) {
    return { ok: true, details: 'not installed (foreground mode is fine)' };
  }
  const status = runCommand('launchctl', ['print', label], { timeoutMs: 10000 });
  return status.ok
    ? { ok: true, details: 'installed and reachable' }
    : { ok: false, details: status.details };
}

function systemdStatus() {
  if (process.platform !== 'linux') return { ok: true, details: 'non-Linux host, skipped' };
  if (!commandExists('systemctl')) {
    return { ok: true, details: 'systemctl not found (foreground mode only)' };
  }
  const unitPath = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', 'codex-cli-qq.service');
  if (!fs.existsSync(unitPath)) {
    return { ok: true, details: 'not installed (foreground mode is fine)' };
  }
  const status = runCommand('systemctl', ['--user', 'is-enabled', 'codex-cli-qq.service'], { timeoutMs: 10000 });
  if (!status.ok) {
    return { ok: false, details: status.details };
  }
  return { ok: true, details: `installed (${status.details})` };
}

function serviceStatus() {
  if (process.platform === 'darwin') return launchdStatus();
  if (process.platform === 'linux') return systemdStatus();
  return { ok: true, details: 'service checks skipped on this platform' };
}

function commandExists(command) {
  const result = spawnSync(command, ['--help'], {
    env: buildSpawnEnv(process.env),
    stdio: 'ignore',
    timeout: 5000,
  });
  return !result.error;
}

function readPackageVersion() {
  try {
    const raw = fs.readFileSync(PACKAGE_JSON_FILE, 'utf8');
    const payload = JSON.parse(raw);
    return String(payload?.version || '').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function ensureWritableDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
    return { ok: true, details: dirPath };
  } catch (err) {
    return { ok: false, details: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const packageVersion = readPackageVersion();
  const workspaceStatus = ensureWritableDir(WORKSPACE_ROOT);
  const dataDirStatus = ensureWritableDir(DATA_DIR);
  const logDirStatus = ensureWritableDir(LOG_DIR);
  const stateFile = path.join(ROOT, 'data', 'state.json');

  pushCheck('CodeX-to-QQ version', packageVersion !== 'unknown', packageVersion);
  pushCheck('.env file', fs.existsSync(ENV_FILE), fs.existsSync(ENV_FILE) ? ENV_FILE : 'missing');
  pushCheck('.env / QQBOT_APP_ID', Boolean(QQBOT_APP_ID), QQBOT_APP_ID ? 'present' : 'missing');
  pushCheck('.env / QQBOT_CLIENT_SECRET', Boolean(QQBOT_CLIENT_SECRET), QQBOT_CLIENT_SECRET ? 'present' : 'missing');

  const codexVersion = runCommand(CODEX_BIN, ['--version']);
  pushCheck('Codex CLI binary', codexVersion.ok, codexVersion.details || CODEX_BIN);
  const gitVersion = runCommand('git', ['--version']);
  pushCheck('Git binary', gitVersion.ok, gitVersion.details || 'git');
  if (IMAGE_OCR_MODE !== 'off') {
    const visionScript = path.join(ROOT, 'scripts', 'ocr-image.swift');
    const hasVision = process.platform === 'darwin' && fs.existsSync('/usr/bin/swift') && fs.existsSync(visionScript);
    const tesseract = commandExists('tesseract');
    pushCheck('Image OCR backend', hasVision || tesseract, hasVision ? 'vision(swift)' : tesseract ? 'tesseract' : 'none found');
  } else {
    pushCheck('Image OCR backend', true, 'disabled by IMAGE_OCR_MODE=off');
  }

  pushCheck('State file', true, fs.existsSync(stateFile) ? stateFile : 'not created yet (appears after first successful start)');
  pushCheck('Workspace root', workspaceStatus.ok, workspaceStatus.details);
  pushCheck('Data dir', dataDirStatus.ok, dataDirStatus.details);
  pushCheck('Log dir', logDirStatus.ok, logDirStatus.details);

  const service = serviceStatus();
  pushCheck('Service integration', service.ok, service.details);

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
  const suggestions = buildDoctorSuggestions(checks, {
    platform: process.platform,
    imageOcrMode: IMAGE_OCR_MODE,
  });

  if (OUTPUT_JSON) {
    console.log(JSON.stringify({
      ok: failures.length === 0,
      summary,
      generatedAt: new Date().toISOString(),
      version: packageVersion,
      platform: `${process.platform} ${process.arch}`,
      imageOcrMode: IMAGE_OCR_MODE,
      checks,
      suggestions,
    }, null, 2));
  } else {
    console.log(`codex-cli-qq doctor: ${summary}`);
    for (const item of checks) {
      console.log(`${item.ok ? '✅' : '❌'} ${item.name}${item.details ? ` — ${item.details}` : ''}`);
    }
    if (suggestions.length > 0) {
      console.log('');
      console.log('Next steps:');
      for (const item of suggestions) {
        console.log(`- ${item}`);
      }
    }
  }

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('doctor crashed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
