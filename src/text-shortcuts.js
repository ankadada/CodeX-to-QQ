const DEFAULT_TEXT_SHORTCUT_TTL_MS = 10 * 60 * 1000;

export function createTextShortcutMenu(options = {}, now = Date.now()) {
  const items = buildTextShortcutItems(options);
  if (items.length === 0) return null;

  const ttlMs = normalizeTimeout(options.ttlMs, DEFAULT_TEXT_SHORTCUT_TTL_MS);
  return {
    category: String(options.category || 'general').trim() || 'general',
    createdAt: new Date(now).toISOString(),
    expiresAt: ttlMs > 0 ? new Date(now + ttlMs).toISOString() : null,
    items,
  };
}

export function buildTextShortcutItems(options = {}) {
  if (Array.isArray(options.items) && options.items.length > 0) {
    return withKeys(options.items.map((item) => [item.label, item.command]));
  }

  const category = String(options.category || 'general').trim();
  const hasRetry = Boolean(options.hasRetry);
  const hasActiveRun = Boolean(options.hasActiveRun);

  if (category === 'session') {
    return withKeys([
      ['会话', '/session'],
      ['历史', '/sessions'],
      ['置顶', '/pin'],
      ['分支', '/fork'],
      ['状态', '/status'],
      ['新会', '/new'],
    ]);
  }

  if (category === 'sessions') {
    return withKeys([
      ['历史', '/sessions'],
      ['状态', '/status'],
      ['置顶', '/pin'],
      ['分支', '/fork'],
      ['工作区', '/workspace'],
      ['新会', '/new'],
    ]);
  }

  if (category === 'repo') {
    return withKeys([
      ['仓库', '/repo'],
      ['改动', '/changed'],
      ['差异', '/diff'],
      ['分支', '/branch'],
      ['工作区', '/workspace'],
      ['状态', '/status'],
    ]);
  }

  if (category === 'diag') {
    return withKeys([
      ['状态', '/status'],
      ['诊断', '/diag'],
      ['版本', '/version'],
      ['统计', '/stats'],
      ['审计', '/audit'],
      ['帮助', '/help'],
    ]);
  }

  if (category === 'progress' && hasActiveRun) {
    return withKeys([
      ['进展', '/progress'],
      ['队列', '/queue'],
      ['状态', '/status'],
      ['停止', '/stop'],
      ['新会', '/new'],
      [hasRetry ? '重试' : '历史', hasRetry ? '/retry' : '/sessions'],
    ]);
  }

  return withKeys([
    ['状态', '/status'],
    ['新会', '/new'],
    [hasRetry ? '重试' : '历史', hasRetry ? '/retry' : '/sessions'],
    ['队列', '/queue'],
    ['仓库', '/repo'],
    ['工作区', '/workspace'],
  ]);
}

export function formatTextShortcutHint(menu) {
  const items = Array.isArray(menu?.items) ? menu.items : [];
  if (items.length === 0) return '';

  const rows = [];
  for (let index = 0; index < items.length; index += 3) {
    rows.push(items.slice(index, index + 3).map((item) => `${item.key}.${item.label}`).join('  '));
  }

  return [
    '数字快捷：',
    ...rows,
    '直接回 1-6 即可执行；其他内容仍按普通消息处理。',
  ].join('\n');
}

export function resolveTextShortcutCommand(input, menu, now = Date.now()) {
  if (isTextShortcutMenuExpired(menu, now)) return null;
  const match = /^([1-9])$/.exec(String(input || '').trim());
  if (!match) return null;
  const items = Array.isArray(menu?.items) ? menu.items : [];
  const picked = items.find((item) => item.key === match[1]);
  return picked?.command || null;
}

export function isTextShortcutMenuExpired(menu, now = Date.now()) {
  if (!menu) return true;
  const expiresAt = Date.parse(String(menu.expiresAt || '').trim());
  if (!Number.isFinite(expiresAt)) return false;
  return now > expiresAt;
}

function withKeys(items) {
  return items.map(([label, command], index) => ({
    key: String(index + 1),
    label,
    command,
  }));
}

function normalizeTimeout(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.floor(numeric));
}
