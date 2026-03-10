const DEFAULT_HISTORY_LIMIT = 20;
const DEFAULT_TITLE_LENGTH = 36;

export function normalizeSessionHistory(items, limit = DEFAULT_HISTORY_LIMIT) {
  if (!Array.isArray(items)) return [];
  const deduped = new Map();
  for (const item of items) {
    const normalized = normalizeHistoryItem(item);
    if (!normalized) continue;
    deduped.set(normalized.id, mergeHistoryItem(deduped.get(normalized.id), normalized));
  }
  return sortSessionHistory([...deduped.values()]).slice(0, limit);
}

export function upsertSessionHistory(items, sessionId, updates = {}, limit = DEFAULT_HISTORY_LIMIT) {
  const normalizedId = String(sessionId || '').trim();
  if (!normalizedId) {
    return normalizeSessionHistory(items, limit);
  }
  const current = normalizeSessionHistory(items, limit);
  const existing = current.find((item) => item.id === normalizedId) || null;
  const next = buildHistoryItem(existing, normalizedId, updates);
  return sortSessionHistory([next, ...current.filter((item) => item.id !== normalizedId)]).slice(0, limit);
}

export function renameSessionHistory(items, sessionId, title, limit = DEFAULT_HISTORY_LIMIT) {
  const normalizedTitle = normalizeTitle(title);
  if (!normalizedTitle) return normalizeSessionHistory(items, limit);
  return upsertSessionHistory(items, sessionId, {
    title: normalizedTitle,
    manualTitle: true,
  }, limit);
}

export function pinSessionHistory(items, sessionId, pinned = true, limit = DEFAULT_HISTORY_LIMIT) {
  if (!pinned) {
    return upsertSessionHistory(items, sessionId, {
      pinnedAt: null,
    }, limit);
  }
  return upsertSessionHistory(items, sessionId, {
    pinnedAt: new Date().toISOString(),
  }, limit);
}

export function clearPinnedSessionHistory(items, limit = DEFAULT_HISTORY_LIMIT) {
  return normalizeSessionHistory(items, limit).map((item) => ({
    ...item,
    pinnedAt: null,
  }));
}

export function findSessionHistoryItem(items, sessionId) {
  const normalizedId = String(sessionId || '').trim();
  if (!normalizedId) return null;
  return normalizeSessionHistory(items).find((item) => item.id === normalizedId) || null;
}

export function createAutoSessionTitle(sourceText, fallbackId = '') {
  const input = String(sourceText || '').replace(/\s+/g, ' ').trim();
  if (input) {
    return truncateText(input, DEFAULT_TITLE_LENGTH);
  }
  const fallback = String(fallbackId || '').trim();
  if (fallback) {
    return truncateText(`会话 ${fallback}`, DEFAULT_TITLE_LENGTH);
  }
  return '未命名会话';
}

function buildHistoryItem(existing, sessionId, updates) {
  const base = normalizeHistoryItem(existing) || createEmptyHistoryItem(sessionId);
  const merged = {
    ...base,
    ...updates,
    id: sessionId,
    createdAt: base.createdAt || normalizeIsoTimestamp(updates.createdAt) || new Date().toISOString(),
    lastUsedAt: normalizeIsoTimestamp(updates.lastUsedAt) || base.lastUsedAt || new Date().toISOString(),
    pinnedAt: updates.pinnedAt === null ? null : normalizeIsoTimestamp(updates.pinnedAt) || base.pinnedAt || null,
    parentSessionId: normalizeOptionalString(updates.parentSessionId) ?? base.parentSessionId ?? null,
    reason: normalizeOptionalString(updates.reason) ?? base.reason ?? 'run',
    lastInputTokens: normalizeOptionalNumber(updates.lastInputTokens) ?? base.lastInputTokens ?? null,
    lastPromptPreview: normalizeOptionalString(updates.lastPromptPreview) ?? base.lastPromptPreview ?? '',
    lastAnswerPreview: normalizeOptionalString(updates.lastAnswerPreview) ?? base.lastAnswerPreview ?? '',
    lastRunOk: updates.lastRunOk === undefined ? base.lastRunOk ?? null : normalizeOptionalBoolean(updates.lastRunOk),
    runCount: normalizeRunCount(base.runCount, updates.runCount, updates.runCountDelta),
  };

  const manualTitle = updates.manualTitle === true
    ? true
    : updates.manualTitle === false
      ? false
      : Boolean(base.manualTitle);
  merged.manualTitle = manualTitle;

  const requestedTitle = normalizeTitle(updates.title);
  if (manualTitle) {
    merged.title = requestedTitle || normalizeTitle(base.title) || createAutoSessionTitle(merged.lastPromptPreview || merged.lastAnswerPreview, sessionId);
  } else {
    merged.title = requestedTitle || createAutoSessionTitle(merged.lastPromptPreview || merged.lastAnswerPreview, sessionId);
  }

  return normalizeHistoryItem(merged) || createEmptyHistoryItem(sessionId);
}

function mergeHistoryItem(previous, next) {
  if (!previous) return next;
  return buildHistoryItem(previous, next.id, {
    ...next,
    runCount: Math.max(previous.runCount || 0, next.runCount || 0),
    createdAt: previous.createdAt || next.createdAt,
    manualTitle: next.manualTitle || previous.manualTitle,
    title: next.manualTitle ? next.title : previous.manualTitle ? previous.title : (next.title || previous.title),
  });
}

function sortSessionHistory(items) {
  return items.sort((left, right) => {
    const leftPinned = toTimestamp(left.pinnedAt);
    const rightPinned = toTimestamp(right.pinnedAt);
    if (leftPinned !== rightPinned) return rightPinned - leftPinned;
    const leftUsed = toTimestamp(left.lastUsedAt);
    const rightUsed = toTimestamp(right.lastUsedAt);
    if (leftUsed !== rightUsed) return rightUsed - leftUsed;
    return String(left.id).localeCompare(String(right.id));
  });
}

function normalizeHistoryItem(item) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id || '').trim();
  if (!id) return null;

  const createdAt = normalizeIsoTimestamp(item.createdAt) || normalizeIsoTimestamp(item.lastUsedAt) || new Date().toISOString();
  const lastUsedAt = normalizeIsoTimestamp(item.lastUsedAt) || createdAt;
  const manualTitle = Boolean(item.manualTitle);
  const title = normalizeTitle(item.title) || (manualTitle ? '' : createAutoSessionTitle(item.lastPromptPreview || item.lastAnswerPreview, id));

  return {
    id,
    title: title || createAutoSessionTitle(item.lastPromptPreview || item.lastAnswerPreview, id),
    manualTitle,
    pinnedAt: normalizeIsoTimestamp(item.pinnedAt),
    createdAt,
    lastUsedAt,
    lastInputTokens: normalizeOptionalNumber(item.lastInputTokens),
    reason: normalizeOptionalString(item.reason) || 'run',
    parentSessionId: normalizeOptionalString(item.parentSessionId) || null,
    lastPromptPreview: normalizeOptionalString(item.lastPromptPreview) || '',
    lastAnswerPreview: normalizeOptionalString(item.lastAnswerPreview) || '',
    lastRunOk: normalizeOptionalBoolean(item.lastRunOk),
    runCount: normalizeRunCount(0, item.runCount, 0),
  };
}

function createEmptyHistoryItem(sessionId) {
  const now = new Date().toISOString();
  return {
    id: String(sessionId || '').trim(),
    title: createAutoSessionTitle('', sessionId),
    manualTitle: false,
    pinnedAt: null,
    createdAt: now,
    lastUsedAt: now,
    lastInputTokens: null,
    reason: 'run',
    parentSessionId: null,
    lastPromptPreview: '',
    lastAnswerPreview: '',
    lastRunOk: null,
    runCount: 0,
  };
}

function normalizeTitle(value) {
  const input = String(value || '').replace(/\s+/g, ' ').trim();
  if (!input) return '';
  return truncateText(input, DEFAULT_TITLE_LENGTH);
}

function truncateText(value, maxLength) {
  const input = String(value || '').trim();
  if (input.length <= maxLength) return input;
  return `${input.slice(0, Math.max(1, maxLength - 1))}…`;
}

function normalizeIsoTimestamp(value) {
  const input = String(value || '').trim();
  if (!input) return null;
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function normalizeOptionalString(value) {
  if (value === undefined) return undefined;
  const input = String(value || '').replace(/\s+/g, ' ').trim();
  return input || null;
}

function normalizeOptionalNumber(value) {
  if (!Number.isFinite(value)) return null;
  return Number(value);
}

function normalizeOptionalBoolean(value) {
  if (value === undefined || value === null) return null;
  return value === true;
}

function normalizeRunCount(existing, explicitValue, delta = 0) {
  const base = Number.isFinite(explicitValue) ? Number(explicitValue) : Number.isFinite(existing) ? Number(existing) : 0;
  const increment = Number.isFinite(delta) ? Number(delta) : 0;
  return Math.max(0, Math.trunc(base + increment));
}

function toTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}
