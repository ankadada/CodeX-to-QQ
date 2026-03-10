export const DEFAULT_GATEWAY_HEARTBEAT_ACK_GRACE_MS = 5000;
export const DEFAULT_GATEWAY_FORCE_IDENTIFY_MS = 60 * 1000;
export const DEFAULT_GATEWAY_STABLE_RESET_MS = 15 * 1000;

export function createGatewayRuntimeState(now = Date.now()) {
  return {
    connectionOpenedAt: 0,
    lastReadyAt: 0,
    heartbeatIntervalMs: 0,
    lastHeartbeatSentAt: 0,
    lastHeartbeatAckAt: 0,
    awaitingHeartbeatAck: false,
    usingResume: false,
    lastResumeAttemptAt: 0,
    lastIdentifyAttemptAt: 0,
    lastCloseAt: 0,
    lastCloseCode: null,
    lastCloseReason: '',
    sessionTimeoutStreak: 0,
    reconnectRequestedStreak: 0,
    forceFreshIdentifyUntil: 0,
    lastProblemAt: now,
  };
}

export function shouldAttemptGatewayResume(savedGateway, runtime, now = Date.now()) {
  return Boolean(
    savedGateway?.sessionId
      && Number.isFinite(savedGateway?.lastSeq)
      && now >= Number(runtime?.forceFreshIdentifyUntil || 0),
  );
}

export function noteGatewayHello(runtime, intervalMs, now = Date.now()) {
  runtime.heartbeatIntervalMs = normalizeMs(intervalMs, 30000);
  runtime.lastHeartbeatAckAt = now;
  runtime.awaitingHeartbeatAck = false;
}

export function noteGatewayHeartbeatSent(runtime, now = Date.now()) {
  runtime.lastHeartbeatSentAt = now;
  runtime.awaitingHeartbeatAck = true;
}

export function noteGatewayHeartbeatAck(runtime, now = Date.now()) {
  runtime.lastHeartbeatAckAt = now;
  runtime.awaitingHeartbeatAck = false;
}

export function isGatewayHeartbeatOverdue(runtime, now = Date.now(), graceMs = DEFAULT_GATEWAY_HEARTBEAT_ACK_GRACE_MS) {
  if (!runtime?.awaitingHeartbeatAck || !Number.isFinite(runtime?.lastHeartbeatSentAt)) {
    return false;
  }
  const intervalMs = normalizeMs(runtime.heartbeatIntervalMs, 30000);
  const deadline = Math.max(intervalMs * 2, intervalMs + normalizeMs(graceMs, DEFAULT_GATEWAY_HEARTBEAT_ACK_GRACE_MS));
  return (now - runtime.lastHeartbeatSentAt) >= deadline;
}

export function noteGatewayResumeAttempt(runtime, now = Date.now()) {
  runtime.usingResume = true;
  runtime.lastResumeAttemptAt = now;
}

export function noteGatewayIdentifyAttempt(runtime, now = Date.now()) {
  runtime.usingResume = false;
  runtime.lastIdentifyAttemptAt = now;
}

export function noteGatewayReady(runtime, now = Date.now()) {
  runtime.lastReadyAt = now;
  runtime.connectionOpenedAt = runtime.connectionOpenedAt || now;
  runtime.sessionTimeoutStreak = 0;
  runtime.reconnectRequestedStreak = 0;
  runtime.forceFreshIdentifyUntil = 0;
  runtime.lastHeartbeatAckAt = now;
  runtime.awaitingHeartbeatAck = false;
}

export function noteGatewayReconnectRequested(runtime, now = Date.now()) {
  runtime.reconnectRequestedStreak = isWithinProblemWindow(runtime.lastProblemAt, now)
    ? runtime.reconnectRequestedStreak + 1
    : 1;
  runtime.lastProblemAt = now;
}

export function noteGatewayClose(runtime, code, reason = '', now = Date.now(), options = {}) {
  const {
    forceIdentifyMs = DEFAULT_GATEWAY_FORCE_IDENTIFY_MS,
    stableResetMs = DEFAULT_GATEWAY_STABLE_RESET_MS,
  } = options;

  runtime.lastCloseAt = now;
  runtime.lastCloseCode = Number.isFinite(code) ? Number(code) : null;
  runtime.lastCloseReason = String(reason || '').trim();

  const stableForMs = runtime.connectionOpenedAt > 0 ? now - runtime.connectionOpenedAt : 0;
  const wasStable = stableForMs >= stableResetMs;

  if (code === 4009) {
    runtime.sessionTimeoutStreak = isWithinProblemWindow(runtime.lastProblemAt, now)
      ? runtime.sessionTimeoutStreak + 1
      : 1;
    if (runtime.sessionTimeoutStreak >= 2) {
      runtime.forceFreshIdentifyUntil = now + forceIdentifyMs;
    }
  } else if (wasStable) {
    runtime.sessionTimeoutStreak = 0;
  }

  if (code !== 7 && wasStable) {
    runtime.reconnectRequestedStreak = 0;
  }

  runtime.lastProblemAt = now;
  runtime.connectionOpenedAt = 0;
  runtime.awaitingHeartbeatAck = false;
  return runtime;
}

export function forceGatewayFreshIdentify(runtime, now = Date.now(), forceIdentifyMs = DEFAULT_GATEWAY_FORCE_IDENTIFY_MS) {
  runtime.forceFreshIdentifyUntil = now + forceIdentifyMs;
  runtime.usingResume = false;
}

export function shouldResetReconnectBackoff(type) {
  return type === 'READY' || type === 'RESUMED';
}

export function resolveGatewayReconnectDelay(options = {}) {
  const {
    code = null,
    reconnectIndex = 0,
    sessionTimeoutStreak = 0,
    reconnectRequestedStreak = 0,
    defaultDelays = [1000, 2000, 5000, 10000, 30000, 60000],
  } = options;

  const defaultDelay = pickDelay(defaultDelays, reconnectIndex);
  if (code === 4004) return 1000;
  if (code === 4008) return 30000;
  if (code === 4009) {
    return Math.max(defaultDelay, sessionTimeoutStreak >= 2 ? 5000 : 2000);
  }
  if (code === 4006 || code === 4007 || (code >= 4900 && code <= 4913)) {
    return Math.max(defaultDelay, 2000);
  }
  if (code === 7) {
    return Math.max(defaultDelay, reconnectRequestedStreak >= 2 ? 3000 : 1000);
  }
  return undefined;
}

function normalizeMs(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.floor(numeric);
}

function pickDelay(delays, index) {
  const list = Array.isArray(delays) && delays.length > 0 ? delays : [1000];
  const position = Math.max(0, Math.min(Math.floor(Number(index) || 0), list.length - 1));
  return Number(list[position] || list[list.length - 1] || 1000);
}

function isWithinProblemWindow(previousAt, now) {
  return Number.isFinite(previousAt) && previousAt > 0 && (now - previousAt) <= DEFAULT_GATEWAY_FORCE_IDENTIFY_MS;
}
