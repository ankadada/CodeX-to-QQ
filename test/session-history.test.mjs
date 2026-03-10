import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearPinnedSessionHistory,
  createAutoSessionTitle,
  normalizeSessionHistory,
  pinSessionHistory,
  renameSessionHistory,
  upsertSessionHistory,
} from '../src/session-history.js';

test('upsertSessionHistory creates auto title and updates prompt metadata', () => {
  const next = upsertSessionHistory([], 'sess-1', {
    lastPromptPreview: '修复登录接口 500 错误并补测试',
    lastRunOk: true,
    runCountDelta: 1,
  });

  assert.equal(next.length, 1);
  assert.equal(next[0].id, 'sess-1');
  assert.match(next[0].title, /修复登录接口/);
  assert.equal(next[0].runCount, 1);
  assert.equal(next[0].lastRunOk, true);
});

test('renameSessionHistory preserves manual title across later updates', () => {
  const renamed = renameSessionHistory([
    {
      id: 'sess-1',
      lastPromptPreview: '自动标题',
    },
  ], 'sess-1', '生产故障修复');

  const updated = upsertSessionHistory(renamed, 'sess-1', {
    lastPromptPreview: '新的自动标题不该覆盖',
    runCountDelta: 1,
  });

  assert.equal(updated[0].title, '生产故障修复');
  assert.equal(updated[0].manualTitle, true);
});

test('pinSessionHistory sorts pinned sessions first and clearPinnedSessionHistory resets them', () => {
  const history = normalizeSessionHistory([
    { id: 'sess-1', lastUsedAt: '2026-03-01T00:00:00.000Z' },
    { id: 'sess-2', lastUsedAt: '2026-03-02T00:00:00.000Z' },
  ]);

  const pinned = pinSessionHistory(history, 'sess-1', true);
  assert.equal(pinned[0].id, 'sess-1');
  assert.ok(pinned[0].pinnedAt);

  const cleared = clearPinnedSessionHistory(pinned);
  assert.equal(cleared.every((item) => item.pinnedAt === null), true);
});

test('createAutoSessionTitle falls back when source text is empty', () => {
  assert.match(createAutoSessionTitle('', 'abc123'), /abc123/);
});
