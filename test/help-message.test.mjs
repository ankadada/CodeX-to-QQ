import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHelpMessage, buildUnknownCommandMessage } from '../src/help-message.js';

test('buildHelpMessage returns text-only cheat sheet when requested', () => {
  const message = buildHelpMessage({
    textOnly: true,
    currentSessionId: 'sess-1',
    queueLength: 2,
    hasRetry: true,
    quickActionStatus: '已降级为纯文本：QQ 不支持自定义键盘',
  });

  assert.match(message, /QQ 手打菜单/);
  assert.match(message, /当前会话不显示快捷按钮/);
  assert.match(message, /\/new  \/status  \/queue  \/progress  \/retry/);
  assert.match(message, /可直接回数字执行菜单项/);
  assert.match(message, /\/workspace  \/workspace recent  \/repo  \/changed/);
  assert.match(message, /\/patch \[文件\]  \/open <文件>/);
  assert.match(message, /\/branch <name>  \/diff  \/commit <说明>  \/rollback  \/export diff/);
  assert.match(message, /\/confirm-action list/);
});

test('buildHelpMessage keeps full help in default mode', () => {
  const message = buildHelpMessage({
    textOnly: false,
    currentSessionId: 'sess-1',
    queueLength: 0,
    hasRetry: false,
    quickActionStatus: '支持',
  });

  assert.match(message, /可用命令/);
  assert.match(message, /\/workspace \[show\|recent\|set <path\|index>\|reset\]/);
  assert.match(message, /\/repo \[status\|log\|path\]/);
  assert.match(message, /\/confirm-action list/);
  assert.doesNotMatch(message, /QQ 手打菜单/);
});

test('buildHelpMessage supports quick-start variant', () => {
  const message = buildHelpMessage({
    textOnly: true,
    variant: 'quick',
    currentSessionId: 'sess-1',
    queueLength: 1,
    hasRetry: true,
    quickActionStatus: '已降级为纯文本',
  });

  assert.match(message, /快速上手/);
  assert.match(message, /常用场景/);
  assert.match(message, /\/workspace recent/);
  assert.match(message, /\/confirm-action list/);
  assert.match(message, /\/help/);
});

test('buildUnknownCommandMessage is shorter in text-only mode', () => {
  const message = buildUnknownCommandMessage({
    textOnly: true,
    hasRetry: true,
  });
  assert.match(message, /未知命令/);
  assert.match(message, /\/help quick/);
  assert.match(message, /\/retry/);
});
