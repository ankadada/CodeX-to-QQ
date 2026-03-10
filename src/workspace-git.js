import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const IGNORE_MARKER = '# CodeX-to-QQ workspace ignores';
const IGNORE_BLOCK = [
  IGNORE_MARKER,
  '.attachments/',
  '.exports/',
  '.DS_Store',
];

export function ensureWorkspaceGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });

  const inside = runGit(dir, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  const initialized = !inside.ok;
  if (initialized) {
    const init = runGit(dir, ['init'], { allowFailure: true });
    if (!init.ok) {
      return { ok: false, initialized: false, gitignoreUpdated: false, error: init.error };
    }
  }

  const gitignoreUpdated = ensureWorkspaceGitignore(dir);
  return { ok: true, initialized, gitignoreUpdated };
}

export function getRepoStatus(dir) {
  const boot = ensureWorkspaceGitRepo(dir);
  if (!boot.ok) return { ok: false, error: boot.error };

  const porcelain = runGit(dir, ['status', '--porcelain=v1', '--branch'], { allowFailure: true });
  if (!porcelain.ok) return { ok: false, error: porcelain.error };

  const lines = splitLines(porcelain.stdout);
  const branchInfo = parseBranchLine(lines[0] || '');
  const entries = lines.slice(1)
    .map(parseStatusEntry)
    .filter(Boolean);
  const head = runGit(dir, ['rev-parse', '--short', 'HEAD'], { allowFailure: true });
  const lastCommit = runGit(dir, ['log', '-1', '--pretty=format:%h%x09%s%x09%cI'], { allowFailure: true });
  const branches = listBranches(dir);

  return {
    ok: true,
    ...branchInfo,
    headShort: head.ok ? head.stdout.trim() : null,
    lastCommit: parseLastCommit(lastCommit.ok ? lastCommit.stdout : ''),
    entries,
    clean: entries.length === 0,
    counts: summarizeStatusEntries(entries),
    branches: branches.ok ? branches.branches : [],
    initialized: boot.initialized,
    gitignoreUpdated: boot.gitignoreUpdated,
  };
}

export function listBranches(dir) {
  const boot = ensureWorkspaceGitRepo(dir);
  if (!boot.ok) return { ok: false, error: boot.error };

  const result = runGit(dir, ['branch', '--list', '--format=%(HEAD)|%(refname:short)'], { allowFailure: true });
  if (!result.ok) return { ok: false, error: result.error };

  const branches = splitLines(result.stdout)
    .map((line) => {
      const [headMarker, ...rest] = line.split('|');
      const name = rest.join('|').trim();
      if (!name) return null;
      return {
        name,
        current: String(headMarker || '').trim() === '*',
      };
    })
    .filter(Boolean)
    .sort((left, right) => Number(right.current) - Number(left.current) || left.name.localeCompare(right.name));

  return { ok: true, branches };
}

export function switchBranch(dir, rawName) {
  const boot = ensureWorkspaceGitRepo(dir);
  if (!boot.ok) return { ok: false, error: boot.error };

  const input = String(rawName || '').trim();
  if (!input) return { ok: false, error: 'branch name required' };

  if (input === '-') {
    const checkout = runGit(dir, ['checkout', '-'], { allowFailure: true });
    if (!checkout.ok) return { ok: false, error: checkout.error };
    const status = getRepoStatus(dir);
    return {
      ok: true,
      branch: status.ok ? status.branch : '',
      created: false,
      sanitized: false,
    };
  }

  const sanitized = sanitizeBranchName(input);
  const candidate = sanitized || input;
  const valid = runGit(dir, ['check-ref-format', '--branch', candidate], { allowFailure: true });
  if (!valid.ok) {
    return { ok: false, error: `invalid branch name: ${input}` };
  }

  const branches = listBranches(dir);
  if (!branches.ok) return { ok: false, error: branches.error };
  const exists = branches.branches.some((item) => item.name === candidate);
  const checkout = runGit(dir, exists ? ['checkout', candidate] : ['checkout', '-b', candidate], { allowFailure: true });
  if (!checkout.ok) return { ok: false, error: checkout.error };

  return {
    ok: true,
    branch: candidate,
    created: !exists,
    sanitized: candidate !== input,
  };
}

export function getDiffReport(dir, mode = 'all', maxPatchChars = 1800) {
  const status = getRepoStatus(dir);
  if (!status.ok) return { ok: false, error: status.error };

  const includeWorking = mode === 'all' || mode === 'working';
  const includeStaged = mode === 'all' || mode === 'staged';

  const workingStat = includeWorking ? runGit(dir, ['diff', '--stat', '--no-ext-diff'], { allowFailure: true }) : null;
  const stagedStat = includeStaged ? runGit(dir, ['diff', '--cached', '--stat', '--no-ext-diff'], { allowFailure: true }) : null;
  const workingPatch = includeWorking ? runGit(dir, ['diff', '--unified=1', '--no-ext-diff'], { allowFailure: true }) : null;
  const stagedPatch = includeStaged ? runGit(dir, ['diff', '--cached', '--unified=1', '--no-ext-diff'], { allowFailure: true }) : null;

  return {
    ok: true,
    status,
    workingStat: workingStat?.ok ? trimTrailingNewlines(workingStat.stdout) : '',
    stagedStat: stagedStat?.ok ? trimTrailingNewlines(stagedStat.stdout) : '',
    workingPatch: truncatePatch(workingPatch?.ok ? workingPatch.stdout : '', maxPatchChars),
    stagedPatch: truncatePatch(stagedPatch?.ok ? stagedPatch.stdout : '', maxPatchChars),
  };
}

export function commitWorkspace(dir, message) {
  const boot = ensureWorkspaceGitRepo(dir);
  if (!boot.ok) return { ok: false, error: boot.error };

  const commitMessage = String(message || '').trim();
  if (!commitMessage) return { ok: false, error: 'commit message required' };

  const add = runGit(dir, ['add', '-A'], { allowFailure: true });
  if (!add.ok) return { ok: false, error: add.error };

  const pending = runGit(dir, ['diff', '--cached', '--name-only'], { allowFailure: true });
  if (!pending.ok) return { ok: false, error: pending.error };
  const stagedFiles = splitLines(pending.stdout);
  if (stagedFiles.length === 0) {
    return { ok: false, noChanges: true, error: 'no staged changes to commit' };
  }

  const commit = runGit(dir, [...buildCommitIdentityArgs(dir), 'commit', '-m', commitMessage], { allowFailure: true });
  if (!commit.ok) return { ok: false, error: commit.error };

  const head = runGit(dir, ['rev-parse', '--short', 'HEAD'], { allowFailure: true });
  const branch = runGit(dir, ['branch', '--show-current'], { allowFailure: true });
  return {
    ok: true,
    hash: head.ok ? head.stdout.trim() : '',
    branch: branch.ok ? branch.stdout.trim() : '',
    stagedFiles,
    summary: splitLines(commit.stdout)[0] || '',
  };
}

export function rollbackWorkspace(dir, mode = 'tracked') {
  const boot = ensureWorkspaceGitRepo(dir);
  if (!boot.ok) return { ok: false, error: boot.error };

  const headExists = hasHeadCommit(dir);
  if (headExists) {
    const reset = runGit(dir, ['reset', '--mixed', 'HEAD'], { allowFailure: true });
    if (!reset.ok) return { ok: false, error: reset.error };
    const restore = runGit(dir, ['restore', '--staged', '--worktree', '--source=HEAD', '--', '.'], { allowFailure: true });
    if (!restore.ok) return { ok: false, error: restore.error };
  } else {
    const reset = runGit(dir, ['reset'], { allowFailure: true });
    if (!reset.ok) return { ok: false, error: reset.error };
  }

  if (mode === 'all') {
    const clean = runGit(dir, ['clean', '-fd', '-e', '.attachments'], { allowFailure: true });
    if (!clean.ok) return { ok: false, error: clean.error };
  }

  return {
    ok: true,
    mode,
    status: getRepoStatus(dir),
  };
}

export function getRepoLog(dir, limit = 5) {
  const boot = ensureWorkspaceGitRepo(dir);
  if (!boot.ok) return { ok: false, error: boot.error };
  if (!hasHeadCommit(dir)) return { ok: true, commits: [] };

  const result = runGit(dir, ['log', `-n${Math.max(1, limit)}`, '--pretty=format:%h%x09%s%x09%cI'], { allowFailure: true });
  if (!result.ok) return { ok: false, error: result.error };

  return {
    ok: true,
    commits: splitLines(result.stdout)
      .map(parseLastCommit)
      .filter(Boolean),
  };
}

function ensureWorkspaceGitignore(dir) {
  const filePath = path.join(dir, '.gitignore');
  const nextBlock = `${IGNORE_BLOCK.join('\n')}\n`;
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  if (current.includes(IGNORE_MARKER)) return false;
  const body = current.trimEnd();
  const next = body ? `${body}\n\n${nextBlock}` : nextBlock;
  fs.writeFileSync(filePath, next);
  return true;
}

function hasHeadCommit(dir) {
  const result = runGit(dir, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  return result.ok;
}

function buildCommitIdentityArgs(dir) {
  const hasName = runGit(dir, ['config', 'user.name'], { allowFailure: true });
  const hasEmail = runGit(dir, ['config', 'user.email'], { allowFailure: true });
  if (hasName.ok && hasName.stdout.trim() && hasEmail.ok && hasEmail.stdout.trim()) {
    return [];
  }
  return [
    '-c', 'user.name=CodeX-to-QQ',
    '-c', 'user.email=codex-to-qq@local',
  ];
}

function runGit(dir, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  if (result.status === 0) {
    return { ok: true, stdout, stderr, status: result.status };
  }
  return {
    ok: false,
    stdout,
    stderr,
    status: result.status,
    error: String(stderr || stdout || result.error?.message || `git ${args.join(' ')} failed`).trim(),
  };
}

function splitLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean);
}

function parseBranchLine(line) {
  const input = String(line || '').trim();
  if (!input.startsWith('## ')) {
    return {
      branch: '(unknown)',
      upstream: '',
      ahead: 0,
      behind: 0,
      detached: false,
      unborn: false,
    };
  }
  const body = input.slice(3);
  if (body.startsWith('No commits yet on ')) {
    return {
      branch: body.slice('No commits yet on '.length).trim(),
      upstream: '',
      ahead: 0,
      behind: 0,
      detached: false,
      unborn: true,
    };
  }
  if (body.startsWith('HEAD ')) {
    return {
      branch: 'HEAD',
      upstream: '',
      ahead: 0,
      behind: 0,
      detached: true,
      unborn: false,
    };
  }

  const [left, bracket = ''] = body.split(' [');
  const [branch, upstream = ''] = left.split('...');
  const markers = bracket.replace(/]$/, '');
  const ahead = extractCount(markers, /ahead (\d+)/);
  const behind = extractCount(markers, /behind (\d+)/);
  return {
    branch: branch.trim(),
    upstream: upstream.trim(),
    ahead,
    behind,
    detached: false,
    unborn: false,
  };
}

function parseStatusEntry(line) {
  const input = String(line || '');
  if (!input || input.startsWith('## ')) return null;
  const code = input.slice(0, 2);
  const file = input.slice(3).trim();
  if (!file) return null;
  return {
    code,
    file,
    staged: code[0] && code[0] !== ' ' && code[0] !== '?',
    unstaged: code[1] && code[1] !== ' ',
    untracked: code === '??',
  };
}

function summarizeStatusEntries(entries) {
  return entries.reduce((acc, item) => {
    if (item.untracked) acc.untracked += 1;
    if (item.staged) acc.staged += 1;
    if (item.unstaged) acc.unstaged += 1;
    return acc;
  }, { staged: 0, unstaged: 0, untracked: 0 });
}

function parseLastCommit(line) {
  const input = String(line || '').trim();
  if (!input) return null;
  const [hash, subject, committedAt] = input.split('\t');
  return {
    hash: String(hash || '').trim(),
    subject: String(subject || '').trim(),
    committedAt: String(committedAt || '').trim(),
  };
}

function sanitizeBranchName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^0-9A-Za-z._/-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^-+|-+$/g, '')
    .replace(/^\/+|\/+$/g, '')
    .slice(0, 80);
}

function truncatePatch(value, maxChars) {
  const input = trimTrailingNewlines(value);
  if (input.length <= maxChars) return input;
  return `${input.slice(0, Math.max(1, maxChars - 1))}…`;
}

function trimTrailingNewlines(value) {
  return String(value || '').replace(/\s+$/g, '');
}

function extractCount(text, pattern) {
  const match = String(text || '').match(pattern);
  return match ? Number.parseInt(match[1], 10) || 0 : 0;
}
