import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTextShortcutMenu,
  formatTextShortcutHint,
  resolveTextShortcutCommand,
} from '../src/text-shortcuts.js';

test('createTextShortcutMenu builds running menu with stop shortcut', () => {
  const menu = createTextShortcutMenu({
    category: 'progress',
    hasActiveRun: true,
    hasRetry: true,
  }, Date.parse('2026-03-10T00:00:00.000Z'));

  assert.equal(menu.items[0].command, '/progress');
  assert.equal(menu.items[3].command, '/stop');
  assert.equal(menu.items[5].command, '/retry');
});

test('resolveTextShortcutCommand only resolves exact digits before expiry', () => {
  const now = Date.parse('2026-03-10T00:00:00.000Z');
  const menu = createTextShortcutMenu({
    category: 'status',
    hasRetry: false,
    ttlMs: 5 * 60 * 1000,
  }, now);

  assert.equal(resolveTextShortcutCommand('2', menu, now + 1000), '/new');
  assert.equal(resolveTextShortcutCommand('2 hello', menu, now + 1000), null);
  assert.equal(resolveTextShortcutCommand('2', menu, now + 10 * 60 * 1000), null);
});

test('formatTextShortcutHint renders compact numeric helper', () => {
  const menu = createTextShortcutMenu({
    category: 'repo',
  });
  const text = formatTextShortcutHint(menu);

  assert.match(text, /数字快捷：/);
  assert.match(text, /1\.仓库/);
  assert.match(text, /5\.工作区/);
});

test('createTextShortcutMenu supports custom command items', () => {
  const menu = createTextShortcutMenu({
    category: 'confirm',
    items: [
      { label: '确认', command: '/confirm-action tok yes' },
      { label: '取消', command: '/confirm-action tok no' },
    ],
  });

  assert.equal(menu.items[0].command, '/confirm-action tok yes');
  assert.equal(menu.items[1].label, '取消');
});
