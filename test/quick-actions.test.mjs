import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatQuickActionCapability,
  isQuickActionUnsupportedError,
  markQuickActionsSupported,
  markQuickActionsUnsupported,
  shouldAttemptQuickActions,
} from '../src/quick-actions.js';

test('shouldAttemptQuickActions blocks unsupported peers until cooldown expires', () => {
  const now = Date.parse('2026-03-09T12:00:00.000Z');
  assert.equal(shouldAttemptQuickActions({
    enabled: true,
    requested: true,
    content: 'hello',
    capability: {
      status: 'unsupported',
      lastCheckedAt: '2026-03-09T11:30:00.000Z',
    },
    retryMs: 60 * 60 * 1000,
    now,
  }), false);

  assert.equal(shouldAttemptQuickActions({
    enabled: true,
    requested: true,
    content: 'hello',
    capability: {
      status: 'unsupported',
      lastCheckedAt: '2026-03-09T10:30:00.000Z',
    },
    retryMs: 60 * 60 * 1000,
    now,
  }), true);
});

test('markQuickActionsUnsupported parses QQ keyboard error details', () => {
  const capability = markQuickActionsUnsupported({}, {
    message: 'QQ API failed: {"message":"not allowd custom keyborad","code":304057}',
    qqCode: 304057,
  }, Date.parse('2026-03-09T12:00:00.000Z'));

  assert.equal(capability.status, 'unsupported');
  assert.equal(capability.failureCode, 304057);
  assert.equal(isQuickActionUnsupportedError({ qqCode: 304057 }), true);
});

test('markQuickActionsSupported clears disabled reason', () => {
  const capability = markQuickActionsSupported({
    status: 'unsupported',
    disabledReason: 'not allowd custom keyborad',
    failureCode: 304057,
    failures: 2,
  }, Date.parse('2026-03-09T12:00:00.000Z'));

  assert.equal(capability.status, 'supported');
  assert.equal(capability.disabledReason, '');
  assert.equal(capability.failureCode, null);
});

test('formatQuickActionCapability reports retry window', () => {
  const text = formatQuickActionCapability({
    status: 'unsupported',
    disabledReason: '当前 QQ 会话不支持自定义键盘',
    lastCheckedAt: '2026-03-09T11:55:00.000Z',
  }, 10 * 60 * 1000, Date.parse('2026-03-09T12:00:00.000Z'));

  assert.match(text, /纯文本/);
  assert.match(text, /后重试/);
});
