const QUICK_ACTION_UNSUPPORTED_CODE = 304057;

export function normalizeQuickActionCapability(value) {
  const status = ['supported', 'unsupported'].includes(value?.status) ? value.status : 'unknown';
  return {
    status,
    lastCheckedAt: normalizeIso(value?.lastCheckedAt),
    disabledReason: String(value?.disabledReason || '').trim(),
    failureCode: normalizeNumber(value?.failureCode),
    failures: Math.max(0, normalizeNumber(value?.failures) || 0),
  };
}

export function shouldAttemptQuickActions({
  enabled,
  requested,
  content,
  capability,
  retryMs,
  now = Date.now(),
  maxContentLength = 900,
}) {
  if (!enabled || !requested) return false;
  const text = String(content || '');
  if (!text || text.includes('```') || text.length > maxContentLength) return false;

  const normalized = normalizeQuickActionCapability(capability);
  if (normalized.status !== 'unsupported') return true;
  if (retryMs <= 0) return false;

  const last = Date.parse(normalized.lastCheckedAt || '');
  if (!Number.isFinite(last)) return true;
  return (now - last) >= retryMs;
}

export function markQuickActionsSupported(capability, now = Date.now()) {
  return {
    ...normalizeQuickActionCapability(capability),
    status: 'supported',
    lastCheckedAt: new Date(now).toISOString(),
    disabledReason: '',
    failureCode: null,
  };
}

export function markQuickActionsUnsupported(capability, error, now = Date.now()) {
  const normalized = normalizeQuickActionCapability(capability);
  const parsed = parseQuickActionError(error);
  return {
    ...normalized,
    status: 'unsupported',
    lastCheckedAt: new Date(now).toISOString(),
    disabledReason: parsed.reason,
    failureCode: parsed.code,
    failures: normalized.failures + 1,
  };
}

export function isQuickActionUnsupportedError(error) {
  return parseQuickActionError(error).unsupported;
}

export function formatQuickActionCapability(capability, retryMs, now = Date.now()) {
  const normalized = normalizeQuickActionCapability(capability);
  if (normalized.status === 'supported') {
    return '支持';
  }
  if (normalized.status !== 'unsupported') {
    return '未知（将自动尝试）';
  }

  const reason = normalized.disabledReason || '当前 QQ 会话不支持自定义键盘';
  const last = Date.parse(normalized.lastCheckedAt || '');
  if (!Number.isFinite(last) || retryMs <= 0) {
    return `已降级为纯文本：${reason}`;
  }
  const retryAt = last + retryMs;
  const remaining = retryAt - now;
  if (remaining <= 0) {
    return `已降级为纯文本：${reason}（下次发送将重试）`;
  }
  return `已降级为纯文本：${reason}（约 ${formatDuration(remaining)} 后重试）`;
}

function parseQuickActionError(error) {
  const message = String(error?.qqMessage || error?.message || error || '').trim();
  const lower = message.toLowerCase();
  const code = normalizeNumber(error?.qqCode) ?? normalizeNumber(error?.qqErrCode) ?? null;
  const unsupported = code === QUICK_ACTION_UNSUPPORTED_CODE
    || lower.includes('custom keyborad')
    || lower.includes('custom keyboard')
    || lower.includes('not allowd custom keyborad');
  return {
    unsupported,
    code,
    reason: message || 'quick actions unsupported',
  };
}

function normalizeIso(value) {
  const input = String(value || '').trim();
  if (!input) return null;
  const ts = Date.parse(input);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function normalizeNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
