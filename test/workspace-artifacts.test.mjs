import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { commitWorkspace, ensureWorkspaceGitRepo } from '../src/workspace-git.js';
import {
  exportWorkspaceDiff,
  getPatchArtifact,
  listChangedFiles,
  openWorkspaceFile,
} from '../src/workspace-artifacts.js';

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-qq-artifacts-'));
  const result = ensureWorkspaceGitRepo(dir);
  assert.equal(result.ok, true);
  return dir;
}

function writeFile(dir, name, content) {
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test('listChangedFiles groups staged, unstaged, and untracked files', () => {
  const dir = makeWorkspace();
  writeFile(dir, 'README.md', 'hello\n');
  assert.equal(commitWorkspace(dir, 'init').ok, true);
  writeFile(dir, 'README.md', 'hello world\n');
  writeFile(dir, 'notes.txt', 'draft\n');

  const changed = listChangedFiles(dir);
  assert.equal(changed.ok, true);
  assert.deepEqual(changed.groups.unstaged, ['README.md']);
  assert.deepEqual(changed.groups.untracked, ['notes.txt']);
});

test('getPatchArtifact shows tracked patch preview and untracked file preview', () => {
  const dir = makeWorkspace();
  writeFile(dir, 'README.md', 'hello\n');
  assert.equal(commitWorkspace(dir, 'init').ok, true);
  writeFile(dir, 'README.md', 'hello\nworld\n');
  writeFile(dir, 'notes.txt', 'draft\n');

  const tracked = getPatchArtifact(dir, 'README.md');
  assert.equal(tracked.ok, true);
  assert.match(tracked.sections[0].content, /\+world/);

  const untracked = getPatchArtifact(dir, 'notes.txt');
  assert.equal(untracked.ok, true);
  assert.equal(untracked.untracked, true);
  assert.match(untracked.sections[0].content, /draft/);
});

test('openWorkspaceFile resolves basename and previews text', () => {
  const dir = makeWorkspace();
  writeFile(dir, 'src/app.txt', 'line 1\nline 2\n');
  const opened = openWorkspaceFile(dir, 'app.txt');
  assert.equal(opened.ok, true);
  assert.equal(opened.relativePath, 'src/app.txt');
  assert.match(opened.preview, /line 1/);
});

test('exportWorkspaceDiff writes patch file under .exports', () => {
  const dir = makeWorkspace();
  writeFile(dir, 'README.md', 'hello\n');
  assert.equal(commitWorkspace(dir, 'init').ok, true);
  writeFile(dir, 'README.md', 'hello\nworld\n');

  const exported = exportWorkspaceDiff(dir, 'all');
  assert.equal(exported.ok, true);
  assert.equal(exported.noChanges, false);
  assert.equal(exported.relativePath.startsWith('.exports/diff-all-'), true);
  assert.equal(fs.existsSync(exported.exportPath), true);
});
