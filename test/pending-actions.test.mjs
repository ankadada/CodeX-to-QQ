import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanupExpiredPendingActions,
  consumePendingAction,
  createPendingAction,
  getLatestPendingAction,
  listPendingActions,
  normalizePendingActions,
  peekPendingAction,
} from '../src/pending-actions.js';

test('createPendingAction stores tokenized confirmation and consume clears it', () => {
  const actions = {};
  createPendingAction(actions, 'tok-1', {
    kind: 'dangerous-mode',
    title: '切换 dangerous',
    data: { mode: 'dangerous' },
  }, Date.parse('2026-03-10T10:00:00.000Z'));

  assert.equal(peekPendingAction(actions, 'tok-1')?.kind, 'dangerous-mode');
  assert.equal(consumePendingAction(actions, 'tok-1')?.data?.mode, 'dangerous');
  assert.equal(peekPendingAction(actions, 'tok-1'), null);
});

test('cleanupExpiredPendingActions prunes stale actions', () => {
  const actions = normalizePendingActions({
    old: {
      kind: 'rollback',
      createdAt: '2026-03-10T10:00:00.000Z',
      expiresAt: '2026-03-10T10:10:00.000Z',
    },
    fresh: {
      kind: 'rollback',
      createdAt: '2026-03-10T10:00:00.000Z',
      expiresAt: '2026-03-10T10:30:00.000Z',
    },
  });

  cleanupExpiredPendingActions(actions, Date.parse('2026-03-10T10:15:00.000Z'));
  assert.equal(Boolean(actions.old), false);
  assert.equal(Boolean(actions.fresh), true);
});

test('listPendingActions sorts newest first and latest helper returns first item', () => {
  const actions = {};
  createPendingAction(actions, 'tok-1', {
    kind: 'rollback',
    title: '回退 tracked',
  }, Date.parse('2026-03-10T10:00:00.000Z'));
  createPendingAction(actions, 'tok-2', {
    kind: 'mode-switch',
    title: '切换 dangerous',
  }, Date.parse('2026-03-10T10:05:00.000Z'));

  const items = listPendingActions(actions, Date.parse('2026-03-10T10:06:00.000Z'));
  assert.deepEqual(items.map((item) => item.token), ['tok-2', 'tok-1']);
  assert.equal(getLatestPendingAction(actions, Date.parse('2026-03-10T10:06:00.000Z'))?.token, 'tok-2');
});
