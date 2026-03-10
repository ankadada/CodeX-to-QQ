import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commitWorkspace,
  ensureWorkspaceGitRepo,
  getDiffReport,
  getRepoStatus,
  rollbackWorkspace,
  switchBranch,
} from '../src/workspace-git.js';

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-qq-git-'));
  const boot = ensureWorkspaceGitRepo(dir);
  assert.equal(boot.ok, true);
  return dir;
}

function writeFile(dir, name, content) {
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function git(dir, args) {
  const result = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

test('ensureWorkspaceGitRepo creates repo and ignores attachments', () => {
  const dir = makeTempRepo();
  const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.match(gitignore, /\.attachments\//);
});

test('switchBranch creates sanitized branch name', () => {
  const dir = makeTempRepo();
  writeFile(dir, 'README.md', 'hello\n');
  const commit = commitWorkspace(dir, 'init workspace');
  assert.equal(commit.ok, true);

  const next = switchBranch(dir, 'feature login fix');
  assert.equal(next.ok, true);
  assert.equal(next.branch, 'feature-login-fix');
});

test('getDiffReport returns staged and working summaries', () => {
  const dir = makeTempRepo();
  writeFile(dir, 'README.md', 'hello\n');
  assert.equal(commitWorkspace(dir, 'init workspace').ok, true);

  writeFile(dir, 'README.md', 'hello\nworld\n');
  const report = getDiffReport(dir, 'all');
  assert.equal(report.ok, true);
  assert.match(report.workingPatch, /\+world/);
});

test('rollbackWorkspace reverts tracked changes but keeps untracked files by default', () => {
  const dir = makeTempRepo();
  writeFile(dir, 'README.md', 'hello\n');
  assert.equal(commitWorkspace(dir, 'init workspace').ok, true);

  writeFile(dir, 'README.md', 'changed\n');
  writeFile(dir, 'notes.txt', 'keep me\n');

  const rollback = rollbackWorkspace(dir, 'tracked');
  assert.equal(rollback.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'hello\n');
  assert.equal(fs.existsSync(path.join(dir, 'notes.txt')), true);
});

test('getRepoStatus reports clean repo after commit', () => {
  const dir = makeTempRepo();
  writeFile(dir, 'README.md', 'hello\n');
  assert.equal(commitWorkspace(dir, 'init workspace').ok, true);

  const status = getRepoStatus(dir);
  assert.equal(status.ok, true);
  assert.equal(status.clean, true);
  assert.ok(status.branch);
  assert.ok(status.headShort);
  assert.equal(git(dir, ['branch', '--show-current']).length > 0, true);
});
