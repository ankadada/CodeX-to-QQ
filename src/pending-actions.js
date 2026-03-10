const DEFAULT_PENDING_ACTION_TTL_MS = 10 * 60 * 1000;

export function normalizePendingActions(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  for (const [token, item] of Object.entries(value)) {
    if (!token) continue;
    const normalized = normalizePendingAction(item);
    if (normalized) out[token] = normalized;
  }
  return out;
}

export function createPendingAction(actions, token, payload = {}, now = Date.now(), ttlMs = DEFAULT_PENDING_ACTION_TTL_MS) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) return null;
  const normalizedTtl = normalizeTimeout(ttlMs, DEFAULT_PENDING_ACTION_TTL_MS);
  const action = {
    kind: String(payload.kind || '').trim() || 'unknown',
    title: String(payload.title || '').trim() || '',
    data: payload.data && typeof payload.data === 'object' ? payload.data : {},
    createdAt: new Date(now).toISOString(),
    expiresAt: normalizedTtl > 0 ? new Date(now + normalizedTtl).toISOString() : null,
  };
  actions[normalizedToken] = action;
  cleanupExpiredPendingActions(actions, now);
  return action;
}

export function consumePendingAction(actions, token, now = Date.now()) {
  cleanupExpiredPendingActions(actions, now);
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken || !actions[normalizedToken]) return null;
  const action = actions[normalizedToken];
  delete actions[normalizedToken];
  return action;
}

export function peekPendingAction(actions, token, now = Date.now()) {
  cleanupExpiredPendingActions(actions, now);
  const normalizedToken = String(token || '').trim();
  return normalizedToken ? actions[normalizedToken] || null : null;
}

export function listPendingActions(actions, now = Date.now()) {
  cleanupExpiredPendingActions(actions, now);
  return Object.entries(actions || {})
    .map(([token, action]) => ({
      token,
      ...action,
    }))
    .sort((left, right) => {
      const leftCreated = Date.parse(String(left.createdAt || '').trim()) || 0;
      const rightCreated = Date.parse(String(right.createdAt || '').trim()) || 0;
      return rightCreated - leftCreated;
    });
}

export function getLatestPendingAction(actions, now = Date.now()) {
  return listPendingActions(actions, now)[0] || null;
}

export function cleanupExpiredPendingActions(actions, now = Date.now()) {
  for (const [token, action] of Object.entries(actions || {})) {
    const expiresAt = Date.parse(String(action?.expiresAt || '').trim());
    if (Number.isFinite(expiresAt) && now > expiresAt) {
      delete actions[token];
    }
  }
}

function normalizePendingAction(value) {
  if (!value || typeof value !== 'object') return null;
  const kind = String(value.kind || '').trim() || 'unknown';
  const title = String(value.title || '').trim();
  const createdAt = normalizeIso(value.createdAt);
  const expiresAt = normalizeIso(value.expiresAt);
  return {
    kind,
    title,
    data: value.data && typeof value.data === 'object' ? value.data : {},
    createdAt,
    expiresAt,
  };
}

function normalizeTimeout(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.floor(numeric));
}

function normalizeIso(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
