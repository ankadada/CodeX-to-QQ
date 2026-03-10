import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureWorkspaceGitRepo, getRepoStatus } from './workspace-git.js';

const MAX_WALK_FILES = 4000;
const BINARY_SAMPLE_BYTES = 8192;
const DEFAULT_PREVIEW_BYTES = 24 * 1024;
const DEFAULT_PATCH_CHARS = 2400;

export function listChangedFiles(dir, limit = 30) {
  const status = getRepoStatus(dir);
  if (!status.ok) return status;

  const groups = {
    staged: [],
    unstaged: [],
    untracked: [],
  };

  for (const entry of status.entries) {
    if (entry.untracked) {
      groups.untracked.push(entry.file);
      continue;
    }
    if (entry.staged) groups.staged.push(entry.file);
    if (entry.unstaged) groups.unstaged.push(entry.file);
  }

  return {
    ok: true,
    status,
    groups: {
      staged: groups.staged.slice(0, limit),
      unstaged: groups.unstaged.slice(0, limit),
      untracked: groups.untracked.slice(0, limit),
    },
  };
}

export function getPatchArtifact(dir, rawTarget = '', maxPatchChars = DEFAULT_PATCH_CHARS) {
  const status = getRepoStatus(dir);
  if (!status.ok) return status;

  const target = String(rawTarget || '').trim();
  if (!target) {
    const staged = runGit(dir, ['diff', '--cached', '--unified=1', '--no-ext-diff'], { allowFailure: true });
    const working = runGit(dir, ['diff', '--unified=1', '--no-ext-diff'], { allowFailure: true });
    const sections = [];
    if (staged.ok && staged.stdout.trim()) sections.push({ label: 'Staged patch', content: truncateText(staged.stdout, maxPatchChars) });
    if (working.ok && working.stdout.trim()) sections.push({ label: 'Working patch', content: truncateText(working.stdout, maxPatchChars) });
    return {
      ok: true,
      targetPath: '',
      relativePath: '',
      sections,
      noChanges: sections.length === 0,
      status,
    };
  }

  const resolved = resolveWorkspacePath(dir, target);
  if (!resolved.ok) return resolved;

  const relativePath = resolved.relativePath;
  const entry = status.entries.find((item) => item.file === relativePath) || null;

  if (entry?.untracked) {
    const opened = openWorkspaceFile(dir, target, maxPatchChars);
    if (!opened.ok) return opened;
    return {
      ok: true,
      targetPath: opened.relativePath,
      relativePath: opened.relativePath,
      sections: [{
        label: 'Untracked file preview',
        content: opened.preview,
      }],
      noChanges: false,
      status,
      untracked: true,
    };
  }

  const staged = runGit(dir, ['diff', '--cached', '--unified=1', '--no-ext-diff', '--', relativePath], { allowFailure: true });
  const working = runGit(dir, ['diff', '--unified=1', '--no-ext-diff', '--', relativePath], { allowFailure: true });
  const sections = [];
  if (staged.ok && staged.stdout.trim()) sections.push({ label: 'Staged patch', content: truncateText(staged.stdout, maxPatchChars) });
  if (working.ok && working.stdout.trim()) sections.push({ label: 'Working patch', content: truncateText(working.stdout, maxPatchChars) });
  return {
    ok: true,
    targetPath: target,
    relativePath,
    sections,
    noChanges: sections.length === 0,
    status,
    untracked: false,
  };
}

export function openWorkspaceFile(dir, rawTarget, maxChars = DEFAULT_PATCH_CHARS) {
  const resolved = resolveWorkspacePath(dir, rawTarget);
  if (!resolved.ok) return resolved;

  const absolutePath = resolved.absolutePath;
  const stat = fs.statSync(absolutePath);
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(absolutePath, { withFileTypes: true })
      .slice(0, 30)
      .map((entry) => `${entry.isDirectory() ? '📁' : '📄'} ${entry.name}`);
    return {
      ok: true,
      relativePath: resolved.relativePath,
      kind: 'directory',
      preview: entries.join('\n'),
      truncated: fs.readdirSync(absolutePath).length > 30,
      byteLength: 0,
    };
  }

  const buffer = fs.readFileSync(absolutePath);
  const binary = isProbablyBinary(buffer);
  if (binary) {
    return {
      ok: true,
      relativePath: resolved.relativePath,
      kind: 'binary',
      preview: '',
      truncated: false,
      byteLength: buffer.length,
      mimeType: detectMimeType(absolutePath),
    };
  }

  const text = buffer.toString('utf8');
  const preview = truncateText(normalizeText(text), maxChars);
  return {
    ok: true,
    relativePath: resolved.relativePath,
    kind: 'text',
    preview,
    truncated: preview.length < text.length,
    byteLength: buffer.length,
    mimeType: detectMimeType(absolutePath),
  };
}

export function exportWorkspaceDiff(dir, mode = 'all') {
  const boot = ensureWorkspaceGitRepo(dir);
  if (!boot.ok) return boot;

  const status = getRepoStatus(dir);
  if (!status.ok) return status;

  const sections = [];
  if (mode === 'all' || mode === 'staged') {
    const staged = runGit(dir, ['diff', '--cached', '--no-ext-diff'], { allowFailure: true });
    if (staged.ok && staged.stdout.trim()) {
      sections.push({ label: 'staged', content: trimTrailingNewlines(staged.stdout) });
    }
  }
  if (mode === 'all' || mode === 'working') {
    const working = runGit(dir, ['diff', '--no-ext-diff'], { allowFailure: true });
    if (working.ok && working.stdout.trim()) {
      sections.push({ label: 'working', content: trimTrailingNewlines(working.stdout) });
    }
  }

  if (sections.length === 0) {
    return {
      ok: true,
      noChanges: true,
      status,
      exportPath: '',
      relativePath: '',
      bytes: 0,
    };
  }

  const exportDir = path.join(dir, '.exports');
  fs.mkdirSync(exportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `diff-${mode}-${timestamp}.patch`;
  const absolutePath = path.join(exportDir, fileName);
  const body = [
    `# CodeX-to-QQ export`,
    `# workspace: ${dir}`,
    `# branch: ${status.branch || '(unknown)'}`,
    `# generated_at: ${new Date().toISOString()}`,
    '',
    ...sections.flatMap((section) => [
      `### ${section.label} diff`,
      section.content,
      '',
    ]),
  ].join('\n');
  fs.writeFileSync(absolutePath, `${body.trimEnd()}\n`);
  return {
    ok: true,
    noChanges: false,
    status,
    exportPath: absolutePath,
    relativePath: toPosix(path.relative(dir, absolutePath)),
    bytes: fs.statSync(absolutePath).size,
    sections,
  };
}

function resolveWorkspacePath(dir, rawTarget) {
  const input = String(rawTarget || '').trim();
  if (!input) return { ok: false, error: 'file path required' };

  const cleaned = input.replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  const directAbsolute = path.resolve(dir, cleaned);
  if (isWithin(dir, directAbsolute) && fs.existsSync(directAbsolute)) {
    return {
      ok: true,
      absolutePath: directAbsolute,
      relativePath: toPosix(path.relative(dir, directAbsolute)),
    };
  }

  const basename = path.basename(cleaned);
  if (!basename) return { ok: false, error: `找不到文件：${rawTarget}` };
  const matches = walkWorkspaceFiles(dir).filter((filePath) => path.basename(filePath) === basename);
  if (matches.length === 1) {
    return {
      ok: true,
      absolutePath: matches[0],
      relativePath: toPosix(path.relative(dir, matches[0])),
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `找到多个同名文件，请用相对路径：${matches.slice(0, 6).map((item) => toPosix(path.relative(dir, item))).join(', ')}`,
    };
  }
  return { ok: false, error: `找不到文件：${rawTarget}` };
}

function walkWorkspaceFiles(rootDir) {
  const queue = [rootDir];
  const files = [];
  const skipNames = new Set(['.git', '.attachments', '.exports', 'node_modules']);

  while (queue.length > 0 && files.length < MAX_WALK_FILES) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (skipNames.has(entry.name)) continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
      } else if (entry.isFile()) {
        files.push(absolutePath);
        if (files.length >= MAX_WALK_FILES) break;
      }
    }
  }

  return files;
}

function isProbablyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, BINARY_SAMPLE_BYTES));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

function runGit(dir, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) {
    return {
      ok: true,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
    };
  }
  return {
    ok: false,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: String(result.stderr || result.stdout || result.error?.message || `git ${args.join(' ')} failed`).trim(),
  };
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateText(value, maxChars) {
  const input = String(value || '');
  if (input.length <= maxChars) return input;
  return `${input.slice(0, Math.max(1, maxChars - 1))}…`;
}

function trimTrailingNewlines(value) {
  return String(value || '').replace(/\s+$/g, '');
}

function toPosix(value) {
  return String(value || '').split(path.sep).join('/');
}

function isWithin(rootDir, candidatePath) {
  const relative = path.relative(rootDir, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function detectMimeType(absolutePath) {
  const result = spawnSync('file', ['--mime-type', '-b', absolutePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) return '';
  return String(result.stdout || '').trim().toLowerCase();
}
