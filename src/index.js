import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { splitForChat } from './text-splitter.js';
import {
  buildCompactRequestPrompt,
  buildPromptFromCompactedContext,
  shouldCompactByTokens,
} from './context-compaction.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOCK_FILE = path.join(DATA_DIR, 'bot.lock');

const QQBOT_APP_ID = String(process.env.QQBOT_APP_ID || '').trim();
const QQBOT_CLIENT_SECRET = String(process.env.QQBOT_CLIENT_SECRET || '').trim();
const QQBOT_ALLOW_FROM = parseCsvSet(process.env.QQBOT_ALLOW_FROM);
const QQBOT_ALLOW_GROUPS = parseCsvSet(process.env.QQBOT_ALLOW_GROUPS);
const QQBOT_ENABLE_GROUP = String(process.env.QQBOT_ENABLE_GROUP || 'true').toLowerCase() !== 'false';
const CODEX_BIN = String(process.env.CODEX_BIN || 'codex').trim() || 'codex';
const DEFAULT_MODE = String(process.env.DEFAULT_MODE || 'dangerous').toLowerCase() === 'safe' ? 'safe' : 'dangerous';
const DEFAULT_MODEL = String(process.env.DEFAULT_MODEL || '').trim() || null;
const DEFAULT_EFFORT = normalizeEffort(process.env.DEFAULT_EFFORT || '');
const WORKSPACE_ROOT = resolvePath(String(process.env.WORKSPACE_ROOT || './workspaces').trim());
const DEBUG_EVENTS = String(process.env.DEBUG_EVENTS || 'false').toLowerCase() === 'true';
const SHOW_REASONING = String(process.env.SHOW_REASONING || 'false').toLowerCase() === 'true';
const MAX_QUEUE_PER_PEER = normalizeQueueLimit(process.env.MAX_QUEUE_PER_PEER, 20);
const CODEX_TIMEOUT_MS = normalizeTimeoutMs(process.env.CODEX_TIMEOUT_MS, 0);
const MAX_INPUT_TOKENS_BEFORE_RESET = normalizePositiveInt(process.env.MAX_INPUT_TOKENS_BEFORE_RESET, 250000);
const DOWNLOAD_ATTACHMENTS = String(process.env.DOWNLOAD_ATTACHMENTS || 'true').toLowerCase() !== 'false';
const MAX_ATTACHMENTS_PER_MESSAGE = normalizePositiveInt(process.env.MAX_ATTACHMENTS_PER_MESSAGE, 6);
const MAX_IMAGE_ATTACHMENTS = normalizePositiveInt(process.env.MAX_IMAGE_ATTACHMENTS, 4);
const MAX_ATTACHMENT_BYTES = normalizePositiveInt(process.env.MAX_ATTACHMENT_BYTES, 25 * 1024 * 1024);
const EXTRACT_ATTACHMENT_TEXT = String(process.env.EXTRACT_ATTACHMENT_TEXT || 'true').toLowerCase() !== 'false';
const MAX_EXTRACTED_TEXT_CHARS_PER_FILE = normalizePositiveInt(process.env.MAX_EXTRACTED_TEXT_CHARS_PER_FILE, 4000);
const MAX_EXTRACTED_TEXT_TOTAL_CHARS = normalizePositiveInt(process.env.MAX_EXTRACTED_TEXT_TOTAL_CHARS, 12000);
const RECENT_FILES_MAX = 20;
const MAX_GLOBAL_ACTIVE_RUNS = normalizeQueueLimit(process.env.MAX_GLOBAL_ACTIVE_RUNS, 2);
const COMPACT_CONTEXT_ON_THRESHOLD = String(process.env.COMPACT_CONTEXT_ON_THRESHOLD || 'true').toLowerCase() !== 'false';
const SEND_ACK_ON_RECEIVE = String(process.env.SEND_ACK_ON_RECEIVE || 'true').toLowerCase() !== 'false';
const PROACTIVE_FINAL_REPLY_AFTER_MS = normalizeTimeoutMs(process.env.PROACTIVE_FINAL_REPLY_AFTER_MS, 30000);
const AUTO_PROGRESS_PING_MS = normalizeTimeoutMs(process.env.AUTO_PROGRESS_PING_MS, 15000);
const MAX_AUTO_PROGRESS_PINGS = normalizeQueueLimit(process.env.MAX_AUTO_PROGRESS_PINGS, 2);
const PHASE_PROGRESS_NOTIFY = String(process.env.PHASE_PROGRESS_NOTIFY || 'true').toLowerCase() !== 'false';
const MAX_PHASE_PROGRESS_NOTICES = normalizeQueueLimit(process.env.MAX_PHASE_PROGRESS_NOTICES, 3);
const MIN_PHASE_PROGRESS_NOTIFY_MS = normalizeTimeoutMs(process.env.MIN_PHASE_PROGRESS_NOTIFY_MS, 5000);
const ENABLE_QUICK_ACTIONS = String(process.env.ENABLE_QUICK_ACTIONS || 'true').toLowerCase() !== 'false';
const RETRACT_PROGRESS_MESSAGES = String(process.env.RETRACT_PROGRESS_MESSAGES || 'false').toLowerCase() !== 'false';
const DELIVERY_AUDIT_MAX = normalizeQueueLimit(process.env.DELIVERY_AUDIT_MAX, 120);

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';
const INTENTS = {
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
};
const IDENTIFY_INTENTS = INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C;
const MAX_TEXT_CHARS = 1500;
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];
const INBOUND_DEDUPE_TTL_MS = 10 * 60 * 1000;
const INBOUND_DEDUPE_MAX = 2000;
const LOG_HISTORY_MAX = 20;
const ACTIVITY_HISTORY_MAX = 8;

let lockFd = null;
let cachedToken = null;
let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let reconnectIndex = 0;
let stopped = false;
let gatewayConnectionSeq = 0;

ensureDir(DATA_DIR);
ensureDir(WORKSPACE_ROOT);
acquireLock();

if (!QQBOT_APP_ID || !QQBOT_CLIENT_SECRET) {
  console.error('Missing QQBOT_APP_ID or QQBOT_CLIENT_SECRET in .env');
  process.exit(1);
}

const codexHealth = getCodexCliHealth();
if (!codexHealth.ok) {
  console.error(`Codex CLI unavailable: ${codexHealth.error}`);
  process.exit(1);
}

console.log(`🧩 Codex CLI: ${codexHealth.version} via ${codexHealth.bin}`);
console.log(`🤖 QQ bot mode: ${QQBOT_ENABLE_GROUP ? 'c2c + group@' : 'c2c only'}`);
console.log(`🔐 default mode: ${DEFAULT_MODE}`);
console.log(`🗂️ workspace root: ${WORKSPACE_ROOT}`);
console.log(`📦 queue limit per peer: ${MAX_QUEUE_PER_PEER === 0 ? 'unlimited' : MAX_QUEUE_PER_PEER}`);
console.log(`📎 attachments: ${DOWNLOAD_ATTACHMENTS ? `download on (max ${MAX_ATTACHMENTS_PER_MESSAGE}, ${formatBytes(MAX_ATTACHMENT_BYTES)})` : 'prompt url only'}`);
console.log(`📄 text extraction: ${EXTRACT_ATTACHMENT_TEXT ? `on (${MAX_EXTRACTED_TEXT_CHARS_PER_FILE}/${MAX_EXTRACTED_TEXT_TOTAL_CHARS} chars)` : 'off'}`);
console.log(`🚦 global concurrency: ${MAX_GLOBAL_ACTIVE_RUNS === 0 ? 'unlimited' : MAX_GLOBAL_ACTIVE_RUNS}`);
console.log(`🗜️ context compaction: ${COMPACT_CONTEXT_ON_THRESHOLD ? 'on' : 'off'}`);
console.log(`💬 receive ack: ${SEND_ACK_ON_RECEIVE ? 'on' : 'off'}`);
console.log(`📮 proactive final reply after: ${PROACTIVE_FINAL_REPLY_AFTER_MS > 0 ? `${PROACTIVE_FINAL_REPLY_AFTER_MS}ms` : 'off'}`);
console.log(`⏱️ auto progress ping: ${AUTO_PROGRESS_PING_MS > 0 && MAX_AUTO_PROGRESS_PINGS !== 0 ? `${AUTO_PROGRESS_PING_MS}ms × ${MAX_AUTO_PROGRESS_PINGS}` : 'off'}`);
console.log(`🛰️ milestone progress notify: ${PHASE_PROGRESS_NOTIFY && MAX_PHASE_PROGRESS_NOTICES !== 0 ? `on (${MAX_PHASE_PROGRESS_NOTICES}, min ${MIN_PHASE_PROGRESS_NOTIFY_MS}ms)` : 'off'}`);
console.log(`🎛️ quick actions: ${ENABLE_QUICK_ACTIONS ? 'on' : 'off'}`);
console.log(`🧹 retract progress cards: ${RETRACT_PROGRESS_MESSAGES ? 'on' : 'off'}`);

const state = loadState();
const peerRuntimes = new Map();
const inboundDeduper = new Map();
const globalRunState = {
  active: 0,
  waiters: [],
};
if (migrateLoadedState()) {
  saveState();
}

process.on('exit', releaseLock);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startGateway().catch((err) => {
  console.error('Fatal gateway error:', safeError(err));
  process.exit(1);
});

async function startGateway() {
  await connect();
}

async function connect() {
  clearHeartbeat();
  clearReconnect();
  const previousSocket = ws;
  ws = null;
  closeGatewaySocket(previousSocket, 'replace-before-reconnect');

  const accessToken = await getAccessToken();
  const gatewayUrl = await getGatewayUrl(accessToken);
  const connectionId = ++gatewayConnectionSeq;

  console.log(`🌐 Connecting QQ gateway#${connectionId}: ${gatewayUrl}`);
  const socket = new WebSocket(gatewayUrl);
  ws = socket;

  socket.on('open', () => {
    if (socket !== ws) {
      closeGatewaySocket(socket, 'stale-open');
      return;
    }
    reconnectIndex = 0;
    console.log(`✅ QQ gateway connected (#${connectionId})`);
  });

  socket.on('message', async (raw) => {
    if (socket !== ws) return;
    try {
      const payload = JSON.parse(raw.toString('utf8'));
      if (DEBUG_EVENTS) {
        console.log('[qq-event]', payload.op, payload.t || '', truncate(JSON.stringify(payload), 500));
      }
      await handleWsPayload(payload, socket, connectionId);
    } catch (err) {
      console.error('Failed to process QQ WS payload:', safeError(err));
    }
  });

  socket.on('close', (code, reason) => {
    const current = socket === ws;
    console.log(`⚠️ QQ gateway closed (#${connectionId}${current ? ', current' : ', stale'}): ${code} ${String(reason || '')}`);
    if (!current) {
      return;
    }
    ws = null;
    clearHeartbeat();
    state.gateway.lastError = `closed ${code} ${String(reason || '')}`.trim();
    handleGatewayCloseCode(code);
    saveState();
    if (!stopped) {
      scheduleReconnect(resolveReconnectDelay(code));
    }
  });

  socket.on('error', (err) => {
    if (socket !== ws) return;
    console.error('QQ gateway error:', safeError(err));
    state.gateway.lastError = safeError(err);
    saveState();
  });
}

async function handleWsPayload(payload, socket, connectionId) {
  if (socket !== ws) return;
  if (typeof payload.s === 'number') {
    state.gateway.lastSeq = payload.s;
  }
  state.gateway.lastEventAt = Date.now();

  switch (payload.op) {
    case 10: {
      const accessToken = await getAccessToken();
      const interval = payload?.d?.heartbeat_interval || 30000;
      startHeartbeat(socket, interval);
      if (state.gateway.sessionId && Number.isFinite(state.gateway.lastSeq)) {
        socket.send(JSON.stringify({
          op: 6,
          d: {
            token: `QQBot ${accessToken}`,
            session_id: state.gateway.sessionId,
            seq: state.gateway.lastSeq,
          },
        }));
        console.log(`🔄 Attempting resume (#${connectionId}): ${state.gateway.sessionId}`);
      } else {
        socket.send(JSON.stringify({
          op: 2,
          d: {
            token: `QQBot ${accessToken}`,
            intents: IDENTIFY_INTENTS,
            shard: [0, 1],
          },
        }));
        console.log(`📡 Sent identify (#${connectionId}) with intents=${IDENTIFY_INTENTS}`);
      }
      saveState();
      break;
    }
    case 0:
      await handleDispatch(payload.t, payload.d);
      break;
    case 7:
      console.log('⚠️ QQ gateway requested reconnect');
      requestGatewayReconnect('gateway requested reconnect', 500);
      break;
    case 9:
      console.log('⚠️ QQ gateway invalid session; clearing saved gateway session');
      clearGatewaySessionState('invalid session');
      saveState();
      requestGatewayReconnect('invalid session', 500);
      break;
    case 11:
      break;
    default:
      break;
  }
}

async function handleDispatch(type, data) {
  if (type === 'READY') {
    state.gateway.sessionId = data?.session_id || null;
    state.gateway.lastConnectedAt = Date.now();
    state.gateway.lastError = null;
    saveState();
    console.log(`✅ QQ READY session=${state.gateway.sessionId}`);
    return;
  }

  if (type === 'RESUMED') {
    state.gateway.lastConnectedAt = Date.now();
    state.gateway.lastError = null;
    saveState();
    console.log('✅ QQ session resumed');
    return;
  }

  let event = null;
  if (type === 'C2C_MESSAGE_CREATE') {
    event = {
      kind: 'c2c',
      peerKey: `c2c:${data.author.user_openid}`,
      senderId: String(data.author.user_openid),
      senderName: String(data.author.user_openid || ''),
      replyTarget: String(data.author.user_openid),
      messageId: String(data.id),
      timestampMs: Date.parse(data.timestamp) || Date.now(),
      rawContent: String(data.content || ''),
      attachments: normalizeAttachments(data.attachments),
      groupOpenid: null,
    };
  } else if (QQBOT_ENABLE_GROUP && type === 'GROUP_AT_MESSAGE_CREATE') {
    event = {
      kind: 'group',
      peerKey: `group:${data.group_openid}`,
      senderId: String(data.author.member_openid),
      senderName: String(data.author.member_openid || ''),
      replyTarget: String(data.group_openid),
      messageId: String(data.id),
      timestampMs: Date.parse(data.timestamp) || Date.now(),
      rawContent: String(data.content || ''),
      attachments: normalizeAttachments(data.attachments),
      groupOpenid: String(data.group_openid),
    };
  }

  if (!event) return;
  if (isDuplicateInboundMessage(event.messageId)) return;
  incrementTelemetry('inboundMessages');
  recordAudit('inbound', event, truncate(normalizeIncomingContent(event.rawContent), 120), {
    attachments: Array.isArray(event.attachments) ? event.attachments.length : 0,
  });

  const access = getAccessDecision(event);
  if (!access.allowed) {
    if (access.reply) {
      await replyText(event, access.message);
    }
    return;
  }

  console.log(`[msg] peer=${event.peerKey} sender=${event.senderId} kind=${event.kind} len=${event.rawContent.length} attachments=${event.attachments.length}`);

  const content = normalizeIncomingContent(event.rawContent);
  if (!content && event.attachments.length === 0) return;

  if (isImmediateCommand(content)) {
    await handleImmediateCommand(event, content);
    return;
  }

  await enqueuePrompt(event, {
    text: content,
    attachments: event.attachments,
  });
}

function getAccessDecision(event) {
  if (event.kind === 'group') {
    if (!QQBOT_ENABLE_GROUP) {
      return { allowed: false, reply: false, message: '' };
    }
    if (QQBOT_ALLOW_GROUPS && !QQBOT_ALLOW_GROUPS.has(event.groupOpenid)) {
      return { allowed: false, reply: false, message: '' };
    }
  }
  if (!isAllowedSender(event.senderId)) {
    return {
      allowed: false,
      reply: event.kind === 'c2c',
      message: '⛔ 当前用户未授权使用该 Codex QQ bot。',
    };
  }
  return { allowed: true, reply: false, message: '' };
}

async function handleImmediateCommand(event, content) {
  const session = getPeerSession(event.peerKey, event.kind);
  const runtime = getPeerRuntime(event.peerKey);
  const [command, ...rest] = content.trim().split(/\s+/);
  const cmd = normalizeCommandAlias(command.toLowerCase());

  if (cmd === '/help') {
    await replyText(event, buildHelpMessage(), { quickActions: true, uiCategory: 'help', replaceUiCard: true });
    return;
  }

  if (cmd === '/whoami') {
    await replyText(event, [
      '当前身份信息',
      `sender openid: ${event.senderId}`,
      `peer key: ${event.peerKey}`,
      `chat kind: ${event.kind}`,
      ...(event.groupOpenid ? [`group openid: ${event.groupOpenid}`] : []),
    ].join('\n'));
    return;
  }

  if (cmd === '/status') {
    await replyText(event, formatStatusMessage(event, session, runtime), { quickActions: true, uiCategory: 'status', replaceUiCard: true });
    return;
  }

  if (cmd === '/session') {
    await replyText(event, formatSessionMessage(session), { quickActions: true, uiCategory: 'session', replaceUiCard: true });
    return;
  }

  if (cmd === '/sessions') {
    await replyText(event, formatSessionHistoryMessage(session), { quickActions: true, uiCategory: 'sessions', replaceUiCard: true });
    return;
  }

  if (cmd === '/new') {
    if (session.codexThreadId) {
      rememberSessionId(session, session.codexThreadId, session.lastInputTokens, 'manual-new');
    }
    const cancelled = cancelPeerRun(event.peerKey, 'new session');
    resetPeerSession(session);
    clearPendingSummary(session);
    saveState();
    const lines = ['🆕 已切换为新会话。'];
    if (cancelled.active) lines.push('当前运行中的任务已尝试取消。');
    if (cancelled.clearedQueued > 0) lines.push(`已清空 ${cancelled.clearedQueued} 个排队任务。`);
    lines.push('下一条普通消息会开启新的 Codex 会话。');
    lines.push('旧会话 ID 已保留，可用 `/sessions` 查看后再 `/resume <id>`。');
    await replyText(event, lines.join('\n'), { quickActions: true, uiCategory: 'status', replaceUiCard: true });
    return;
  }

  if (cmd === '/files') {
    await replyText(event, formatRecentFilesMessage(session), { quickActions: true, uiCategory: 'files', replaceUiCard: true });
    return;
  }

  if (cmd === '/progress') {
    await replyText(event, formatProgressMessage(session, runtime), { quickActions: true, uiCategory: 'progress', replaceUiCard: true });
    return;
  }

  if (cmd === '/diag') {
    await replyText(event, formatDiagnosticsMessage(event), { quickActions: true, uiCategory: 'diag', replaceUiCard: true });
    return;
  }

  if (cmd === '/stats') {
    await replyText(event, formatStatsMessage(), { quickActions: true, uiCategory: 'diag', replaceUiCard: true });
    return;
  }

  if (cmd === '/audit') {
    await replyText(event, formatAuditMessage(event.peerKey), { quickActions: true, uiCategory: 'diag', replaceUiCard: true });
    return;
  }

  if (cmd === '/cancel') {
    const cancelled = cancelPeerRun(event.peerKey, 'user requested cancel');
    recordAudit('cancel-request', event, `active=${cancelled.active} queued=${cancelled.clearedQueued}`);
    if (cancelled.active || cancelled.clearedQueued > 0) {
      const parts = [cancelled.alreadyCancelling ? '🛑 取消请求已在处理中。' : '🛑 已发送取消请求。'];
      if (cancelled.active) {
        parts.push('当前运行中的任务会尽快终止。');
        if (cancelled.activePhase) parts.push(`阶段：${formatRunPhaseLabel(cancelled.activePhase)}`);
        if (cancelled.activeElapsedMs) parts.push(`已运行：${formatDuration(cancelled.activeElapsedMs)}`);
        if (cancelled.activeLatest) parts.push(`最近进展：${cancelled.activeLatest}`);
      }
      if (cancelled.clearedQueued > 0) parts.push(`已清空 ${cancelled.clearedQueued} 个排队任务。`);
      await replyText(event, parts.join('\n'), { quickActions: true, uiCategory: 'progress', replaceUiCard: true });
    } else {
      await replyText(event, '当前没有运行中的任务，也没有排队任务。', { quickActions: true, uiCategory: 'progress', replaceUiCard: true });
    }
    return;
  }

  if (cmd === '/reset') {
    const cancelled = cancelPeerRun(event.peerKey, 'reset');
    resetPeerSession(session);
    saveState();
    const lines = ['✅ 已重置当前会话。'];
    if (cancelled.active) lines.push('并已尝试取消当前运行中的任务。');
    if (cancelled.clearedQueued > 0) lines.push(`并清空了 ${cancelled.clearedQueued} 个排队任务。`);
    await replyText(event, lines.join('\n'), { quickActions: true, uiCategory: 'status', replaceUiCard: true });
    return;
  }

  if (cmd === '/resume') {
    const raw = rest.join(' ').trim();
    if (!raw) {
      await replyText(event, '用法：/resume <session_id|clear>');
      return;
    }
    const normalized = raw.toLowerCase();
    if (normalized === 'clear' || normalized === 'off' || normalized === 'new' || normalized === 'default') {
      if (session.codexThreadId) {
        rememberSessionId(session, session.codexThreadId, session.lastInputTokens, 'resume-clear');
      }
      session.codexThreadId = null;
      session.lastInputTokens = null;
      clearPendingSummary(session);
      session.updatedAt = new Date().toISOString();
      saveState();
      await replyText(event, '✅ 已清除当前绑定的 Codex session。下条消息会新建会话。');
      return;
    }
    session.codexThreadId = raw;
    session.lastInputTokens = null;
    session.updatedAt = new Date().toISOString();
    saveState();
    await replyText(event, `✅ 已绑定 Codex session：${session.codexThreadId}`);
    return;
  }

  if (cmd === '/mode') {
    const nextMode = String(rest[0] || '').trim().toLowerCase();
    if (nextMode !== 'safe' && nextMode !== 'dangerous') {
      await replyText(event, '用法：/mode safe 或 /mode dangerous');
      return;
    }
    session.mode = nextMode;
    session.updatedAt = new Date().toISOString();
    saveState();
    await replyText(event, `✅ 当前会话模式已切换为 ${nextMode}`);
    return;
  }

  if (cmd === '/profile') {
    const profileName = normalizeProfileName(String(rest[0] || '').trim());
    if (!profileName || profileName === 'unknown') {
      await replyText(event, `用法：/profile default|code|docs|review|image\n当前 profile：${session.profile || 'default'}`);
      return;
    }
    applyProfileToSession(session, profileName);
    session.updatedAt = new Date().toISOString();
    saveState();
    await replyText(event, `✅ 已切换 profile：${profileName}\n${formatSessionProfileSummary(session)}`, { quickActions: true, uiCategory: 'status', replaceUiCard: true });
    return;
  }

  if (cmd === '/model') {
    const raw = rest.join(' ').trim();
    if (!raw) {
      await replyText(event, '用法：/model <模型名|default>');
      return;
    }
    session.model = raw.toLowerCase() === 'default' ? null : raw;
    session.updatedAt = new Date().toISOString();
    saveState();
    await replyText(event, `✅ 当前会话模型：${session.model || '(default)'}`);
    return;
  }

  if (cmd === '/effort') {
    const nextEffort = normalizeEffort(rest[0] || '');
    if (!nextEffort && String(rest[0] || '').trim().toLowerCase() !== 'default') {
      await replyText(event, '用法：/effort low | medium | high | default');
      return;
    }
    session.effort = String(rest[0] || '').trim().toLowerCase() === 'default' ? null : nextEffort;
    session.updatedAt = new Date().toISOString();
    saveState();
    await replyText(event, `✅ 当前会话推理强度：${session.effort || '(default)'}`);
    return;
  }

  await replyText(event, '未知命令，发 `/help` 查看可用命令。');
}

async function enqueuePrompt(event, promptInput) {
  const runtime = getPeerRuntime(event.peerKey);
  const session = getPeerSession(event.peerKey, event.kind);
  if (MAX_QUEUE_PER_PEER > 0 && runtime.queue.length >= MAX_QUEUE_PER_PEER) {
    await replyText(event, `⛔ 当前会话排队已满（上限 ${MAX_QUEUE_PER_PEER}）。请稍后重试，或先发 /cancel 清队列。`);
    return;
  }

  const queuedBefore = runtime.queue.length + (runtime.activeRun ? 1 : 0);
  runtime.queue.push({
    event,
    promptInput,
    enqueuedAt: Date.now(),
  });

  if (queuedBefore > 0) {
    await replyText(event, buildQueueAckMessage(session, queuedBefore, promptInput), { quickActions: true, uiCategory: 'progress', replaceUiCard: true });
  } else if (SEND_ACK_ON_RECEIVE) {
    await replyText(event, buildReceiveAckMessage(session, promptInput), { quickActions: true, uiCategory: 'progress', replaceUiCard: true });
  }

  void processPeerQueue(event.peerKey);
}

async function processPeerQueue(peerKey) {
  const runtime = getPeerRuntime(peerKey);
  if (runtime.processing) return;
  runtime.processing = true;

  try {
    while (!stopped && !runtime.activeRun && runtime.queue.length > 0) {
      const job = runtime.queue.shift();
      if (!job) break;
      const session = getPeerSession(peerKey, job.event.kind);
      await executeJob(job, session, runtime);
    }
  } finally {
    runtime.processing = false;
  }
}

async function executeJob(job, session, runtime) {
  const activeRun = {
    peerKey: job.event.peerKey,
    promptPreview: truncate(describePromptInput(job.promptInput), 120),
    startedAt: Date.now(),
    updatedAt: Date.now(),
    phase: 'starting',
    latestActivity: '任务已开始，等待 Codex 首个事件…',
    eventCount: 0,
    recentActivities: [],
    logs: [],
    child: null,
    cancelRequested: false,
    suppressCancellationReply: false,
    retryCount: 0,
    phaseNoticeCount: 0,
    lastPhaseNoticeAt: 0,
    lastPhaseNoticePhase: '',
    sourceMessageId: job.event.messageId,
  };
  runtime.activeRun = activeRun;
  let releaseGlobalSlot = () => {};
  let progressPingTimer = null;

  try {
    await clearPeerUiCards(job.event, ['status', 'session', 'sessions', 'files', 'diag']);
    if (job.event.kind === 'c2c') {
      await safeSendInputNotify(job.event);
    }

    const notes = [];
    const preparedInput = await preparePromptInput({
      event: job.event,
      session,
      promptInput: job.promptInput,
      activeRun,
    });
    notes.push(...preparedInput.notes);

    if (session.pendingSummary) {
      preparedInput.prompt = buildPromptFromCompactedContext(session.pendingSummary, preparedInput.prompt);
      notes.push(`已自动继承压缩摘要${session.pendingSummarySourceSessionId ? `（来源会话：${session.pendingSummarySourceSessionId}）` : ''}`);
      preparedInput.usedPendingSummary = true;
    }

    if (shouldCompactSession(session)) {
      const compacted = await compactSessionContext({ session, activeRun, event: job.event, runtime });
      if (compacted.ok && compacted.summary) {
        const previous = session.codexThreadId;
        storePendingSummary(session, compacted.summary, previous);
        session.codexThreadId = null;
        session.lastInputTokens = null;
        session.updatedAt = new Date().toISOString();
        saveState();
        preparedInput.prompt = buildPromptFromCompactedContext(compacted.summary, preparedInput.prompt);
        preparedInput.usedPendingSummary = true;
        notes.push(`上下文 token 已达到阈值 ${MAX_INPUT_TOKENS_BEFORE_RESET}，已自动压缩并切到新会话：${previous}`);
      } else {
        const previous = session.codexThreadId;
        session.codexThreadId = null;
        session.lastInputTokens = null;
        session.updatedAt = new Date().toISOString();
        saveState();
        notes.push(`上下文 token 已达到阈值 ${MAX_INPUT_TOKENS_BEFORE_RESET}，压缩失败后已重置旧会话：${previous}`);
        if (compacted.error) notes.push(`压缩失败原因：${compacted.error}`);
      }
    } else if (shouldAutoResetSession(session)) {
      const previous = session.codexThreadId;
      session.codexThreadId = null;
      session.lastInputTokens = null;
      session.updatedAt = new Date().toISOString();
      saveState();
      notes.push(`上下文 token 已达到阈值 ${MAX_INPUT_TOKENS_BEFORE_RESET}，已自动重置旧会话：${previous}`);
    }

    releaseGlobalSlot = await acquireGlobalRunSlot(job.event, runtime, activeRun);
    progressPingTimer = createAutoProgressPing(job.event, runtime, activeRun);

    let result = activeRun.cancelRequested
      ? buildCancelledRunResult('cancelled before execution slot acquired')
      : await runCodex({
        session,
        prompt: preparedInput.prompt,
        imagePaths: preparedInput.imagePaths,
        activeRun,
        event: job.event,
        runtime,
      });

    if (!result.ok && session.codexThreadId && shouldRetryFreshSession(result)) {
      const previous = session.codexThreadId;
      session.codexThreadId = null;
      session.updatedAt = new Date().toISOString();
      saveState();
      activeRun.retryCount += 1;
      activeRun.phase = 'retrying';
      activeRun.latestActivity = `旧会话恢复失败，已自动 reset 后重试（旧会话：${previous}）`;
      rememberActivity(activeRun, activeRun.latestActivity);
      maybeNotifyRunMilestone(job.event, runtime, activeRun);
      result = await runCodex({
        session,
        prompt: preparedInput.prompt,
        imagePaths: preparedInput.imagePaths,
        activeRun,
        event: job.event,
        runtime,
      });
      if (result.ok) {
        notes.push(`旧会话恢复失败后已自动 reset：${previous}`);
      }
    }

    updateSessionFromResult(session, result, job.event.kind);
    if (result.ok && preparedInput.usedPendingSummary) {
      clearPendingSummary(session);
    }
    session.lastRun = buildLastRunSnapshot(activeRun, result);
    saveState();

    const wasCancelled = result.cancelled || activeRun.cancelRequested;
    const suppressCancelReply = activeRun.suppressCancellationReply;

    if (wasCancelled) {
      await clearPeerUiCards(job.event, ['progress']);
      incrementTelemetry('cancelledRuns');
      recordAudit('run-cancelled', job.event, activeRun.latestActivity || 'cancelled');
      if (!suppressCancelReply) {
        await replyText(job.event, '🛑 当前任务已取消。', { quickActions: true, uiCategory: 'progress', replaceUiCard: true });
      }
      return;
    }

    if (!result.ok) {
      await clearPeerUiCards(job.event, ['progress']);
      incrementTelemetry('failedRuns');
      recordAudit('run-failed', job.event, result.error || '(unknown)');
      const logsPreview = result.logs.length ? truncate(result.logs.join('\n'), 1200) : '(none)';
      await replyText(job.event, [
        '❌ Codex 执行失败',
        `error: ${result.error || 'unknown'}`,
        `logs: ${logsPreview}`,
        ...(notes.length ? [`notes: ${notes.join(' | ')}`] : []),
        '你可以先发 `/reset` 再试一次，或发 `/progress` 查看最近状态。',
      ].join('\n'), { quickActions: true, uiCategory: 'progress', replaceUiCard: true });
      return;
    }

    let answer = result.finalAnswer || result.messages.join('\n\n').trim() || '已完成，但没有可发送的文本结果。';
    if (SHOW_REASONING && result.reasonings.length) {
      answer = [
        '【Reasoning】',
        result.reasonings.join('\n\n'),
        '',
        '【Answer】',
        answer,
      ].join('\n');
    }
    if (notes.length) {
      answer = [`[系统提示] ${notes.join('；')}`, '', answer].join('\n');
    }
    await clearPeerUiCards(job.event, ['progress']);
    incrementTelemetry('completedRuns');
    recordAudit('run-completed', job.event, truncate(answer, 160), {
      threadId: result.threadId || '',
    });
    const preferProactive = job.event.kind === 'c2c'
      && PROACTIVE_FINAL_REPLY_AFTER_MS > 0
      && (Date.now() - activeRun.startedAt) >= PROACTIVE_FINAL_REPLY_AFTER_MS;
    await replyText(job.event, answer, { preferProactive });
  } finally {
    if (progressPingTimer) {
      clearInterval(progressPingTimer);
    }
    releaseGlobalSlot();
    if (runtime.activeRun === activeRun) {
      runtime.activeRun = null;
    }
  }
}

async function runCodex({ session, prompt, imagePaths, activeRun, event = null, runtime = null }) {
  const workspaceDir = resolveWorkspaceDir(session.workspaceDir || path.join(WORKSPACE_ROOT, sanitizePeerKey(activeRun.peerKey)));
  session.workspaceDir = workspaceDir;
  ensureDir(workspaceDir);
  ensureGitRepo(workspaceDir);

  const args = buildCodexArgs({ session, workspaceDir, prompt, imagePaths });
  return await spawnCodex(args, workspaceDir, {
    timeoutMs: CODEX_TIMEOUT_MS,
    onSpawn(child) {
      activeRun.child = child;
    },
    onEvent(ev) {
      const summary = summarizeCodexEvent(ev);
      if (summary) {
        activeRun.eventCount += 1;
        activeRun.phase = summary.phase;
        activeRun.latestActivity = summary.text;
        activeRun.updatedAt = Date.now();
        rememberActivity(activeRun, summary.text);
        if (event && runtime) {
          maybeNotifyRunMilestone(event, runtime, activeRun);
        }
      }
    },
    onLog(line) {
      if (isNoisyCodexLog(line)) return;
      activeRun.logs.push(line);
      if (activeRun.logs.length > LOG_HISTORY_MAX) activeRun.logs.shift();
      activeRun.latestActivity = line;
      activeRun.updatedAt = Date.now();
      rememberActivity(activeRun, line);
    },
    wasCancelled() {
      return Boolean(activeRun.cancelRequested);
    },
  });
}

function buildCodexArgs({ session, workspaceDir, prompt, imagePaths = [] }) {
  const args = ['exec'];

  if (session.codexThreadId) {
    args.push('resume');
  }

  args.push('--json');
  args.push('--skip-git-repo-check');
  args.push(session.mode === 'safe' ? '--full-auto' : '--dangerously-bypass-approvals-and-sandbox');

  const model = session.model || DEFAULT_MODEL;
  const effort = session.effort || DEFAULT_EFFORT;
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  for (const imagePath of imagePaths.slice(0, MAX_IMAGE_ATTACHMENTS)) {
    args.push('-i', imagePath);
  }

  if (session.codexThreadId) {
    args.push(session.codexThreadId, prompt);
  } else {
    args.push('-C', workspaceDir, prompt);
  }

  return args;
}

function spawnCodex(args, cwd, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(CODEX_BIN, args, {
      cwd,
      env: buildSpawnEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    options.onSpawn?.(child);

    let stdoutBuf = '';
    let stderrBuf = '';
    let threadId = null;
    let usage = null;
    let resolved = false;
    let timedOut = false;
    const messages = [];
    const finalAnswerMessages = [];
    const reasonings = [];
    const logs = [];

    const timeoutMs = normalizeTimeoutMs(options.timeoutMs, 0);
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        logs.push(`Timeout after ${timeoutMs}ms`);
        stopChildProcess(child);
      }, timeoutMs)
      : null;

    const handleLine = (line, source) => {
      const trimmed = String(line || '').trim();
      if (!trimmed) return;
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const ev = JSON.parse(trimmed);
          if (ev.type === 'thread.started') {
            threadId = ev.thread_id || threadId;
          } else if (ev.type === 'turn.completed') {
            usage = ev.usage || usage;
          } else if (ev.type === 'item.completed') {
            if (ev.item?.type === 'agent_message') {
              const text = extractAgentMessageText(ev.item);
              if (text) {
                messages.push(text);
                finalAnswerMessages.push(text);
              }
            }
            if (ev.item?.type === 'reasoning' && ev.item?.text) {
              const reasoning = String(ev.item.text).trim();
              if (reasoning) reasonings.push(reasoning);
            }
          } else if (ev.type === 'error') {
            logs.push(typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error));
          }
          options.onEvent?.(ev);
          return;
        } catch {
        }
      }
      if (source === 'stderr') {
        logs.push(trimmed);
        options.onLog?.(trimmed, source);
      }
    };

    const onData = (chunk, source) => {
      let buffer = source === 'stdout' ? stdoutBuf : stderrBuf;
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line, source);
      if (source === 'stdout') stdoutBuf = buffer;
      else stderrBuf = buffer;
    };

    child.stdout.on('data', (chunk) => onData(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => onData(chunk, 'stderr'));

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      if (timeout) clearTimeout(timeout);
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        messages,
        finalAnswer: '',
        reasonings,
        usage,
        threadId,
        logs: [...logs, safeError(err)],
        error: safeError(err),
        timedOut,
        cancelled: Boolean(options.wasCancelled?.()),
      });
    });

    child.on('close', (exitCode, signal) => {
      if (resolved) return;
      resolved = true;
      if (timeout) clearTimeout(timeout);
      if (stdoutBuf.trim()) handleLine(stdoutBuf, 'stdout');
      if (stderrBuf.trim()) handleLine(stderrBuf, 'stderr');

      const cancelled = Boolean(options.wasCancelled?.());
      const ok = exitCode === 0 && !cancelled && !timedOut;
      const error = ok
        ? null
        : timedOut
          ? `timeout after ${timeoutMs}ms`
          : cancelled
            ? `cancelled (${signal || `exit=${exitCode}`})`
            : `exit=${exitCode}${signal ? ` signal=${signal}` : ''}`;

      resolve({
        ok,
        exitCode,
        signal,
        messages,
        finalAnswer: finalAnswerMessages.join('\n\n').trim(),
        reasonings,
        usage,
        threadId,
        logs,
        error,
        timedOut,
        cancelled,
      });
    });
  });
}

async function replyText(event, text, options = {}) {
  const chunks = splitForChat(text, MAX_TEXT_CHARS);
  const sent = [];
  if (options.replaceUiCard && options.uiCategory) {
    await clearPeerUiCards(event, [options.uiCategory]);
  }
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    try {
      const payload = await sendTextMessage(event, chunk, index === 0 ? event.messageId : undefined, {
        preferProactive: Boolean(options.preferProactive) && index === 0,
        quickActions: Boolean(options.quickActions) && index === 0 && chunks.length === 1,
        uiCategory: index === 0 ? options.uiCategory || '' : '',
      });
      if (payload?.id) sent.push(payload);
    } catch (err) {
      incrementTelemetry('outboundFailures');
      recordAudit('outbound-failed', event, safeError(err), {
        category: options.uiCategory || '',
      });
      console.error('replyText failed:', safeError(err));
      break;
    }
  }
  if (options.uiCategory && sent[0]?.id) {
    rememberPeerUiCard(event.peerKey, options.uiCategory, sent[0].id);
  }
  return sent;
}

async function sendTextMessage(event, content, replyToMessageId, options = {}) {
  const token = await getAccessToken();
  const canUseQuickActions = ENABLE_QUICK_ACTIONS
    && Boolean(options.quickActions)
    && !String(content || '').includes('```')
    && String(content || '').length <= 900;
  if (canUseQuickActions) {
    try {
      const interactive = await sendInteractiveMessage(token, event, String(content || ''), replyToMessageId, {
        preferProactive: Boolean(options.preferProactive),
        uiCategory: options.uiCategory || '',
      });
      incrementTelemetry('outboundMessages');
      recordAudit('outbound', event, `interactive:${options.uiCategory || 'general'}`, {
        messageId: interactive?.id || '',
      });
      return interactive;
    } catch (err) {
      console.error(`interactive send failed, fallback to text: ${safeError(err)}`);
    }
  }
  if (event.kind === 'group') {
    const payload = await sendGroupMessage(token, event.replyTarget, content, replyToMessageId);
    console.log(`[send] group reply len=${content.length} passive=${Boolean(replyToMessageId)}`);
    incrementTelemetry('outboundMessages');
    recordAudit('outbound', event, `text:${options.uiCategory || 'general'}`, {
      messageId: payload?.id || '',
    });
    return payload;
  }
  const shouldPreferProactive = Boolean(options.preferProactive);
  if (shouldPreferProactive) {
    try {
      const payload = await sendC2CMessage(token, event.replyTarget, content);
      console.log(`[send] c2c proactive len=${content.length}`);
      incrementTelemetry('outboundMessages');
      recordAudit('outbound', event, `text-proactive:${options.uiCategory || 'general'}`, {
        messageId: payload?.id || '',
      });
      return payload;
    } catch (err) {
      console.error(`proactive send failed, fallback to passive: ${safeError(err)}`);
    }
  }

  try {
    const payload = await sendC2CMessage(token, event.replyTarget, content, replyToMessageId);
    console.log(`[send] c2c passive len=${content.length} replyTo=${replyToMessageId || '(none)'}`);
    incrementTelemetry('outboundMessages');
    recordAudit('outbound', event, `text-passive:${options.uiCategory || 'general'}`, {
      messageId: payload?.id || '',
    });
    return payload;
  } catch (err) {
    if (replyToMessageId) {
      console.error(`passive send failed, fallback to proactive: ${safeError(err)}`);
      const payload = await sendC2CMessage(token, event.replyTarget, content);
      console.log(`[send] c2c proactive-fallback len=${content.length}`);
      incrementTelemetry('outboundMessages');
      recordAudit('outbound', event, `text-proactive-fallback:${options.uiCategory || 'general'}`, {
        messageId: payload?.id || '',
      });
      return payload;
    }
    throw err;
  }
}

async function sendInteractiveMessage(accessToken, event, markdownContent, replyToMessageId, options = {}) {
  const body = {
    msg_type: 2,
    markdown: {
      content: markdownContent,
    },
    keyboard: buildQuickActionKeyboard(event, options.uiCategory || 'general'),
    msg_seq: nextMsgSeq(),
    ...(replyToMessageId && !options.preferProactive ? { msg_id: replyToMessageId } : {}),
  };
  if (event.kind === 'group') {
    return await apiRequest(accessToken, 'POST', `/v2/groups/${event.replyTarget}/messages`, body);
  }
  return await apiRequest(accessToken, 'POST', `/v2/users/${event.replyTarget}/messages`, body);
}

async function safeSendInputNotify(event) {
  if (event.kind !== 'c2c') return;
  try {
    const token = await getAccessToken();
    await sendC2CInputNotify(token, event.replyTarget, event.messageId, 60);
  } catch (err) {
    console.error('send input notify failed:', safeError(err));
  }
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 5 * 60 * 1000) {
    return cachedToken.token;
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: QQBOT_APP_ID,
      clientSecret: QQBOT_CLIENT_SECRET,
    }),
  });

  const payload = await response.json();
  if (!response.ok || !payload?.access_token) {
    throw new Error(`getAccessToken failed: ${JSON.stringify(payload)}`);
  }

  cachedToken = {
    token: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in || 7200) * 1000,
  };
  return cachedToken.token;
}

async function getGatewayUrl(accessToken) {
  const payload = await apiRequest(accessToken, 'GET', '/gateway');
  return payload.url;
}

async function sendC2CInputNotify(accessToken, openid, msgId, seconds = 60) {
  const body = {
    msg_type: 6,
    input_notify: {
      input_type: 1,
      input_second: seconds,
    },
    msg_seq: nextMsgSeq(),
    ...(msgId ? { msg_id: msgId } : {}),
  };
  await apiRequest(accessToken, 'POST', `/v2/users/${openid}/messages`, body);
}

async function sendC2CMessage(accessToken, openid, content, msgId) {
  const body = {
    content,
    msg_type: 0,
    msg_seq: nextMsgSeq(),
    ...(msgId ? { msg_id: msgId } : {}),
  };
  return await apiRequest(accessToken, 'POST', `/v2/users/${openid}/messages`, body);
}

async function sendGroupMessage(accessToken, groupOpenid, content, msgId) {
  const body = {
    content,
    msg_type: 0,
    msg_seq: nextMsgSeq(),
    ...(msgId ? { msg_id: msgId } : {}),
  };
  return await apiRequest(accessToken, 'POST', `/v2/groups/${groupOpenid}/messages`, body);
}

function buildQuickActionKeyboard(event, category = 'general') {
  const session = getPeerSession(event.peerKey, event.kind);
  const runtime = getPeerRuntime(event.peerKey);
  const firstRow = runtime.activeRun
    ? [
      buildKeyboardButton('进展', '/progress', 1),
      buildKeyboardButton('状态', '/status', 0),
    ]
    : [
      buildKeyboardButton('新会', '/new', 1),
      buildKeyboardButton('状态', '/status', 0),
    ];
  const secondRow = runtime.activeRun
    ? [
      buildKeyboardButton('停止', '/stop', 4, '将终止当前任务'),
      buildKeyboardButton('新会', '/new', 1),
    ]
    : [
      buildKeyboardButton('历史', '/sessions', 0),
      buildKeyboardButton('文件', '/files', 0),
    ];
  const thirdRow = runtime.activeRun
    ? [
      buildKeyboardButton('文件', '/files', 0),
      buildKeyboardButton('诊断', '/diag', 0),
    ]
    : [
      buildKeyboardButton('诊断', '/diag', 0),
      buildKeyboardButton(session.mode === 'dangerous' ? 'Safe' : 'Danger', session.mode === 'dangerous' ? '/mode safe' : '/mode dangerous', session.mode === 'dangerous' ? 0 : 3),
    ];
  if (category === 'help') {
    thirdRow[0] = buildKeyboardButton('帮助', '/help', 0);
  }
  return {
    content: {
      rows: [
        { buttons: firstRow },
        { buttons: secondRow },
        { buttons: thirdRow },
      ],
    },
  };
}

function buildKeyboardButton(label, command, style = 0, confirmText = '') {
  return {
    id: `${sanitizeFilename(label)}-${Math.random().toString(36).slice(2, 8)}`,
    render_data: {
      label,
      visited_label: label,
      style,
    },
    action: {
      type: 2,
      permission: {
        type: 2,
      },
      click_limit: 999,
      data: command,
      enter: true,
      at_bot_show_channel_list: false,
      ...(confirmText ? {
        modal: {
          content: confirmText,
          confirm_text: '确认',
          cancel_text: '取消',
        },
      } : {}),
    },
  };
}

function rememberPeerUiCard(peerKey, category, messageId) {
  if (!category || !messageId) return;
  const runtime = getPeerRuntime(peerKey);
  runtime.uiCards[category] = {
    messageId,
    updatedAt: Date.now(),
  };
}

async function clearPeerUiCards(event, categories) {
  if (!RETRACT_PROGRESS_MESSAGES) return;
  const runtime = getPeerRuntime(event.peerKey);
  for (const category of categories) {
    const item = runtime.uiCards?.[category];
    if (!item?.messageId) continue;
    try {
      await retractMessage(event, item.messageId);
      incrementTelemetry('retracts');
      recordAudit('retract', event, `${category}:${item.messageId}`);
    } catch (err) {
      console.error(`retract ${category} failed:`, safeError(err));
    }
    delete runtime.uiCards[category];
  }
}

async function retractMessage(event, messageId) {
  const token = await getAccessToken();
  if (event.kind === 'group') {
    return await apiRequest(token, 'DELETE', `/v2/groups/${event.replyTarget}/messages/${messageId}`);
  }
  return await apiRequest(token, 'DELETE', `/v2/users/${event.replyTarget}/messages/${messageId}`);
}

async function apiRequest(accessToken, method, requestPath, body, hasRetried = false) {
  const response = await fetch(`${API_BASE}${requestPath}`, {
    method,
    headers: {
      Authorization: `QQBot ${accessToken}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const raw = await response.text();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { raw };
  }

  if (response.ok) {
    return payload;
  }

  const maybeExpired = response.status === 401 || payload?.code === 11243 || payload?.code === 11244;
  if (maybeExpired && !hasRetried) {
    cachedToken = null;
    const nextToken = await getAccessToken();
    return await apiRequest(nextToken, method, requestPath, body, true);
  }

  throw new Error(`QQ API ${requestPath} failed (${response.status}): ${truncate(JSON.stringify(payload), 400)}`);
}

function getPeerSession(peerKey, kind) {
  if (!state.peers[peerKey]) {
    state.peers[peerKey] = {
      kind,
      workspaceDir: resolveWorkspaceDir(path.join(WORKSPACE_ROOT, sanitizePeerKey(peerKey))),
      codexThreadId: null,
      lastInputTokens: null,
      mode: DEFAULT_MODE,
      model: null,
      effort: null,
      profile: 'default',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastRun: null,
      recentFiles: [],
      sessionHistory: [],
      pendingSummary: null,
      pendingSummarySourceSessionId: null,
      pendingSummaryCreatedAt: null,
    };
    saveState();
  }
  const session = state.peers[peerKey];
  if (normalizePeerSessionState(peerKey, session, kind)) {
    saveState();
  }
  return session;
}

function getPeerRuntime(peerKey) {
  if (!peerRuntimes.has(peerKey)) {
    peerRuntimes.set(peerKey, {
      queue: [],
      processing: false,
      activeRun: null,
      uiCards: {},
    });
  }
  return peerRuntimes.get(peerKey);
}

function cancelPeerRun(peerKey, reason) {
  const runtime = getPeerRuntime(peerKey);
  const active = Boolean(runtime.activeRun);
  const alreadyCancelling = Boolean(runtime.activeRun?.cancelRequested);
  const clearedQueued = runtime.queue.length;
  const activePhase = runtime.activeRun?.phase || '';
  const activeLatest = runtime.activeRun?.latestActivity || '';
  const activeElapsedMs = runtime.activeRun ? Date.now() - runtime.activeRun.startedAt : 0;

  if (runtime.activeRun) {
    runtime.activeRun.cancelRequested = true;
    runtime.activeRun.suppressCancellationReply = true;
    runtime.activeRun.latestActivity = `收到取消请求：${reason}`;
    runtime.activeRun.updatedAt = Date.now();
    rememberActivity(runtime.activeRun, runtime.activeRun.latestActivity);
    stopChildProcess(runtime.activeRun.child);
  }

  runtime.queue.length = 0;
  return { active, alreadyCancelling, clearedQueued, activePhase, activeLatest, activeElapsedMs };
}

function stopChildProcess(child) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      if (!child.killed) child.kill('SIGKILL');
    } catch {
    }
  }, 1500);
}

function updateSessionFromResult(session, result, kind) {
  if (result.threadId) {
    session.codexThreadId = result.threadId;
    rememberSessionId(session, result.threadId, result.usage?.input_tokens, 'run');
  } else if (!result.ok && kind === 'group') {
    session.codexThreadId = session.codexThreadId || null;
  }
  if (Number.isFinite(result.usage?.input_tokens)) {
    session.lastInputTokens = result.usage.input_tokens;
  }
  session.updatedAt = new Date().toISOString();
}

function buildLastRunSnapshot(activeRun, result) {
  return {
    ok: result.ok,
    error: result.error,
    cancelled: result.cancelled,
    timedOut: result.timedOut,
    startedAt: new Date(activeRun.startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - activeRun.startedAt,
    eventCount: activeRun.eventCount,
    latestActivity: activeRun.latestActivity,
    recentActivities: [...activeRun.recentActivities],
    logs: [...activeRun.logs].slice(-6),
  };
}

function shouldAutoResetSession(session) {
  return Boolean(session.codexThreadId && Number.isFinite(session.lastInputTokens) && session.lastInputTokens >= MAX_INPUT_TOKENS_BEFORE_RESET);
}

function shouldCompactSession(session) {
  return shouldCompactByTokens({
    enabled: COMPACT_CONTEXT_ON_THRESHOLD,
    sessionId: session?.codexThreadId,
    lastInputTokens: session?.lastInputTokens,
    threshold: MAX_INPUT_TOKENS_BEFORE_RESET,
  });
}

async function compactSessionContext({ session, activeRun, event = null, runtime = null }) {
  if (!session?.codexThreadId) {
    return { ok: false, summary: '', error: 'missing codex session id' };
  }

  activeRun.phase = 'compacting';
  activeRun.latestActivity = '上下文过大，正在自动压缩旧会话…';
  activeRun.updatedAt = Date.now();
  rememberActivity(activeRun, activeRun.latestActivity);
  if (event && runtime) {
    maybeNotifyRunMilestone(event, runtime, activeRun);
  }

  const result = await runCodex({
    session,
    prompt: buildCompactRequestPrompt(),
    imagePaths: [],
    activeRun,
    event,
    runtime,
  });

  if (!result.ok) {
    return {
      ok: false,
      summary: '',
      error: result.error || truncate(result.logs.join('\n'), 400),
    };
  }

  const summary = (result.finalAnswer || result.messages.join('\n\n')).trim();
  if (!summary) {
    return { ok: false, summary: '', error: 'empty compact summary' };
  }

  return { ok: true, summary };
}

function shouldRetryFreshSession(result) {
  if (!result || result.ok || result.cancelled || result.timedOut) return false;
  const text = [result.error, ...(Array.isArray(result.logs) ? result.logs : [])].join('\n').toLowerCase();
  return [
    'resume',
    'session not found',
    'conversation not found',
    'thread not found',
    'invalid session',
    'invalid thread',
    'session no longer valid',
    'session expired',
    'no such session',
  ].some((needle) => text.includes(needle));
}

function resetPeerSession(session) {
  session.codexThreadId = null;
  session.lastInputTokens = null;
  session.updatedAt = new Date().toISOString();
}

async function preparePromptInput({ event, session, promptInput, activeRun }) {
  const workspaceDir = resolveWorkspaceDir(session.workspaceDir || path.join(WORKSPACE_ROOT, sanitizePeerKey(event.peerKey)));
  const attachments = Array.isArray(promptInput?.attachments) ? promptInput.attachments : [];
  const notes = [];
  let preparedAttachments = attachments;
  let extractedPreviews = [];

  if (DOWNLOAD_ATTACHMENTS && attachments.length > 0) {
    activeRun.phase = 'preparing';
    activeRun.latestActivity = `正在准备 ${Math.min(attachments.length, MAX_ATTACHMENTS_PER_MESSAGE)} 个附件…`;
    activeRun.updatedAt = Date.now();
    rememberActivity(activeRun, activeRun.latestActivity);
    maybeNotifyRunMilestone(event, getPeerRuntime(event.peerKey), activeRun);
    const materialized = await materializeAttachments({
      attachments,
      workspaceDir,
      messageId: event.messageId,
      activeRun,
    });
    preparedAttachments = materialized.attachments;
    notes.push(...materialized.notes);
  } else if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    notes.push(`附件过多，仅处理前 ${MAX_ATTACHMENTS_PER_MESSAGE} 个。`);
    preparedAttachments = attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  }

  if (EXTRACT_ATTACHMENT_TEXT && preparedAttachments.some((item) => item.localPath)) {
    activeRun.latestActivity = '正在提取文档文本…';
    activeRun.updatedAt = Date.now();
    rememberActivity(activeRun, activeRun.latestActivity);
    const extraction = extractAttachmentTextPreviews({
      attachments: preparedAttachments,
      workspaceDir,
      activeRun,
    });
    preparedAttachments = extraction.attachments;
    extractedPreviews = extraction.previews;
    notes.push(...extraction.notes);
  }

  updateSessionRecentFiles(session, preparedAttachments);
  session.updatedAt = new Date().toISOString();
  saveState();

  return {
    prompt: buildPromptFromMessage(promptInput?.text, preparedAttachments, extractedPreviews),
    imagePaths: preparedAttachments
      .filter((item) => item.localPath && item.isImage)
      .map((item) => item.localPath),
    notes,
  };
}

async function materializeAttachments({ attachments, workspaceDir, messageId, activeRun }) {
  const output = [];
  const notes = [];
  const selected = attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  const baseDir = path.join(workspaceDir, '.attachments', sanitizeFilename(messageId || `msg-${Date.now()}`));
  ensureDir(baseDir);

  for (const [index, attachment] of selected.entries()) {
    const sourceUrl = String(attachment.voice_wav_url || attachment.url || '').trim();
    const fallback = {
      ...attachment,
      sourceUrl,
      localPath: null,
      isImage: isImageAttachment(attachment),
      downloadError: '',
    };
    if (!sourceUrl) {
      fallback.downloadError = 'missing attachment url';
      output.push(fallback);
      continue;
    }

    activeRun.latestActivity = `下载附件 ${index + 1}/${selected.length}：${attachment.filename}`;
    activeRun.updatedAt = Date.now();
    rememberActivity(activeRun, activeRun.latestActivity);

    const finalName = buildAttachmentFilename(index, attachment, sourceUrl);
    const absolutePath = path.join(baseDir, finalName);
    const relativePath = toPosixPath(path.relative(workspaceDir, absolutePath));

    try {
      await downloadAttachmentToFile(sourceUrl, absolutePath, MAX_ATTACHMENT_BYTES);
      output.push({
        ...attachment,
        sourceUrl,
        localPath: relativePath,
        isImage: isImageAttachment(attachment),
        downloadError: '',
      });
    } catch (err) {
      output.push({
        ...fallback,
        downloadError: safeError(err),
      });
      notes.push(`附件下载失败：${attachment.filename} (${safeError(err)})`);
    }
  }

  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    notes.push(`附件过多，仅处理前 ${MAX_ATTACHMENTS_PER_MESSAGE} 个，其余 ${attachments.length - MAX_ATTACHMENTS_PER_MESSAGE} 个已忽略。`);
  }

  return { attachments: output, notes };
}

async function downloadAttachmentToFile(sourceUrl, absolutePath, maxBytes) {
  let response = await fetch(sourceUrl);
  if ((response.status === 401 || response.status === 403) && isQqAttachmentUrl(sourceUrl)) {
    const accessToken = await getAccessToken();
    response = await fetch(sourceUrl, {
      headers: {
        Authorization: `QQBot ${accessToken}`,
      },
    });
  }

  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status})`);
  }

  const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`file too large (${formatBytes(contentLength)} > ${formatBytes(maxBytes)})`);
  }

  const tmpPath = `${absolutePath}.tmp-${Date.now()}`;
  const writer = fs.createWriteStream(tmpPath, { flags: 'wx' });
  let total = 0;

  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      total += chunk.length;
      if (total > maxBytes) {
        throw new Error(`file too large (> ${formatBytes(maxBytes)})`);
      }
      if (!writer.write(chunk)) {
        await once(writer, 'drain');
      }
    }
    writer.end();
    await finished(writer);
    fs.renameSync(tmpPath, absolutePath);
  } catch (err) {
    writer.destroy();
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

function extractAttachmentTextPreviews({ attachments, workspaceDir, activeRun }) {
  const notes = [];
  const previews = [];
  const output = [];
  let remainingBudget = MAX_EXTRACTED_TEXT_TOTAL_CHARS;

  for (const attachment of attachments) {
    const next = { ...attachment, extractedText: '', extractedVia: '', extractError: '' };
    if (!attachment.localPath || remainingBudget <= 0 || attachment.isImage) {
      output.push(next);
      continue;
    }

    activeRun.latestActivity = `提取文本：${attachment.filename}`;
    activeRun.updatedAt = Date.now();
    rememberActivity(activeRun, activeRun.latestActivity);

    const absolutePath = path.join(workspaceDir, attachment.localPath);
    const limit = Math.min(MAX_EXTRACTED_TEXT_CHARS_PER_FILE, remainingBudget);
    const extracted = extractTextPreviewFromFile(absolutePath, attachment, limit);
    if (extracted.text) {
      next.extractedText = extracted.text;
      next.extractedVia = extracted.via;
      previews.push({
        filename: attachment.filename,
        localPath: attachment.localPath,
        via: extracted.via,
        text: extracted.text,
      });
      remainingBudget -= extracted.text.length;
    } else if (extracted.error) {
      next.extractError = extracted.error;
      if (extracted.note) notes.push(`文本提取跳过：${attachment.filename} (${extracted.note})`);
    }
    output.push(next);
  }

  return { attachments: output, previews, notes };
}

function extractTextPreviewFromFile(absolutePath, attachment, limit) {
  const ext = path.extname(absolutePath).toLowerCase();
  const contentType = String(attachment?.content_type || '').toLowerCase();

  if (contentType.startsWith('audio/') || contentType.startsWith('video/')) {
    return { text: '', via: '', error: 'audio/video extraction unsupported', note: '暂不支持音视频自动转文字' };
  }

  if (isDirectTextFile(ext, contentType, absolutePath)) {
    const raw = readTextPreviewFromFile(absolutePath);
    const text = sanitizeExtractedText(raw, limit);
    return text ? { text, via: 'direct-read', error: '' } : { text: '', via: '', error: 'empty text' };
  }

  if (ext === '.pdf' || contentType === 'application/pdf') {
    const raw = runExtractorToStdout('pdftotext', ['-q', '-nopgbrk', absolutePath, '-']);
    const text = sanitizeExtractedText(raw.stdout, limit);
    if (text) return { text, via: 'pdftotext', error: '' };
    return { text: '', via: '', error: raw.error || 'pdf extract failed', note: raw.error || 'pdf 提取失败' };
  }

  if (canUseTextutil(ext, contentType)) {
    const raw = runExtractorToStdout('/usr/bin/textutil', ['-convert', 'txt', '-stdout', absolutePath]);
    const text = sanitizeExtractedText(raw.stdout, limit);
    if (text) return { text, via: 'textutil', error: '' };
    return { text: '', via: '', error: raw.error || 'textutil extract failed', note: raw.error || '文档提取失败' };
  }

  return { text: '', via: '', error: 'unsupported extract type', note: '该文件类型暂不做自动文本提取' };
}

function buildPromptFromMessage(text, attachments, extractedPreviews = []) {
  const lines = [];
  const body = String(text || '').trim();
  if (body) lines.push(body);
  if (attachments.length) {
    lines.push(formatAttachmentsForPrompt(attachments));
  }
  if (extractedPreviews.length) {
    lines.push(formatExtractedTextForPrompt(extractedPreviews));
  }
  return lines.join('\n\n').trim();
}

function formatAttachmentsForPrompt(attachments) {
  const lines = ['Attachments:'];
  attachments.slice(0, 8).forEach((attachment, index) => {
    const parts = [
      `${index + 1}. name=${attachment.filename}`,
      `type=${attachment.content_type}`,
    ];
    if (attachment.localPath) {
      parts.push(`local_path=${attachment.localPath}`);
    }
    if (!attachment.localPath && attachment.sourceUrl) {
      parts.push(`url=${attachment.sourceUrl}`);
    }
    if (attachment.isImage && attachment.localPath) {
      parts.push('codex_image_input=true');
    }
    lines.push(parts.join('; '));
    if (attachment.voice_wav_url) {
      lines.push(`   voice_wav_url=${attachment.voice_wav_url}`);
    }
    if (attachment.downloadError) {
      lines.push(`   download_error=${attachment.downloadError}`);
    }
  });
  if (attachments.length > 8) {
    lines.push(`...and ${attachments.length - 8} more attachment(s).`);
  }
  return lines.join('\n');
}

function formatExtractedTextForPrompt(previews) {
  const lines = ['Extracted attachment text:'];
  for (const item of previews.slice(0, 4)) {
    lines.push(`[${item.filename}] path=${item.localPath}; via=${item.via}`);
    lines.push(item.text);
    lines.push('');
  }
  return lines.join('\n').trim();
}

function normalizeAttachments(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      content_type: String(item?.content_type || 'unknown'),
      filename: String(item?.filename || 'unnamed-file'),
      url: normalizeAttachmentUrl(item?.url),
      voice_wav_url: normalizeAttachmentUrl(item?.voice_wav_url),
    }))
    .filter((item) => item.url || item.voice_wav_url);
}

function normalizeAttachmentUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.startsWith('//') ? `https:${raw}` : raw;
}

function buildHelpMessage() {
  return [
    '可用命令',
    '直接发送普通消息 = 交给 Codex 处理',
    '群聊里需要 @ 机器人 才会触发',
    '私聊可用 `/new` 主动开启新会话，旧会话可用 `/sessions` + `/resume <id>` 继续',
    '图片会尽量作为图片输入直接交给 Codex，其他附件会下载到当前 workspace 后再引用',
    '长上下文会在阈值处自动压缩续聊，长回复会自动按代码块安全分片',
    '',
    '/help',
    '/whoami',
    '/status',
    '/state',
    '/diag',
    '/stats',
    '/audit',
    '/session',
    '/sessions',
    '/history',
    '/new',
    '/start',
    '/files',
    '/progress',
    '/cancel',
    '/stop',
    '/reset',
    '/resume <session_id|clear>',
    '/profile default|code|docs|review|image',
    '/mode safe|dangerous',
    '/model <name|default>',
    '/effort low|medium|high|default',
  ].join('\n');
}

function normalizeCommandAlias(command) {
  switch (String(command || '').trim().toLowerCase()) {
    case '/state':
    case '/health':
      return '/status';
    case '/debug':
      return '/diag';
    case '/history':
    case '/hist':
      return '/sessions';
    case '/start':
    case '/fresh':
    case '/next':
      return '/new';
    case '/stop':
    case '/abort':
    case '/kill':
      return '/cancel';
    default:
      return String(command || '').trim().toLowerCase();
  }
}

function formatRunPhaseLabel(phase) {
  switch (String(phase || '').trim()) {
    case 'starting':
      return '启动中';
    case 'waiting-slot':
      return '排队等待执行槽';
    case 'compacting':
      return '压缩上下文';
    case 'preparing':
      return '准备附件/上下文';
    case 'executing':
      return '执行中';
    case 'reasoning':
      return '思考中';
    case 'answering':
      return '生成回复';
    case 'finalizing':
      return '整理结果';
    case 'retrying':
      return '自动重试';
    case 'failed':
      return '执行失败';
    default:
      return String(phase || '').trim() || '(unknown)';
  }
}

function buildShortcutHint(kind = 'default') {
  switch (String(kind || '').trim()) {
    case 'running':
      return '快捷：`/progress` ` /status` ` /new` ` /stop`';
    case 'queue':
      return '快捷：`/progress` ` /status` ` /new` ` /cancel`';
    case 'idle':
      return '快捷：`/status` ` /new` ` /sessions` ` /files`';
    default:
      return '快捷：`/progress` ` /status` ` /new` ` /sessions`';
  }
}

function normalizeProfileName(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'unknown';
  if (['default', 'code', 'docs', 'review', 'image'].includes(raw)) return raw;
  return 'unknown';
}

function applyProfileToSession(session, profileName) {
  session.profile = normalizeProfileName(profileName) === 'unknown' ? 'default' : normalizeProfileName(profileName);
  switch (session.profile) {
    case 'code':
      session.mode = 'dangerous';
      session.effort = 'high';
      break;
    case 'docs':
      session.mode = 'safe';
      session.effort = 'medium';
      break;
    case 'review':
      session.mode = 'safe';
      session.effort = 'high';
      break;
    case 'image':
      session.mode = 'dangerous';
      session.effort = 'medium';
      break;
    default:
      session.mode = DEFAULT_MODE;
      session.effort = DEFAULT_EFFORT;
      break;
  }
}

function formatSessionProfileSummary(session) {
  return `profile：${session.profile || 'default'} | mode：${session.mode} | effort：${session.effort || DEFAULT_EFFORT || '(default)'} | model：${session.model || DEFAULT_MODEL || '(default)'}`;
}

function buildReceiveAckMessage(session, promptInput) {
  const attachmentCount = Array.isArray(promptInput?.attachments) ? promptInput.attachments.length : 0;
  const lines = [
    session.codexThreadId ? '⏳ 已收到，正在继续当前会话…' : '⏳ 已收到，正在为你创建新会话…',
    `profile：${session.profile || 'default'}`,
  ];
  if (attachmentCount > 0) {
    lines.push(`附件：${attachmentCount} 个`);
  }
  lines.push(buildShortcutHint('running'));
  return lines.join('\n');
}

function buildQueueAckMessage(session, queuedBefore, promptInput) {
  const attachmentCount = Array.isArray(promptInput?.attachments) ? promptInput.attachments.length : 0;
  const lines = [
    '⏳ 已加入队列。',
    `前面还有 ${queuedBefore} 个任务。`,
    `这条消息会${session.codexThreadId ? '继续当前会话' : '开启新会话'}。`,
    `profile：${session.profile || 'default'}`,
  ];
  if (attachmentCount > 0) {
    lines.push(`附件：${attachmentCount} 个`);
  }
  lines.push(buildShortcutHint('queue'));
  return lines.join('\n');
}

function formatStatusMessage(event, session, runtime) {
  const currentSession = session.codexThreadId || '(下一条消息新建)';
  const lines = [
    '📊 当前状态',
    `会话：${currentSession}`,
    `工作区：${session.workspaceDir}`,
    `profile：${session.profile || 'default'}`,
    `模式：${session.mode} | 模型：${session.model || DEFAULT_MODEL || '(default)'} | effort：${session.effort || DEFAULT_EFFORT || '(default)'}`,
    `排队：${runtime.queue.length} | 运行：${runtime.activeRun ? '处理中' : '空闲'} | 全局并发：${globalRunState.active}${MAX_GLOBAL_ACTIVE_RUNS > 0 ? `/${MAX_GLOBAL_ACTIVE_RUNS}` : ''}`,
    `上下文 token：${session.lastInputTokens ?? 0} | 压缩续聊：${COMPACT_CONTEXT_ON_THRESHOLD ? '开启' : '关闭'}${session.pendingSummary ? '（已准备压缩摘要）' : ''}`,
    `附件：${DOWNLOAD_ATTACHMENTS ? `开启（最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 个，图片输入 ${MAX_IMAGE_ATTACHMENTS} 个）` : '仅 URL'}`,
    `最近文件：${Array.isArray(session.recentFiles) ? session.recentFiles.length : 0} | 历史会话：${Array.isArray(session.sessionHistory) ? session.sessionHistory.length : 0}`,
    `QQ 网关：${state.gateway.sessionId ? '已连接' : '未连接'} | 最近事件：${formatTimestamp(state.gateway.lastEventAt)} | 最近错误：${state.gateway.lastError || '(none)'}`,
  ];
  if (runtime.activeRun) {
    lines.push(`当前阶段：${formatRunPhaseLabel(runtime.activeRun.phase)}`);
    lines.push(`当前请求：${runtime.activeRun.promptPreview}`);
    lines.push(`最近进展：${runtime.activeRun.latestActivity}`);
    lines.push(`已运行：${formatDuration(Date.now() - runtime.activeRun.startedAt)}`);
  } else if (session.lastRun) {
    lines.push(`上次任务：${session.lastRun.ok ? '完成' : session.lastRun.cancelled ? '已取消' : '失败'}，耗时 ${formatDuration(session.lastRun.durationMs || 0)}`);
    lines.push(`上次进展：${session.lastRun.latestActivity || '(none)'}`);
  }
  lines.push('');
  lines.push(buildShortcutHint(runtime.activeRun ? 'running' : 'idle'));
  return lines.join('\n');
}

function formatProgressMessage(session, runtime) {
  if (runtime.activeRun) {
    const run = runtime.activeRun;
    const lines = [
      '⏳ 任务进行中',
      `阶段：${formatRunPhaseLabel(run.phase)}`,
      `已运行：${formatDuration(Date.now() - run.startedAt)}`,
      `当前请求：${run.promptPreview}`,
      `事件数：${run.eventCount} | 自动重试：${run.retryCount}`,
      `最近进展：${run.latestActivity || '(等待首个事件)'}`,
      `后续排队：${runtime.queue.length}`,
    ];
    if (run.recentActivities.length) {
      lines.push('');
      lines.push('最近里程碑：');
      for (const item of run.recentActivities.slice(-4)) {
        lines.push(`- ${item}`);
      }
    }
    lines.push('');
    lines.push(buildShortcutHint('running'));
    return lines.join('\n');
  }

  if (session.lastRun) {
    const lines = [
      'ℹ️ 当前没有运行中的任务',
      `排队：${runtime.queue.length}`,
      `上次任务：${session.lastRun.ok ? '完成' : session.lastRun.cancelled ? '已取消' : '失败'}`,
      `耗时：${formatDuration(session.lastRun.durationMs || 0)}`,
      `最近进展：${session.lastRun.latestActivity || '(none)'}`,
    ];
    if (session.lastRun.logs?.length) {
      lines.push('');
      lines.push('最近日志：');
      for (const line of session.lastRun.logs.slice(-3)) {
        lines.push(`- ${truncate(line, 120)}`);
      }
    }
    lines.push('');
    lines.push('发一条普通消息即可继续。');
    return lines.join('\n');
  }

  return 'ℹ️ 当前没有运行中的任务，也没有历史任务记录。\n直接发一条普通消息开始，或用 `/new` 明确开启新会话。';
}

function formatDiagnosticsMessage(event) {
  const runtime = getPeerRuntime(event.peerKey);
  const uptimeMs = Math.floor(process.uptime() * 1000);
  return [
    '🩺 诊断信息',
    `peer：${event.peerKey}`,
    `运行时长：${formatDuration(uptimeMs)}`,
    `网关 session：${state.gateway.sessionId || '(none)'}`,
    `最近连上：${formatTimestamp(state.gateway.lastConnectedAt)}`,
    `最近事件：${formatTimestamp(state.gateway.lastEventAt)}`,
    `最近错误：${state.gateway.lastError || '(none)'}`,
    `重连级别：${reconnectIndex}`,
    `当前连接：${ws ? '在线' : '离线'}`,
    `当前排队：${runtime.queue.length} | 处理中：${runtime.activeRun ? '是' : '否'}`,
    `收消息：${state.telemetry.inboundMessages} | 发消息：${state.telemetry.outboundMessages} | 发送失败：${state.telemetry.outboundFailures}`,
    `完成：${state.telemetry.completedRuns} | 失败：${state.telemetry.failedRuns} | 取消：${state.telemetry.cancelledRuns} | 撤回：${state.telemetry.retracts}`,
  ].join('\n');
}

function formatStatsMessage() {
  return [
    '📈 运行统计',
    `服务启动：${formatIsoTimestamp(state.telemetry.startedAt)}`,
    `入站消息：${state.telemetry.inboundMessages}`,
    `出站消息：${state.telemetry.outboundMessages}`,
    `出站失败：${state.telemetry.outboundFailures}`,
    `完成任务：${state.telemetry.completedRuns}`,
    `失败任务：${state.telemetry.failedRuns}`,
    `取消任务：${state.telemetry.cancelledRuns}`,
    `撤回消息：${state.telemetry.retracts}`,
    `审计记录：${Array.isArray(state.telemetry.audit) ? state.telemetry.audit.length : 0}`,
  ].join('\n');
}

function formatAuditMessage(peerKey = '') {
  const items = (Array.isArray(state.telemetry.audit) ? state.telemetry.audit : [])
    .filter((item) => !peerKey || item.peerKey === peerKey)
    .slice(-12);
  if (items.length === 0) {
    return '🧾 最近没有可展示的审计记录。';
  }
  const lines = ['🧾 最近审计'];
  for (const item of items) {
    lines.push(`- ${formatIsoTimestamp(item.at)} | ${item.type} | ${item.peerKey || '(none)'} | ${item.detail || '(none)'}`);
  }
  return lines.join('\n');
}

function maybeNotifyRunMilestone(event, runtime, activeRun) {
  if (!PHASE_PROGRESS_NOTIFY || MAX_PHASE_PROGRESS_NOTICES === 0) return;
  if (!event || !runtime || !activeRun) return;
  if (event.kind !== 'c2c') return;
  if (runtime.activeRun !== activeRun) return;
  if (activeRun.cancelRequested) return;
  if (![
    'waiting-slot',
    'compacting',
    'preparing',
    'executing',
    'retrying',
    'answering',
    'finalizing',
    'failed',
  ].includes(activeRun.phase)) {
    return;
  }
  if (activeRun.lastPhaseNoticePhase === activeRun.phase) return;
  if (activeRun.phaseNoticeCount >= MAX_PHASE_PROGRESS_NOTICES) return;
  const now = Date.now();
  if (activeRun.lastPhaseNoticeAt && (now - activeRun.lastPhaseNoticeAt) < MIN_PHASE_PROGRESS_NOTIFY_MS) {
    return;
  }
  activeRun.phaseNoticeCount += 1;
  activeRun.lastPhaseNoticeAt = now;
  activeRun.lastPhaseNoticePhase = activeRun.phase;
  void replyText(event, [
    '🛰️ 进展更新',
    `阶段：${formatRunPhaseLabel(activeRun.phase)}`,
    `已运行：${formatDuration(now - activeRun.startedAt)}`,
    `最近进展：${activeRun.latestActivity || '(none)'}`,
    `后续排队：${runtime.queue.length}`,
    buildShortcutHint('running'),
  ].join('\n'), { preferProactive: false, quickActions: true, uiCategory: 'progress', replaceUiCard: true });
}

function createAutoProgressPing(event, runtime, activeRun) {
  if (AUTO_PROGRESS_PING_MS <= 0 || MAX_AUTO_PROGRESS_PINGS === 0) return null;
  let sentCount = 0;
  const timer = setInterval(() => {
    if (runtime.activeRun !== activeRun || activeRun.cancelRequested) {
      clearInterval(timer);
      return;
    }
    if (sentCount >= MAX_AUTO_PROGRESS_PINGS) {
      clearInterval(timer);
      return;
    }
    sentCount += 1;
    void replyText(event, [
      '⏳ 仍在处理中…',
      `阶段：${formatRunPhaseLabel(activeRun.phase)}`,
      `已运行：${formatDuration(Date.now() - activeRun.startedAt)}`,
      `最近进展：${activeRun.latestActivity || '(none)'}`,
      buildShortcutHint('running'),
    ].join('\n'), { preferProactive: false, quickActions: true, uiCategory: 'progress', replaceUiCard: true });
  }, AUTO_PROGRESS_PING_MS);
  return timer;
}

function storePendingSummary(session, summary, sourceSessionId = null) {
  session.pendingSummary = String(summary || '').trim() || null;
  session.pendingSummarySourceSessionId = sourceSessionId || null;
  session.pendingSummaryCreatedAt = session.pendingSummary ? new Date().toISOString() : null;
}

function clearPendingSummary(session) {
  session.pendingSummary = null;
  session.pendingSummarySourceSessionId = null;
  session.pendingSummaryCreatedAt = null;
}

function rememberSessionId(session, sessionId, lastInputTokens = null, reason = 'run') {
  const normalized = String(sessionId || '').trim();
  if (!normalized) return;
  const current = Array.isArray(session.sessionHistory) ? session.sessionHistory : [];
  const nextItem = {
    id: normalized,
    lastUsedAt: new Date().toISOString(),
    lastInputTokens: Number.isFinite(lastInputTokens) ? lastInputTokens : null,
    reason,
  };
  session.sessionHistory = [nextItem, ...current.filter((item) => item?.id !== normalized)].slice(0, 20);
}

async function acquireGlobalRunSlot(event, runtime, activeRun) {
  if (MAX_GLOBAL_ACTIVE_RUNS <= 0) {
    return () => {};
  }

  if (globalRunState.active < MAX_GLOBAL_ACTIVE_RUNS) {
    globalRunState.active += 1;
    activeRun.latestActivity = `已获得全局执行槽（${globalRunState.active}/${MAX_GLOBAL_ACTIVE_RUNS}）`;
    activeRun.updatedAt = Date.now();
    rememberActivity(activeRun, activeRun.latestActivity);
    maybeNotifyRunMilestone(event, runtime, activeRun);
    return releaseGlobalRunSlot;
  }

  activeRun.phase = 'waiting-slot';
  activeRun.latestActivity = `等待全局执行槽（当前 ${globalRunState.active}/${MAX_GLOBAL_ACTIVE_RUNS}）`;
  activeRun.updatedAt = Date.now();
  rememberActivity(activeRun, activeRun.latestActivity);
  maybeNotifyRunMilestone(event, runtime, activeRun);

  return await new Promise((resolve) => {
    globalRunState.waiters.push({
      activeRun,
      resume() {
      globalRunState.active += 1;
      activeRun.phase = 'starting';
      activeRun.latestActivity = `已获得全局执行槽（${globalRunState.active}/${MAX_GLOBAL_ACTIVE_RUNS}）`;
      activeRun.updatedAt = Date.now();
      rememberActivity(activeRun, activeRun.latestActivity);
      maybeNotifyRunMilestone(event, runtime, activeRun);
      resolve(releaseGlobalRunSlot);
      },
    });
  });
}

function releaseGlobalRunSlot() {
  if (MAX_GLOBAL_ACTIVE_RUNS <= 0) return;
  if (globalRunState.active > 0) {
    globalRunState.active -= 1;
  }
  while (globalRunState.waiters.length > 0) {
    const next = globalRunState.waiters.shift();
    if (!next) break;
    if (next.activeRun?.cancelRequested) {
      continue;
    }
    next.resume();
    break;
  }
}

function buildCancelledRunResult(error = 'cancelled') {
  return {
    ok: false,
    exitCode: null,
    signal: null,
    messages: [],
    finalAnswer: '',
    reasonings: [],
    usage: null,
    threadId: null,
    logs: [error],
    error,
    timedOut: false,
    cancelled: true,
  };
}

function formatRecentFilesMessage(session) {
  const files = Array.isArray(session.recentFiles) ? session.recentFiles : [];
  if (files.length === 0) {
    return '当前会话还没有记录到附件文件。';
  }

  const lines = ['最近附件文件：'];
  for (const item of files.slice(0, 6)) {
    lines.push(`- ${item.filename}`);
    lines.push(`  path: ${item.localPath || '(none)'}`);
    lines.push(`  time: ${item.recordedAt || '(unknown)'}`);
    if (item.extractedVia) lines.push(`  extract: ${item.extractedVia}`);
    if (item.extractError) lines.push(`  extract_error: ${truncate(item.extractError, 100)}`);
  }
  return lines.join('\n');
}

function formatSessionMessage(session) {
  return [
    '🧠 当前会话',
    `当前 session：${session.codexThreadId || '(下一条消息新建)'}`,
    `工作区：${session.workspaceDir}`,
    `上下文 token：${session.lastInputTokens ?? 0}`,
    `profile：${session.profile || 'default'}`,
    `模式：${session.mode} | 模型：${session.model || DEFAULT_MODEL || '(default)'} | effort：${session.effort || DEFAULT_EFFORT || '(default)'}`,
    session.pendingSummary ? `压缩摘要：已准备（来源 ${session.pendingSummarySourceSessionId || 'unknown'}）` : '压缩摘要：无',
    '',
    '操作建议：',
    '- `/new` 开新会话',
    '- `/sessions` 查看历史会话',
    '- `/resume <id>` 切回旧会话',
  ].join('\n');
}

function formatSessionHistoryMessage(session) {
  const currentSessionId = String(session.codexThreadId || '').trim();
  const history = (Array.isArray(session.sessionHistory) ? session.sessionHistory : [])
    .filter((item) => item?.id && item.id !== currentSessionId);
  const lines = ['🗂️ 最近会话'];
  if (currentSessionId) {
    lines.push(`- 当前：${currentSessionId}${session.lastInputTokens ? ` (tokens=${session.lastInputTokens})` : ''}`);
  }
  if (history.length === 0) {
    lines.push(currentSessionId ? '- 暂无其他历史会话记录' : '- 暂无历史会话记录');
    lines.push('');
    lines.push('先发普通消息开始会话，之后可用 `/new` 切到新会话。');
    return lines.join('\n');
  }
  for (const item of history.slice(0, 8)) {
    lines.push(`- ${item.id}`);
    lines.push(`  最近使用：${formatIsoTimestamp(item.lastUsedAt)} | 来源：${item.reason || 'run'}${item.lastInputTokens ? ` | tokens=${item.lastInputTokens}` : ''}`);
  }
  lines.push('');
  lines.push('用 `/resume <id>` 可以切回指定会话。');
  return lines.join('\n');
}

function summarizeCodexEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type === 'thread.started') {
    return { phase: 'starting', text: '已创建 Codex 会话' };
  }
  if (ev.type === 'turn.started') {
    return { phase: 'executing', text: '开始处理任务' };
  }
  if (ev.type === 'turn.completed') {
    return { phase: 'finalizing', text: 'Codex 已完成本轮处理' };
  }
  if (ev.type === 'item.completed') {
    if (ev.item?.type === 'agent_message') {
      return { phase: 'answering', text: '模型已生成回复内容' };
    }
    if (ev.item?.type === 'reasoning') {
      return { phase: 'reasoning', text: '模型已完成一段思考' };
    }
    if (ev.item?.type) {
      return { phase: 'executing', text: `完成事件：${ev.item.type}` };
    }
  }
  if (ev.type === 'error') {
    return { phase: 'failed', text: typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error) };
  }
  return null;
}

function rememberActivity(activeRun, text) {
  const normalized = truncate(String(text || '').trim(), 200);
  if (!normalized) return;
  const list = activeRun.recentActivities;
  if (list[list.length - 1] === normalized) return;
  list.push(normalized);
  if (list.length > ACTIVITY_HISTORY_MAX) list.shift();
}

function describePromptInput(promptInput) {
  const body = String(promptInput?.text || '').replace(/\s+/g, ' ').trim();
  const attachmentCount = Array.isArray(promptInput?.attachments) ? promptInput.attachments.length : 0;
  if (body && attachmentCount > 0) return `${body} [attachments=${attachmentCount}]`;
  if (body) return body;
  if (attachmentCount > 0) return `[attachments=${attachmentCount}]`;
  return '(empty)';
}

function updateSessionRecentFiles(session, attachments) {
  if (!Array.isArray(session.recentFiles)) {
    session.recentFiles = [];
  }

  const now = new Date().toISOString();
  const incoming = attachments
    .filter((item) => item.localPath)
    .map((item) => ({
      filename: item.filename,
      localPath: item.localPath,
      contentType: item.content_type,
      extractedVia: item.extractedVia || '',
      extractError: item.extractError || item.downloadError || '',
      recordedAt: now,
    }));

  if (incoming.length === 0) return;

  const deduped = session.recentFiles.filter((existing) => !incoming.some((item) => item.localPath === existing.localPath));
  session.recentFiles = [...incoming.reverse(), ...deduped].slice(0, RECENT_FILES_MAX);
}

function isDirectTextFile(ext, contentType, absolutePath) {
  if (contentType.startsWith('text/')) return true;
  if ([
    '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg',
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.css',
    '.scss', '.html', '.htm', '.xml', '.csv', '.tsv', '.sql', '.sh', '.zsh', '.bash', '.log',
  ].includes(ext)) {
    return true;
  }
  const detected = detectMimeType(absolutePath);
  return detected.startsWith('text/');
}

function canUseTextutil(ext, contentType) {
  if ([
    '.doc', '.docx', '.odt', '.rtf', '.rtfd', '.html', '.htm', '.xml', '.webarchive',
  ].includes(ext)) {
    return true;
  }
  return [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'application/rtf',
    'text/rtf',
    'application/vnd.oasis.opendocument.text',
  ].includes(contentType);
}

function detectMimeType(absolutePath) {
  const result = spawnSync('file', ['--mime-type', '-b', absolutePath], {
    env: buildSpawnEnv(process.env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) return '';
  return String(result.stdout || '').trim().toLowerCase();
}

function readTextPreviewFromFile(absolutePath) {
  try {
    return fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return '';
  }
}

function sanitizeExtractedText(raw, limit) {
  const text = String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return '';
  return truncate(text, limit);
}

function runExtractorToStdout(command, args) {
  const result = spawnSync(command, args, {
    env: buildSpawnEnv(process.env),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    return { stdout: '', error: safeError(result.error) };
  }
  if (result.status !== 0) {
    return {
      stdout: '',
      error: String(result.stderr || result.stdout || `exit=${result.status}`).trim(),
    };
  }
  return { stdout: String(result.stdout || ''), error: '' };
}

function extractAgentMessageText(item) {
  const direct = String(item?.text || '').trim();
  if (direct) return direct;
  if (Array.isArray(item?.content)) {
    return item.content
      .map((block) => String(block?.text || '').trim())
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function isNoisyCodexLog(line) {
  const text = String(line || '');
  return [
    'unknown feature key in config',
    'shell_snapshot',
    'codex_rmcp_client::rmcp_client',
    'codex_protocol::openai_models',
  ].some((needle) => text.includes(needle));
}

function isImmediateCommand(content) {
  return String(content || '').trim().startsWith('/');
}

function normalizeIncomingContent(text) {
  return String(text || '')
    .replace(/<@!?[^>]+>/g, '')
    .replace(/<faceType=\d+,faceId=\"[^\"]*\",ext=\"[^\"]*\">/g, '')
    .trim();
}

function isDuplicateInboundMessage(messageId) {
  const now = Date.now();
  if (inboundDeduper.has(messageId)) {
    return true;
  }
  inboundDeduper.set(messageId, now);
  if (inboundDeduper.size > INBOUND_DEDUPE_MAX) {
    for (const [key, ts] of inboundDeduper) {
      if (now - ts > INBOUND_DEDUPE_TTL_MS || inboundDeduper.size > INBOUND_DEDUPE_MAX) {
        inboundDeduper.delete(key);
      } else {
        break;
      }
    }
  }
  return false;
}

function migrateLoadedState() {
  let dirty = false;

  if (!state.gateway || typeof state.gateway !== 'object') {
    state.gateway = {
      sessionId: null,
      lastSeq: null,
      lastConnectedAt: null,
      lastEventAt: null,
      lastError: null,
    };
    dirty = true;
  } else {
    if (!('sessionId' in state.gateway)) {
      state.gateway.sessionId = null;
      dirty = true;
    }
    if (!('lastSeq' in state.gateway) || !Number.isFinite(state.gateway.lastSeq)) {
      state.gateway.lastSeq = null;
      dirty = true;
    }
    if (!('lastConnectedAt' in state.gateway)) {
      state.gateway.lastConnectedAt = null;
      dirty = true;
    }
    if (!('lastEventAt' in state.gateway)) {
      state.gateway.lastEventAt = null;
      dirty = true;
    }
    if (!('lastError' in state.gateway)) {
      state.gateway.lastError = null;
      dirty = true;
    }
  }

  if (!state.telemetry || typeof state.telemetry !== 'object') {
    state.telemetry = {
      startedAt: new Date().toISOString(),
      inboundMessages: 0,
      outboundMessages: 0,
      outboundFailures: 0,
      retracts: 0,
      cancelledRuns: 0,
      completedRuns: 0,
      failedRuns: 0,
      audit: [],
    };
    dirty = true;
  } else {
    if (!state.telemetry.startedAt) {
      state.telemetry.startedAt = new Date().toISOString();
      dirty = true;
    }
    for (const key of ['inboundMessages', 'outboundMessages', 'outboundFailures', 'retracts', 'cancelledRuns', 'completedRuns', 'failedRuns']) {
      if (!Number.isFinite(state.telemetry[key])) {
        state.telemetry[key] = 0;
        dirty = true;
      }
    }
    if (!Array.isArray(state.telemetry.audit)) {
      state.telemetry.audit = [];
      dirty = true;
    } else if (state.telemetry.audit.length > DELIVERY_AUDIT_MAX) {
      state.telemetry.audit = state.telemetry.audit.slice(-DELIVERY_AUDIT_MAX);
      dirty = true;
    }
  }

  if (!state.peers || typeof state.peers !== 'object') {
    state.peers = {};
    return true;
  }

  for (const [peerKey, session] of Object.entries(state.peers)) {
    const defaultKind = String(peerKey).startsWith('group:') ? 'group' : 'c2c';
    dirty = normalizePeerSessionState(peerKey, session, defaultKind) || dirty;
  }

  return dirty;
}

function loadState() {
  const fallback = {
    gateway: {
      sessionId: null,
      lastSeq: null,
      lastConnectedAt: null,
      lastEventAt: null,
      lastError: null,
    },
    telemetry: {
      startedAt: new Date().toISOString(),
      inboundMessages: 0,
      outboundMessages: 0,
      outboundFailures: 0,
      retracts: 0,
      cancelledRuns: 0,
      completedRuns: 0,
      failedRuns: 0,
      audit: [],
    },
    peers: {},
  };

  if (!fs.existsSync(STATE_FILE)) return fallback;

  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      gateway: {
        sessionId: parsed?.gateway?.sessionId || null,
        lastSeq: Number.isFinite(parsed?.gateway?.lastSeq) ? parsed.gateway.lastSeq : null,
        lastConnectedAt: parsed?.gateway?.lastConnectedAt || null,
        lastEventAt: parsed?.gateway?.lastEventAt || null,
        lastError: parsed?.gateway?.lastError || null,
      },
      telemetry: parsed?.telemetry && typeof parsed.telemetry === 'object' ? parsed.telemetry : fallback.telemetry,
      peers: parsed?.peers && typeof parsed.peers === 'object' ? parsed.peers : {},
    };
  } catch (err) {
    try {
      fs.copyFileSync(STATE_FILE, `${STATE_FILE}.corrupt-${Date.now()}`);
    } catch {
    }
    console.error(`Failed to parse state file, using fallback: ${safeError(err)}`);
    return fallback;
  }
}

function saveState() {
  writeJsonAtomic(STATE_FILE, state);
}

function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
}

function scheduleReconnect(delayOverride) {
  if (stopped) return;
  if (reconnectTimer) return;
  const delay = delayOverride ?? RECONNECT_DELAYS[Math.min(reconnectIndex, RECONNECT_DELAYS.length - 1)];
  reconnectIndex += 1;
  console.log(`⏳ Reconnecting in ${delay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch((err) => {
      console.error('Reconnect failed:', safeError(err));
      state.gateway.lastError = safeError(err);
      saveState();
      scheduleReconnect();
    });
  }, delay);
}

function requestGatewayReconnect(reason, delayOverride) {
  if (stopped) return;
  clearHeartbeat();
  scheduleReconnect(delayOverride);
  closeGatewaySocket(ws, reason);
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function startHeartbeat(socket, intervalMs) {
  clearHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!socket || socket !== ws) {
      clearHeartbeat();
      return;
    }
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ op: 1, d: state.gateway.lastSeq }));
      } catch (err) {
        console.error('QQ heartbeat failed:', safeError(err));
        requestGatewayReconnect('heartbeat failed', 1000);
      }
    }
  }, intervalMs);
}

function clearHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function closeGatewaySocket(socket, reason = 'close') {
  if (!socket) return;
  if (socket.readyState === WebSocket.CLOSED) return;
  try {
    socket.close(1000, truncate(String(reason || 'close'), 80));
  } catch {
    try {
      socket.terminate?.();
    } catch {
    }
  }
}

function shutdown() {
  if (stopped) return;
  stopped = true;
  clearHeartbeat();
  clearReconnect();
  for (const runtime of peerRuntimes.values()) {
    runtime.queue.length = 0;
    if (runtime.activeRun) {
      runtime.activeRun.cancelRequested = true;
      stopChildProcess(runtime.activeRun.child);
    }
  }
  try {
    closeGatewaySocket(ws, 'shutdown');
  } catch {
  }
  saveState();
  process.exit(0);
}

function buildSpawnEnv(env) {
  const out = { ...env };
  const delimiter = path.delimiter;
  const entries = String(out.PATH || '').split(delimiter).filter(Boolean);
  const extras = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  for (const entry of extras) {
    if (!entries.includes(entry)) entries.push(entry);
  }
  out.PATH = entries.join(delimiter);
  return out;
}

function getCodexCliHealth() {
  const check = spawnSync(CODEX_BIN, ['--version'], {
    env: buildSpawnEnv(process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (check.error) {
    return { ok: false, bin: CODEX_BIN, error: safeError(check.error) };
  }
  if (check.status !== 0) {
    return {
      ok: false,
      bin: CODEX_BIN,
      error: (check.stderr || check.stdout || `exit=${check.status}`).trim(),
    };
  }
  return {
    ok: true,
    bin: CODEX_BIN,
    version: (check.stdout || '').trim(),
  };
}

function ensureGitRepo(dir) {
  const check = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: dir,
    stdio: 'ignore',
  });
  if (check.status === 0) return;
  spawnSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
}

function acquireLock() {
  try {
    lockFd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeFileSync(lockFd, String(process.pid));
  } catch (err) {
    if (err?.code === 'EEXIST') {
      const existingPid = Number.parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (Number.isFinite(existingPid)) {
        try {
          process.kill(existingPid, 0);
          console.error(`Lock file exists and process is alive: ${LOCK_FILE} (pid=${existingPid})`);
          process.exit(1);
        } catch {
          fs.rmSync(LOCK_FILE, { force: true });
          lockFd = fs.openSync(LOCK_FILE, 'wx');
          fs.writeFileSync(lockFd, String(process.pid));
          return;
        }
      }
      fs.rmSync(LOCK_FILE, { force: true });
      lockFd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeFileSync(lockFd, String(process.pid));
      return;
    }
    throw err;
  }
}

function releaseLock() {
  try {
    if (lockFd !== null) {
      fs.closeSync(lockFd);
      lockFd = null;
    }
    fs.rmSync(LOCK_FILE, { force: true });
  } catch {
  }
}

function parseCsvSet(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '*') return null;
  return new Set(raw.split(',').map((item) => item.trim()).filter(Boolean));
}

function isAllowedSender(senderId) {
  if (!QQBOT_ALLOW_FROM) return true;
  return QQBOT_ALLOW_FROM.has(String(senderId).trim());
}

function resolveWorkspaceDir(dir) {
  return resolvePath(dir);
}

function resolvePath(value) {
  const raw = String(value || '').trim();
  if (!raw) return ROOT;
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function clearGatewaySessionState(reason = null) {
  state.gateway.sessionId = null;
  state.gateway.lastSeq = null;
  if (reason) {
    state.gateway.lastError = reason;
  }
}

function handleGatewayCloseCode(code) {
  if (code === 4004) {
    cachedToken = null;
    return;
  }
  if (code === 4006 || code === 4007 || code === 4009 || (code >= 4900 && code <= 4913)) {
    clearGatewaySessionState(`gateway close ${code}`);
  }
}

function resolveReconnectDelay(code) {
  if (code === 4008) return 30000;
  if (code === 4004) return 1000;
  if (code === 4006 || code === 4007 || code === 4009 || (code >= 4900 && code <= 4913)) {
    return 1000;
  }
  return undefined;
}

function isImageAttachment(attachment) {
  const type = String(attachment?.content_type || '').toLowerCase();
  const name = String(attachment?.filename || '').toLowerCase();
  return type.startsWith('image/')
    || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
}

function buildAttachmentFilename(index, attachment, sourceUrl) {
  const original = sanitizeFilename(attachment?.filename || '') || `attachment-${index + 1}`;
  const originalExt = path.extname(original);
  const ext = originalExt || extFromUrl(sourceUrl) || extFromContentType(attachment?.content_type);
  const base = path.basename(original, originalExt).slice(0, 80) || `attachment-${index + 1}`;
  return `${String(index + 1).padStart(2, '0')}-${base}${ext || ''}`;
}

function extFromUrl(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);
    return path.extname(parsed.pathname || '') || '';
  } catch {
    return '';
  }
}

function extFromContentType(contentType) {
  const type = String(contentType || '').toLowerCase().trim();
  if (!type) return '';
  if (type === 'image/jpeg') return '.jpg';
  if (type === 'image/png') return '.png';
  if (type === 'image/gif') return '.gif';
  if (type === 'image/webp') return '.webp';
  if (type === 'image/bmp') return '.bmp';
  if (type === 'audio/wav') return '.wav';
  if (type === 'audio/mpeg') return '.mp3';
  if (type === 'audio/ogg') return '.ogg';
  if (type === 'application/pdf') return '.pdf';
  return '';
}

function sanitizeFilename(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/_+/g, '_')
    .slice(0, 120);
}

function toPosixPath(value) {
  return String(value || '').split(path.sep).join('/');
}

function isQqAttachmentUrl(sourceUrl) {
  try {
    const hostname = new URL(sourceUrl).hostname.toLowerCase();
    return hostname.endsWith('qq.com') || hostname.endsWith('gtimg.cn');
  } catch {
    return false;
  }
}

function normalizePeerSessionState(peerKey, session, kind) {
  if (!session || typeof session !== 'object') return false;

  let dirty = false;
  const expectedKind = kind === 'group' ? 'group' : 'c2c';
  const expectedWorkspace = resolveWorkspaceDir(path.join(WORKSPACE_ROOT, sanitizePeerKey(peerKey)));

  if (session.kind !== expectedKind) {
    session.kind = expectedKind;
    dirty = true;
  }
  if (typeof session.workspaceDir !== 'string' || !session.workspaceDir.trim()) {
    session.workspaceDir = expectedWorkspace;
    dirty = true;
  } else {
    session.workspaceDir = resolveWorkspaceDir(session.workspaceDir);
  }
  if (session.codexThreadId === undefined) {
    session.codexThreadId = null;
    dirty = true;
  } else if (session.codexThreadId !== null) {
    const normalized = String(session.codexThreadId || '').trim() || null;
    if (normalized !== session.codexThreadId) {
      session.codexThreadId = normalized;
      dirty = true;
    }
  }
  if (!Number.isFinite(session.lastInputTokens)) {
    if (session.lastInputTokens !== null) {
      session.lastInputTokens = null;
      dirty = true;
    }
  }
  if (session.mode !== 'safe' && session.mode !== 'dangerous') {
    session.mode = DEFAULT_MODE;
    dirty = true;
  }
  if (session.model === undefined || session.model === '') {
    session.model = null;
    dirty = true;
  } else if (session.model !== null) {
    const normalized = String(session.model).trim() || null;
    if (normalized !== session.model) {
      session.model = normalized;
      dirty = true;
    }
  }
  if (session.effort === undefined || session.effort === '') {
    session.effort = null;
    dirty = true;
  } else if (session.effort !== null) {
    const normalized = normalizeEffort(session.effort);
    if (normalized !== session.effort) {
      session.effort = normalized;
      dirty = true;
    }
  }
  if (!session.profile) {
    session.profile = 'default';
    dirty = true;
  } else {
    const normalized = normalizeProfileName(session.profile);
    if (normalized !== session.profile) {
      session.profile = normalized;
      dirty = true;
    }
  }
  if (!session.createdAt) {
    session.createdAt = new Date().toISOString();
    dirty = true;
  }
  if (!session.updatedAt) {
    session.updatedAt = session.createdAt;
    dirty = true;
  }
  if (session.lastRun === undefined) {
    session.lastRun = null;
    dirty = true;
  }
  if (!Array.isArray(session.recentFiles)) {
    session.recentFiles = [];
    dirty = true;
  } else if (session.recentFiles.length > RECENT_FILES_MAX) {
    session.recentFiles = session.recentFiles.slice(0, RECENT_FILES_MAX);
    dirty = true;
  }
  if (!Array.isArray(session.sessionHistory)) {
    session.sessionHistory = [];
    dirty = true;
  }
  if (session.pendingSummary === undefined) {
    session.pendingSummary = null;
    dirty = true;
  } else if (session.pendingSummary !== null) {
    const normalized = String(session.pendingSummary || '').trim() || null;
    if (normalized !== session.pendingSummary) {
      session.pendingSummary = normalized;
      dirty = true;
    }
  }
  if (session.pendingSummarySourceSessionId === undefined) {
    session.pendingSummarySourceSessionId = null;
    dirty = true;
  }
  if (session.pendingSummaryCreatedAt === undefined) {
    session.pendingSummaryCreatedAt = null;
    dirty = true;
  }

  return dirty;
}

function nextMsgSeq() {
  return ((Date.now() % 100000000) ^ Math.floor(Math.random() * 65536)) % 65536;
}

function chunkText(text, limit) {
  const input = String(text || '').trim();
  if (!input) return [''];
  if (input.length <= limit) return [input];

  const chunks = [];
  let rest = input;
  while (rest.length > limit) {
    let splitAt = rest.lastIndexOf('\n', limit);
    if (splitAt < limit * 0.5) splitAt = rest.lastIndexOf(' ', limit);
    if (splitAt < limit * 0.5) splitAt = limit;
    chunks.push(rest.slice(0, splitAt).trim());
    rest = rest.slice(splitAt).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function truncate(text, maxChars) {
  const input = String(text || '');
  if (input.length <= maxChars) return input;
  return `${input.slice(0, maxChars - 1)}…`;
}

function safeError(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

function incrementTelemetry(field, delta = 1) {
  if (!state.telemetry || typeof state.telemetry !== 'object') return;
  const next = Number(state.telemetry[field] || 0) + delta;
  state.telemetry[field] = Number.isFinite(next) ? next : 0;
}

function recordAudit(type, eventOrPeerKey, detail = '', extra = {}) {
  if (!state.telemetry || typeof state.telemetry !== 'object') return;
  const peerKey = typeof eventOrPeerKey === 'string' ? eventOrPeerKey : eventOrPeerKey?.peerKey || '';
  const kind = typeof eventOrPeerKey === 'string' ? '' : eventOrPeerKey?.kind || '';
  const item = {
    at: new Date().toISOString(),
    type,
    peerKey,
    kind,
    detail: truncate(String(detail || '').trim(), 220),
    ...extra,
  };
  const audit = Array.isArray(state.telemetry.audit) ? state.telemetry.audit : [];
  audit.push(item);
  if (audit.length > DELIVERY_AUDIT_MAX) {
    audit.splice(0, audit.length - DELIVERY_AUDIT_MAX);
  }
  state.telemetry.audit = audit;
  saveState();
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(value) {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return '(none)';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return new Date(ts).toISOString();
  }
}

function formatIsoTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return '(unknown)';
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return raw;
  return formatTimestamp(ts);
}

function sanitizePeerKey(value) {
  return String(value || '').replace(/[^a-zA-Z0-9:_-]/g, '_');
}

function normalizeQueueLimit(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function normalizeTimeoutMs(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function normalizeEffort(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  return null;
}
