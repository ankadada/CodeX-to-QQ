import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGatewayRuntimeState,
  forceGatewayFreshIdentify,
  isGatewayHeartbeatOverdue,
  noteGatewayClose,
  noteGatewayHeartbeatAck,
  noteGatewayHeartbeatSent,
  noteGatewayHello,
  resolveGatewayReconnectDelay,
  shouldAttemptGatewayResume,
} from '../src/gateway-resilience.js';

test('shouldAttemptGatewayResume respects fresh-identify cooldown', () => {
  const now = Date.parse('2026-03-10T10:00:00.000Z');
  const runtime = createGatewayRuntimeState(now);
  assert.equal(shouldAttemptGatewayResume({ sessionId: 'sess', lastSeq: 12 }, runtime, now), true);

  forceGatewayFreshIdentify(runtime, now, 60 * 1000);
  assert.equal(shouldAttemptGatewayResume({ sessionId: 'sess', lastSeq: 12 }, runtime, now + 30 * 1000), false);
  assert.equal(shouldAttemptGatewayResume({ sessionId: 'sess', lastSeq: 12 }, runtime, now + 61 * 1000), true);
});

test('isGatewayHeartbeatOverdue only trips when ack is stale', () => {
  const now = Date.parse('2026-03-10T10:00:00.000Z');
  const runtime = createGatewayRuntimeState(now);
  noteGatewayHello(runtime, 30000, now);
  noteGatewayHeartbeatSent(runtime, now + 1000);

  assert.equal(isGatewayHeartbeatOverdue(runtime, now + 40 * 1000), false);
  assert.equal(isGatewayHeartbeatOverdue(runtime, now + 70 * 1000), true);

  noteGatewayHeartbeatAck(runtime, now + 71 * 1000);
  assert.equal(isGatewayHeartbeatOverdue(runtime, now + 72 * 1000), false);
});

test('noteGatewayClose escalates repeated 4009 into fresh-identify window', () => {
  const base = Date.parse('2026-03-10T10:00:00.000Z');
  const runtime = createGatewayRuntimeState(base);
  runtime.connectionOpenedAt = base - 5000;

  noteGatewayClose(runtime, 4009, 'Session timed out', base);
  assert.equal(runtime.sessionTimeoutStreak, 1);
  assert.equal(runtime.forceFreshIdentifyUntil, 0);

  runtime.connectionOpenedAt = base + 10000;
  noteGatewayClose(runtime, 4009, 'Session timed out', base + 20000);
  assert.equal(runtime.sessionTimeoutStreak, 2);
  assert.ok(runtime.forceFreshIdentifyUntil > base + 20000);
});

test('resolveGatewayReconnectDelay respects streak floor for repeated session timeouts', () => {
  assert.equal(resolveGatewayReconnectDelay({
    code: 4009,
    reconnectIndex: 0,
    sessionTimeoutStreak: 1,
    defaultDelays: [1000, 2000, 5000],
  }), 2000);

  assert.equal(resolveGatewayReconnectDelay({
    code: 4009,
    reconnectIndex: 0,
    sessionTimeoutStreak: 3,
    defaultDelays: [1000, 2000, 5000],
  }), 5000);
});
