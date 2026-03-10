import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
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
import {
  clearPinnedSessionHistory,
  createAutoSessionTitle,
  findSessionHistoryItem,
  normalizeSessionHistory,
  pinSessionHistory,
  renameSessionHistory,
  upsertSessionHistory,
} from './session-history.js';
import {
  formatQuickActionCapability,
  isQuickActionUnsupportedError,
  markQuickActionsSupported,
  markQuickActionsUnsupported,
  normalizeQuickActionCapability,
  shouldAttemptQuickActions,
} from './quick-actions.js';
import {
  commitWorkspace,
  ensureWorkspaceGitRepo,
  getDiffReport,
  getRepoLog,
  getRepoStatus,
  rollbackWorkspace,
  switchBranch,
} from './workspace-git.js';
import {
  buildHelpMessage,
  buildUnknownCommandMessage,
} from './help-message.js';
import {
  normalizeImageOcrMode,
  shouldAttemptImageOcr,
} from './image-ocr.js';
import {
  cleanupExpiredPendingActions,
  consumePendingAction,
  createPendingAction,
  getLatestPendingAction,
  listPendingActions,
  peekPendingAction,
} from './pending-actions.js';
import {
  createGatewayRuntimeState,
  DEFAULT_GATEWAY_HEARTBEAT_ACK_GRACE_MS,
  forceGatewayFreshIdentify,
  isGatewayHeartbeatOverdue,
  noteGatewayClose,
  noteGatewayHeartbeatAck,
  noteGatewayHeartbeatSent,
  noteGatewayHello,
  noteGatewayIdentifyAttempt,
  noteGatewayReady,
  noteGatewayReconnectRequested,
  noteGatewayResumeAttempt,
  resolveGatewayReconnectDelay,
  shouldAttemptGatewayResume,
  shouldResetReconnectBackoff,
} from './gateway-resilience.js';
import {
  createTextShortcutMenu,
  formatTextShortcutHint,
  isTextShortcutMenuExpired,
  resolveTextShortcutCommand,
} from './text-shortcuts.js';
import {
  exportWorkspaceDiff,
  getPatchArtifact,
  listChangedFiles,
  openWorkspaceFile,
} from './workspace-artifacts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const APP_VERSION = readPackageVersion();
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
const IMAGE_OCR_MODE = normalizeImageOcrMode(process.env.IMAGE_OCR_MODE || 'auto');
const MAX_IMAGE_OCR_CHARS_PER_FILE = normalizePositiveInt(process.env.MAX_IMAGE_OCR_CHARS_PER_FILE, 1200);
const MAX_EXTRACTED_TEXT_CHARS_PER_FILE = normalizePositiveInt(process.env.MAX_EXTRACTED_TEXT_CHARS_PER_FILE, 4000);
const MAX_EXTRACTED_TEXT_TOTAL_CHARS = normalizePositiveInt(process.env.MAX_EXTRACTED_TEXT_TOTAL_CHARS, 12000);
const RECENT_FILES_MAX = 20;
const SESSION_HISTORY_MAX = 20;
const WORKSPACE_HISTORY_MAX = 8;
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
const QUICK_ACTION_RETRY_MS = normalizeTimeoutMs(process.env.QUICK_ACTION_RETRY_MS, 6 * 60 * 60 * 1000);
const RETRACT_PROGRESS_MESSAGES = String(process.env.RETRACT_PROGRESS_MESSAGES || 'false').toLowerCase() !== 'false';
const DELIVERY_AUDIT_MAX = normalizeQueueLimit(process.env.DELIVERY_AUDIT_MAX, 120);
const QQ_API_TIMEOUT_MS = normalizeTimeoutMs(process.env.QQ_API_TIMEOUT_MS, 15000);
const QQ_DOWNLOAD_TIMEOUT_MS = normalizeTimeoutMs(process.env.QQ_DOWNLOAD_TIMEOUT_MS, 30000);
const TEXT_SHORTCUT_TTL_MS = normalizeTimeoutMs(process.env.TEXT_SHORTCUT_TTL_MS, 10 * 60 * 1000);
const GATEWAY_HEARTBEAT_ACK_GRACE_MS = DEFAULT_GATEWAY_HEARTBEAT_ACK_GRACE_MS;
const PENDING_ACTION_TTL_MS = normalizeTimeoutMs(process.env.PENDING_ACTION_TTL_MS, 10 * 60 * 1000);

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
const BOOT_LOG_MARKER = '=== CodeX-to-QQ boot ===';

let lockFd = null;
let cachedToken = null;
let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let reconnectIndex = 0;
let stopped = false;
let gatewayConnectionSeq = 0;
const gatewayRuntime = createGatewayRuntimeState();
let cachedImageOcrBackend = undefined;

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

console.log(`${BOOT_LOG_MARKER} ${new Date().toISOString()}`);
console.error(`${BOOT_LOG_MARKER} ${new Date().toISOString()}`);
console.log(`🧩 Codex CLI: ${codexHealth.version} via ${codexHealth.bin}`);
console.log(`🚀 CodeX-to-QQ: v${APP_VERSION}`);
console.log(`🤖 QQ bot mode: ${QQBOT_ENABLE_GROUP ? 'c2c + group@' : 'c2c only'}`);
console.log(`🔐 default mode: ${DEFAULT_MODE}`);
console.log(`🗂️ workspace root: ${WORKSPACE_ROOT}`);
console.log(`📦 queue limit per peer: ${MAX_QUEUE_PER_PEER === 0 ? 'unlimited' : MAX_QUEUE_PER_PEER}`);
console.log(`📎 attachments: ${DOWNLOAD_ATTACHMENTS ? `download on (max ${MAX_ATTACHMENTS_PER_MESSAGE}, ${formatBytes(MAX_ATTACHMENT_BYTES)})` : 'prompt url only'}`);
console.log(`📄 text extraction: ${EXTRACT_ATTACHMENT_TEXT ? `on (${MAX_EXTRACTED_TEXT_CHARS_PER_FILE}/${MAX_EXTRACTED_TEXT_TOTAL_CHARS} chars)` : 'off'}`);
console.log(`🖼️ image OCR: ${IMAGE_OCR_MODE}`);
console.log(`🚦 global concurrency: ${MAX_GLOBAL_ACTIVE_RUNS === 0 ? 'unlimited' : MAX_GLOBAL_ACTIVE_RUNS}`);
console.log(`🗜️ context compaction: ${COMPACT_CONTEXT_ON_THRESHOLD ? 'on' : 'off'}`);
console.log(`💬 receive ack: ${SEND_ACK_ON_RECEIVE ? 'on' : 'off'}`);
console.log(`📮 proactive final reply after: ${PROACTIVE_FINAL_REPLY_AFTER_MS > 0 ? `${PROACTIVE_FINAL_REPLY_AFTER_MS}ms` : 'off'}`);
console.log(`⏱️ auto progress ping: ${AUTO_PROGRESS_PING_MS > 0 && MAX_AUTO_PROGRESS_PINGS !== 0 ? `${AUTO_PROGRESS_PING_MS}ms × ${MAX_AUTO_PROGRESS_PINGS}` : 'off'}`);
console.log(`🛰️ milestone progress notify: ${PHASE_PROGRESS_NOTIFY && MAX_PHASE_PROGRESS_NOTICES !== 0 ? `on (${MAX_PHASE_PROGRESS_NOTICES}, min ${MIN_PHASE_PROGRESS_NOTIFY_MS}ms)` : 'off'}`);
console.log(`🎛️ quick actions: ${ENABLE_QUICK_ACTIONS ? 'on' : 'off'}`);
console.log(`🔁 quick-action retry window: ${ENABLE_QUICK_ACTIONS ? (QUICK_ACTION_RETRY_MS > 0 ? `${QUICK_ACTION_RETRY_MS}ms` : 'disabled after first unsupported error') : 'off'}`);
console.log(`🧹 retract progress cards: ${RETRACT_PROGRESS_MESSAGES ? 'on' : 'off'}`);
console.log(`⌨️ text shortcut menu: ${TEXT_SHORTCUT_TTL_MS > 0 ? `${TEXT_SHORTCUT_TTL_MS}ms` : 'off'}`);
console.log(`🌐 QQ API timeout: ${QQ_API_TIMEOUT_MS > 0 ? `${QQ_API_TIMEOUT_MS}ms` : 'off'} | download timeout: ${QQ_DOWNLOAD_TIMEOUT_MS > 0 ? `${QQ_DOWNLOAD_TIMEOUT_MS}ms` : 'off'}`);

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

void startGateway();

async function startGateway() {
  try {
    await connect();
  } catch (err) {
    console.error('Initial gateway connect failed:', safeError(err));
    state.gateway.lastError = safeError(err);
    saveState();
    if (!stopped) {
      scheduleReconnect();
    }
  }
}

async function connect() {
  clearHeartbeat();
  clearReconnect();
  const previousSocket = ws;
  ws = null;
  closeGatewaySocket(previousSocket, 'replace-before-reconnect');
  gatewayRuntime.connectionOpenedAt = 0;
  gatewayRuntime.awaitingHeartbeatAck = false;

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
    gatewayRuntime.connectionOpenedAt = Date.now();
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
    noteGatewayClose(gatewayRuntime, code, String(reason || ''), Date.now());
    handleGatewayCloseCode(code);
    saveState();
    if (!stopped) {
      scheduleReconnect(resolveGatewayReconnectDelay({
        code,
        reconnectIndex,
        sessionTimeoutStreak: gatewayRuntime.sessionTimeoutStreak,
        reconnectRequestedStreak: gatewayRuntime.reconnectRequestedStreak,
        defaultDelays: RECONNECT_DELAYS,
      }));
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
      noteGatewayHello(gatewayRuntime, interval, Date.now());
      startHeartbeat(socket, interval);
      if (shouldAttemptGatewayResume(state.gateway, gatewayRuntime, Date.now())) {
        noteGatewayResumeAttempt(gatewayRuntime, Date.now());
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
        noteGatewayIdentifyAttempt(gatewayRuntime, Date.now());
        socket.send(JSON.stringify({
          op: 2,
          d: {
            token: `QQBot ${accessToken}`,
            intents: IDENTIFY_INTENTS,
            shard: [0, 1],
          },
        }));
        const cooldownNote = gatewayRuntime.forceFreshIdentifyUntil > Date.now()
          ? ` | fresh-identify until ${formatIsoTimestamp(new Date(gatewayRuntime.forceFreshIdentifyUntil).toISOString())}`
          : '';
        console.log(`📡 Sent identify (#${connectionId}) with intents=${IDENTIFY_INTENTS}${cooldownNote}`);
      }
      saveState();
      break;
    }
    case 0:
      await handleDispatch(payload.t, payload.d);
      break;
    case 7:
      console.log('⚠️ QQ gateway requested reconnect');
      noteGatewayReconnectRequested(gatewayRuntime, Date.now());
      requestGatewayReconnect('gateway requested reconnect', resolveGatewayReconnectDelay({
        code: 7,
        reconnectIndex,
        reconnectRequestedStreak: gatewayRuntime.reconnectRequestedStreak,
        defaultDelays: RECONNECT_DELAYS,
      }));
      break;
    case 9:
      console.log('⚠️ QQ gateway invalid session; clearing saved gateway session');
      clearGatewaySessionState('invalid session');
      forceGatewayFreshIdentify(gatewayRuntime, Date.now());
      saveState();
      requestGatewayReconnect('invalid session', resolveGatewayReconnectDelay({
        code: 4009,
        reconnectIndex,
        sessionTimeoutStreak: Math.max(2, gatewayRuntime.sessionTimeoutStreak),
        defaultDelays: RECONNECT_DELAYS,
      }));
      break;
    case 11:
      noteGatewayHeartbeatAck(gatewayRuntime, Date.now());
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
    noteGatewayReady(gatewayRuntime, Date.now());
    if (shouldResetReconnectBackoff(type)) {
      reconnectIndex = 0;
    }
    saveState();
    console.log(`✅ QQ READY session=${state.gateway.sessionId}`);
    return;
  }

  if (type === 'RESUMED') {
    state.gateway.lastConnectedAt = Date.now();
    state.gateway.lastError = null;
    noteGatewayReady(gatewayRuntime, Date.now());
    if (shouldResetReconnectBackoff(type)) {
      reconnectIndex = 0;
    }
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

  const textShortcutCommand = consumeTextShortcutCommand(event, content);
  if (textShortcutCommand) {
    recordAudit('text-shortcut', event, `${content} => ${textShortcutCommand}`);
    await handleImmediateCommand(event, textShortcutCommand);
    return;
  }

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

  if (cmd === '/confirm-action') {
    await handleConfirmActionCommand(event, session, runtime, rest);
    return;
  }

  if (cmd === '/help') {
    const helpVariant = normalizeHelpVariant(rest[0] || '');
    await replyText(event, buildHelpMessageForSession(event, session, runtime, helpVariant), { quickActions: true, uiCategory: 'help', replaceUiCard: true });
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
    await replyText(event, formatSessionHistoryMessage(session), {
      quickActions: true,
      uiCategory: 'sessions',
      replaceUiCard: true,
      textShortcutMenu: buildSessionsShortcutMenu(session),
    });
    return;
  }

  if (cmd === '/rename') {
    const raw = rest.join(' ').trim();
    if (!raw) {
      await replyText(event, '用法：/rename <新标题> 或 /rename <session_id> <新标题>');
      return;
    }
    const parsed = parseSessionTargetWithOptionalText(session, raw, { fallbackToCurrent: true });
    const nextTitle = parsed.text;
    if (!nextTitle) {
      await replyText(event, '用法：/rename <新标题> 或 /rename <session_id> <新标题>');
      return;
    }
    if (!parsed.targetId) {
      session.pendingSessionTitle = truncate(nextTitle, 36);
      session.updatedAt = new Date().toISOString();
      saveState();
      await replyText(event, `✅ 已设置下一个新会话的标题：${session.pendingSessionTitle}`, { quickActions: true, uiCategory: 'session', replaceUiCard: true });
      return;
    }
    renameSessionHistoryEntry(session, parsed.targetId, nextTitle);
    session.updatedAt = new Date().toISOString();
    saveState();
    recordAudit('session-rename', event, `${parsed.targetId} => ${truncate(nextTitle, 60)}`);
    await replyText(event, `✅ 已重命名会话：${parsed.targetId}\n标题：${truncate(nextTitle, 80)}`, { quickActions: true, uiCategory: 'session', replaceUiCard: true });
    return;
  }

  if (cmd === '/pin') {
    const raw = rest.join(' ').trim();
    const normalized = raw.toLowerCase();
    if (['clear', 'off', 'unset', 'none'].includes(normalized)) {
      session.sessionHistory = clearPinnedSessionHistory(session.sessionHistory, SESSION_HISTORY_MAX);
      session.updatedAt = new Date().toISOString();
      saveState();
      recordAudit('session-unpin-all', event, 'cleared');
      await replyText(event, '✅ 已清除所有置顶会话。', { quickActions: true, uiCategory: 'sessions', replaceUiCard: true });
      return;
    }
    const targetId = resolveSessionReference(session, raw) || getDefaultSessionTargetId(session);
    if (!targetId) {
      await replyText(event, '当前没有可置顶的会话。先发一条普通消息开始，或用 `/resume <id>` 绑定旧会话。');
      return;
    }
    rememberSessionIfCurrent(session, targetId, 'pin');
    pinSessionHistoryEntry(session, targetId, true);
    session.updatedAt = new Date().toISOString();
    saveState();
    recordAudit('session-pin', event, targetId);
    await replyText(event, `📌 已置顶会话：${targetId}`, { quickActions: true, uiCategory: 'sessions', replaceUiCard: true });
    return;
  }

  if (cmd === '/fork') {
    const raw = rest.join(' ').trim();
    const parsed = parseForkCommandInput(session, raw);
    if (!parsed.sourceSessionId) {
      await replyText(event, '用法：/fork [source_session_id] [新标题]\n当前没有可分支的来源会话。');
      return;
    }
    const cancelled = cancelPeerRun(event.peerKey, 'fork new branch');
    const sourceItem = getSessionHistoryEntry(session, parsed.sourceSessionId);
    const branchTitle = parsed.title || buildForkSessionTitle(sourceItem, parsed.sourceSessionId);
    const summary = buildForkSummary(session, sourceItem, parsed.sourceSessionId);
    rememberSessionIfCurrent(session, session.codexThreadId, 'fork-source');
    storePendingSummary(session, summary, parsed.sourceSessionId);
    session.pendingForkSourceSessionId = parsed.sourceSessionId;
    session.pendingSessionTitle = branchTitle;
    session.codexThreadId = null;
    session.lastInputTokens = null;
    session.updatedAt = new Date().toISOString();
    saveState();
    recordAudit('session-fork', event, `${parsed.sourceSessionId} => ${truncate(branchTitle, 60)}`);
    const lines = [
      '🌿 已准备新的分支会话。',
      `来源会话：${parsed.sourceSessionId}`,
      `新标题：${branchTitle}`,
      '下一条普通消息会基于该来源摘要开启一个全新的 Codex 会话。',
    ];
    if (cancelled.active) lines.push('当前运行中的任务已尝试取消。');
    if (cancelled.clearedQueued > 0) lines.push(`已清空 ${cancelled.clearedQueued} 个排队任务。`);
    await replyText(event, lines.join('\n'), { quickActions: true, uiCategory: 'session', replaceUiCard: true });
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

  if (cmd === '/workspace') {
    const handled = await handleWorkspaceCommand(event, session, rest);
    if (handled) return;
  }

  if (cmd === '/changed') {
    const workspaceDir = getWorkspaceDirForSession(event, session);
    const changed = listChangedFiles(workspaceDir);
    recordAudit('repo-changed', event, changed.ok ? `changed=${changed.status.entries.length}` : (changed.error || 'failed'));
    await replyText(event, formatChangedFilesMessage(workspaceDir, changed), { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
    return;
  }

  if (cmd === '/patch') {
    const workspaceDir = getWorkspaceDirForSession(event, session);
    const target = rest.join(' ').trim();
    const patch = getPatchArtifact(workspaceDir, target);
    recordAudit('repo-patch', event, target || '(all)');
    await replyText(event, formatPatchMessage(workspaceDir, patch, target), { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
    return;
  }

  if (cmd === '/open') {
    const target = rest.join(' ').trim();
    if (!target) {
      await replyText(event, '用法：/open <相对路径|文件名>');
      return;
    }
    const workspaceDir = getWorkspaceDirForSession(event, session);
    const opened = openWorkspaceFile(workspaceDir, target);
    recordAudit('workspace-open', event, target);
    await replyText(event, formatOpenFileMessage(workspaceDir, opened), { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
    return;
  }

  if (cmd === '/repo') {
    const subcommand = String(rest[0] || 'status').trim().toLowerCase();
    const workspaceDir = getWorkspaceDirForSession(event, session);
    if (subcommand === 'path') {
      await replyText(event, `📁 当前 workspace\n${workspaceDir}`, { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
      return;
    }
    if (subcommand === 'log') {
      const repoLog = getRepoLog(workspaceDir, 6);
      await replyText(event, formatRepoLogMessage(workspaceDir, repoLog), { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
      return;
    }
    if (subcommand !== 'status' && rest.length > 0) {
      await replyText(event, '用法：/repo [status|log|path]');
      return;
    }
    const repoStatus = getRepoStatus(workspaceDir);
    recordAudit('repo-status', event, repoStatus.ok ? `${repoStatus.branch} clean=${repoStatus.clean}` : repoStatus.error || 'repo status failed');
    await replyText(event, formatRepoStatusMessage(workspaceDir, repoStatus), { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
    return;
  }

  if (cmd === '/branch') {
    const workspaceDir = getWorkspaceDirForSession(event, session);
    const raw = rest.join(' ').trim();
    if (!raw) {
      const repoStatus = getRepoStatus(workspaceDir);
      await replyText(event, formatBranchListMessage(repoStatus), { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
      return;
    }
    const switched = switchBranch(workspaceDir, raw);
    if (!switched.ok) {
      await replyText(event, `❌ 切换分支失败\n${switched.error || '(unknown)'}`, { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
      return;
    }
    session.updatedAt = new Date().toISOString();
    saveState();
    recordAudit('repo-branch', event, `${raw} => ${switched.branch}`);
    await replyText(event, [
      switched.created ? '🌱 已创建并切换到新分支。' : '🌿 已切换分支。',
      `当前分支：${switched.branch}`,
      ...(switched.sanitized ? [`原输入已规范化：${raw}`] : []),
      `工作区：${workspaceDir}`,
    ].join('\n'), { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
    return;
  }

  if (cmd === '/diff') {
    const mode = normalizeDiffMode(rest[0] || '');
    if (!mode) {
      await replyText(event, '用法：/diff [working|staged|all]');
      return;
    }
    const workspaceDir = getWorkspaceDirForSession(event, session);
    const report = getDiffReport(workspaceDir, mode);
    recordAudit('repo-diff', event, `${mode}:${report.ok ? 'ok' : (report.error || 'failed')}`);
    await replyText(event, formatDiffMessage(workspaceDir, report, mode), { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
    return;
  }

  if (cmd === '/export') {
    const target = String(rest[0] || '').trim().toLowerCase();
    if (target !== 'diff') {
      await replyText(event, '用法：/export diff [working|staged|all]');
      return;
    }
    const mode = normalizeDiffMode(rest[1] || '');
    if (!mode) {
      await replyText(event, '用法：/export diff [working|staged|all]');
      return;
    }
    const workspaceDir = getWorkspaceDirForSession(event, session);
    const exported = exportWorkspaceDiff(workspaceDir, mode);
    recordAudit('repo-export', event, `${target}:${mode}`);
    await replyText(event, formatExportMessage(workspaceDir, exported, mode), { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
    return;
  }

  if (cmd === '/progress') {
    await replyText(event, formatProgressMessage(session, runtime), { quickActions: true, uiCategory: 'progress', replaceUiCard: true });
    return;
  }

  if (cmd === '/queue') {
    await replyText(event, formatQueueMessage(session, runtime), { quickActions: true, uiCategory: 'progress', replaceUiCard: true });
    return;
  }

  if (cmd === '/diag') {
    await replyText(event, formatDiagnosticsMessage(event), { quickActions: true, uiCategory: 'diag', replaceUiCard: true });
    return;
  }

  if (cmd === '/version') {
    await replyText(event, formatVersionMessage(), { quickActions: true, uiCategory: 'diag', replaceUiCard: true });
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

  if (cmd === '/retry') {
    if (!session.lastPromptInput) {
      await replyText(event, '当前没有可重试的最近请求。先发一条普通消息，或等待一次任务执行完成。');
      return;
    }
    await enqueuePrompt(event, session.lastPromptInput, {
      reason: 'retry',
      label: `重试：${session.lastPromptPreview || describePromptInput(session.lastPromptInput)}`,
      sourceSessionId: session.codexThreadId || session.lastRun?.threadId || '',
    });
    recordAudit('run-retry', event, truncate(session.lastPromptPreview || describePromptInput(session.lastPromptInput), 120));
    return;
  }

  if (cmd === '/commit') {
    const message = rest.join(' ').trim();
    if (!message) {
      await replyText(event, '用法：/commit <提交说明>');
      return;
    }
    const workspaceDir = getWorkspaceDirForSession(event, session);
    const committed = commitWorkspace(workspaceDir, message);
    if (!committed.ok) {
      await replyText(event, committed.noChanges ? 'ℹ️ 当前没有可提交的改动。' : `❌ 提交失败\n${committed.error || '(unknown)'}`, { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
      return;
    }
    recordAudit('repo-commit', event, `${committed.hash} ${truncate(message, 80)}`);
    await replyText(event, [
      '✅ 已提交当前 workspace 改动。',
      `commit：${committed.hash} ${message}`,
      `分支：${committed.branch || '(unknown)'}`,
      `文件：${committed.stagedFiles.slice(0, 6).join(', ')}${committed.stagedFiles.length > 6 ? ` 等 ${committed.stagedFiles.length} 个` : ''}`,
    ].join('\n'), { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
    return;
  }

  if (cmd === '/rollback') {
    const mode = normalizeRollbackMode(rest[0] || '');
    if (!mode) {
      await replyText(event, '用法：/rollback [tracked|all]\n`tracked` 仅回退已跟踪改动；`all` 还会清理未跟踪文件（保留 `.attachments/`）。');
      return;
    }
    if (mode === 'all') {
      await promptPendingActionConfirmation(event, runtime, {
        prefix: 'rollback',
        kind: 'rollback',
        title: '确认回退所有工作区改动',
        lines: [
          '这会回退已跟踪改动，并清理未跟踪文件（保留 `.attachments/`）。',
          `工作区：${getWorkspaceDirForSession(event, session)}`,
        ],
        data: { mode },
        uiCategory: 'repo',
        confirmOptions: [
          { label: '确认回退', value: 'confirm' },
          { label: '仅看状态', value: 'status' },
          { label: '取消', value: 'cancel' },
        ],
      });
      return;
    }
    const workspaceDir = getWorkspaceDirForSession(event, session);
    const rolledBack = rollbackWorkspace(workspaceDir, mode);
    if (!rolledBack.ok) {
      await replyText(event, `❌ 回退失败\n${rolledBack.error || '(unknown)'}`, { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
      return;
    }
    recordAudit('repo-rollback', event, mode);
    await replyText(event, formatRollbackMessage(workspaceDir, rolledBack, mode), { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
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
      clearPendingSessionDraft(session);
      session.updatedAt = new Date().toISOString();
      saveState();
      await replyText(event, '✅ 已清除当前绑定的 Codex session。下条消息会新建会话。');
      return;
    }
    const targetSessionId = resolveSessionReference(session, raw) || raw;
    if (session.codexThreadId) {
      rememberSessionId(session, session.codexThreadId, session.lastInputTokens, 'manual-resume-switch');
    }
    session.codexThreadId = targetSessionId;
    session.lastInputTokens = null;
    clearPendingSessionDraft(session);
    rememberSessionId(session, targetSessionId, null, 'manual-resume');
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
    if (nextMode === 'dangerous' && session.mode !== 'dangerous') {
      await promptPendingActionConfirmation(event, runtime, {
        prefix: 'mode',
        kind: 'mode-switch',
        title: '确认切换到 dangerous 模式',
        lines: [
          'dangerous 模式下，Codex 可直接执行更激进的本地操作。',
          '仅建议在你完全信任当前 QQ bot 和 workspace 时开启。',
        ],
        data: { nextMode },
        uiCategory: 'status',
        confirmOptions: [
          { label: '切到 dangerous', value: 'confirm' },
          { label: '保持 safe', value: 'cancel' },
        ],
      });
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

  await replyText(event, buildUnknownCommandMessageForSession(session, runtime));
}

async function handleWorkspaceCommand(event, session, rest) {
  const raw = rest.join(' ').trim();
  const subcommand = String(rest[0] || '').trim().toLowerCase();

  if (!raw || ['path', 'show', 'status', 'current'].includes(subcommand)) {
    await replyText(event, formatWorkspaceMessage(event, session), { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
    return true;
  }

  if (['reset', 'default', 'clear'].includes(subcommand)) {
    session.workspaceDir = getDefaultWorkspaceDir(event.peerKey);
    rememberWorkspaceHistory(session, session.workspaceDir);
    session.updatedAt = new Date().toISOString();
    saveState();
    recordAudit('workspace-reset', event, session.workspaceDir);
    await replyText(event, formatWorkspaceMessage(event, session, {
      notice: '✅ 已恢复默认 workspace。',
    }), { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
    return true;
  }

  if (['recent', 'list'].includes(subcommand)) {
    await replyText(event, formatWorkspaceHistoryMessage(event, session), {
      quickActions: true,
      uiCategory: 'repo',
      replaceUiCard: true,
      textShortcutMenu: buildWorkspaceShortcutMenu(event, session),
    });
    return true;
  }

  const targetInput = ['set', 'use', 'cd'].includes(subcommand)
    ? rest.slice(1).join(' ').trim()
    : raw;
  if (!targetInput) {
    await replyText(event, '用法：/workspace [show|recent|set <path|编号>|reset]\n相对路径会放到 WORKSPACE_ROOT 下；绝对路径可直接指向现有项目。');
    return true;
  }

  const resolvedTarget = resolveWorkspaceReference(event, session, targetInput) || targetInput;
  const resolved = resolveWorkspaceOverrideInput(resolvedTarget);
  if (!resolved.ok) {
    await replyText(event, `❌ workspace 设置失败\n${resolved.error}`);
    return true;
  }

  session.workspaceDir = resolved.workspaceDir;
  rememberWorkspaceHistory(session, resolved.workspaceDir);
  session.updatedAt = new Date().toISOString();
  saveState();
  recordAudit('workspace-set', event, session.workspaceDir, {
    created: resolved.created,
    relativeToRoot: resolved.relativeToRoot,
  });
  await replyText(event, formatWorkspaceMessage(event, session, {
    notice: resolved.created ? '✅ 已切换到新的 workspace，并已自动创建目录。' : '✅ 已切换 workspace。',
  }), { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
  return true;
}

async function handleConfirmActionCommand(event, session, runtime, rest) {
  const rawToken = String(rest[0] || '').trim();
  const rawDecision = String(rest[1] || '').trim().toLowerCase();
  const tokenKeyword = rawToken.toLowerCase();

  if (!rawToken) {
    await replyText(event, '用法：`/confirm-action list`，或 `/confirm-action <token|latest> <confirm|cancel>`。');
    return;
  }

  if (['list', 'ls'].includes(tokenKeyword)) {
    await replyText(event, formatPendingActionsMessage(runtime), { quickActions: true, uiCategory: 'status', replaceUiCard: true });
    return;
  }

  const latestPending = tokenKeyword === 'latest' ? getLatestPendingAction(runtime.pendingActions) : null;
  const token = latestPending?.token || rawToken;
  const decision = rawDecision;

  if (!decision) {
    const pending = peekPendingAction(runtime.pendingActions, token);
    if (!pending) {
      await replyText(event, '这条确认已经过期或不存在，可发 `/confirm-action list` 查看当前待确认操作。');
      return;
    }
    await replyText(event, formatPendingActionDetailMessage(token, pending), { quickActions: true, uiCategory: 'status', replaceUiCard: true });
    return;
  }

  const pending = peekPendingAction(runtime.pendingActions, token);
  if (!pending) {
    await replyText(event, '这条确认已经过期，请重新发送原命令。');
    return;
  }

  if (decision === 'cancel') {
    consumePendingAction(runtime.pendingActions, token);
    await replyText(event, `✅ 已取消：${pending.title || pending.kind}`);
    return;
  }

  if (pending.kind === 'rollback') {
    const workspaceDir = getWorkspaceDirForSession(event, session);
    if (decision === 'status') {
      const repoStatus = getRepoStatus(workspaceDir);
      await replyText(event, formatRepoStatusMessage(workspaceDir, repoStatus), { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
      return;
    }
    if (decision === 'confirm') {
      const mode = normalizeRollbackMode(pending.data?.mode || '');
      if (!mode) {
        await replyText(event, '确认数据缺失，请重新发送 `/rollback all`。');
        return;
      }
      consumePendingAction(runtime.pendingActions, token);
      const rolledBack = rollbackWorkspace(workspaceDir, mode);
      if (!rolledBack.ok) {
        await replyText(event, `❌ 回退失败\n${rolledBack.error || '(unknown)'}`, { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
        return;
      }
      recordAudit('repo-rollback', event, `${mode}:confirmed`);
      await replyText(event, formatRollbackMessage(workspaceDir, rolledBack, mode), { quickActions: true, uiCategory: 'repo', replaceUiCard: true });
      return;
    }
  }

  if (pending.kind === 'mode-switch') {
    if (decision === 'confirm') {
      const nextMode = String(pending.data?.nextMode || '').trim();
      if (nextMode !== 'dangerous' && nextMode !== 'safe') {
        await replyText(event, '确认数据缺失，请重新发送 `/mode dangerous`。');
        return;
      }
      consumePendingAction(runtime.pendingActions, token);
      session.mode = nextMode;
      session.updatedAt = new Date().toISOString();
      saveState();
      recordAudit('mode-switch', event, `${nextMode}:confirmed`);
      await replyText(event, `✅ 当前会话模式已切换为 ${nextMode}`);
      return;
    }
  }

  await replyText(event, [
    '这条确认选项无法识别。',
    formatPendingActionDetailMessage(token, pending),
  ].join('\n\n'));
}

async function enqueuePrompt(event, promptInput, options = {}) {
  const runtime = getPeerRuntime(event.peerKey);
  const session = getPeerSession(event.peerKey, event.kind);
  clearPeerTextShortcutMenu(event.peerKey);
  if (MAX_QUEUE_PER_PEER > 0 && runtime.queue.length >= MAX_QUEUE_PER_PEER) {
    await replyText(event, `⛔ 当前会话排队已满（上限 ${MAX_QUEUE_PER_PEER}）。请稍后重试，或先发 /cancel 清队列。`);
    return;
  }

  const queuedBefore = runtime.queue.length + (runtime.activeRun ? 1 : 0);
  runtime.queue.push({
    event,
    promptInput,
    promptPreview: truncate(describePromptInput(promptInput), 120),
    enqueuedAt: Date.now(),
    jobId: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    reason: String(options.reason || 'message').trim() || 'message',
    label: String(options.label || '').trim(),
    sourceSessionId: String(options.sourceSessionId || '').trim() || null,
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
    promptPreview: job.promptPreview || truncate(describePromptInput(job.promptInput), 120),
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
    jobId: job.jobId,
    jobReason: job.reason || 'message',
    sourceSessionId: job.sourceSessionId || null,
  };
  runtime.activeRun = activeRun;
  let releaseGlobalSlot = () => {};
  let progressPingTimer = null;

  try {
    storeLastPromptInput(session, job.promptInput, activeRun.promptPreview);
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

    updateSessionFromResult(session, result, job.event.kind, activeRun);
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
  ensureWorkspaceGitRepo(workspaceDir);

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
  const shortcutMenu = buildReplyTextShortcutMenu(event, options);
  const decoratedText = appendTextShortcutHintToReply(text, shortcutMenu);
  const chunks = splitForChat(decoratedText, MAX_TEXT_CHARS);
  const sent = [];
  const runtime = getPeerRuntime(event.peerKey);
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
  if (shortcutMenu && sent.length > 0) {
    runtime.textShortcutMenu = shortcutMenu;
  } else if (options.uiCategory) {
    runtime.textShortcutMenu = null;
  }
  if (options.uiCategory && sent[0]?.id) {
    rememberPeerUiCard(event.peerKey, options.uiCategory, sent[0].id);
  }
  return sent;
}

async function sendTextMessage(event, content, replyToMessageId, options = {}) {
  const token = await getAccessToken();
  const session = getPeerSession(event.peerKey, event.kind);
  const quickActionRequested = shouldAttemptQuickActions({
    enabled: ENABLE_QUICK_ACTIONS,
    requested: Boolean(options.quickActions),
    content,
    capability: session.quickActionsCapability,
    retryMs: QUICK_ACTION_RETRY_MS,
  });
  if (quickActionRequested) {
    try {
      const interactive = await sendInteractiveMessage(token, event, String(content || ''), replyToMessageId, {
        preferProactive: Boolean(options.preferProactive),
        uiCategory: options.uiCategory || '',
      });
      const nextCapability = markQuickActionsSupported(session.quickActionsCapability);
      if (JSON.stringify(nextCapability) !== JSON.stringify(session.quickActionsCapability)) {
        session.quickActionsCapability = nextCapability;
        session.updatedAt = new Date().toISOString();
        saveState();
        recordAudit('quick-actions-supported', event, options.uiCategory || 'general');
      }
      incrementTelemetry('outboundMessages');
      recordAudit('outbound', event, `interactive:${options.uiCategory || 'general'}`, {
        messageId: interactive?.id || '',
      });
      return interactive;
    } catch (err) {
      if (isQuickActionUnsupportedError(err)) {
        const nextCapability = markQuickActionsUnsupported(session.quickActionsCapability, err);
        const previousStatus = session.quickActionsCapability?.status || 'unknown';
        session.quickActionsCapability = nextCapability;
        session.updatedAt = new Date().toISOString();
        saveState();
        if (previousStatus !== 'unsupported') {
          console.warn(`quick actions disabled for ${event.peerKey}: ${nextCapability.disabledReason || safeError(err)}`);
          recordAudit('quick-actions-disabled', event, truncate(nextCapability.disabledReason || safeError(err), 200), {
            category: options.uiCategory || '',
            code: nextCapability.failureCode || '',
          });
        }
      } else {
        console.error(`interactive send failed, fallback to text: ${safeError(err)}`);
      }
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

  const response = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: QQBOT_APP_ID,
      clientSecret: QQBOT_CLIENT_SECRET,
    }),
  }, QQ_API_TIMEOUT_MS);

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
  const canRetry = Boolean(session.lastPromptInput) && !runtime.activeRun;

  if (category === 'session') {
    return {
      content: {
        rows: [
          { buttons: [
            buildKeyboardButton('分支', '/fork', 1),
            buildKeyboardButton('置顶', '/pin', 0),
          ] },
          { buttons: [
            buildKeyboardButton('历史', '/sessions', 0),
            buildKeyboardButton('状态', '/status', 0),
          ] },
          { buttons: [
            buildKeyboardButton('队列', '/queue', 0),
            buildKeyboardButton('新会', '/new', 1),
          ] },
        ],
      },
    };
  }

  if (category === 'sessions') {
    return {
      content: {
        rows: [
          { buttons: [
            buildKeyboardButton('置顶', '/pin', 0),
            buildKeyboardButton('分支', '/fork', 1),
          ] },
          { buttons: [
            buildKeyboardButton('状态', '/status', 0),
            buildKeyboardButton('队列', '/queue', 0),
          ] },
          { buttons: [
            buildKeyboardButton('新会', '/new', 1),
            buildKeyboardButton('文件', '/files', 0),
          ] },
        ],
      },
    };
  }

  if (category === 'repo') {
    return {
      content: {
        rows: [
          { buttons: [
            buildKeyboardButton('仓库', '/repo', 0),
            buildKeyboardButton('改动', '/changed', 1),
          ] },
          { buttons: [
            buildKeyboardButton('分支', '/branch', 0),
            buildKeyboardButton('差异', '/diff', 0),
          ] },
          { buttons: [
            buildKeyboardButton('工作区', '/workspace', 0),
            buildKeyboardButton('新会', '/new', 1),
          ] },
        ],
      },
    };
  }

  const firstRow = runtime.activeRun
    ? [
      buildKeyboardButton('进展', '/progress', 1),
      buildKeyboardButton('队列', '/queue', 0),
    ]
    : [
      buildKeyboardButton('新会', '/new', 1),
      buildKeyboardButton('状态', '/status', 0),
    ];
  const secondRow = runtime.activeRun
    ? [
      buildKeyboardButton('停止', '/stop', 4, '将终止当前任务'),
      buildKeyboardButton('状态', '/status', 0),
    ]
    : [
      buildKeyboardButton(canRetry ? '重试' : '历史', canRetry ? '/retry' : '/sessions', canRetry ? 1 : 0),
      buildKeyboardButton('文件', '/files', 0),
    ];
  const thirdRow = runtime.activeRun
    ? [
      buildKeyboardButton('新会', '/new', 1),
      buildKeyboardButton('诊断', '/diag', 0),
    ]
    : [
      buildKeyboardButton('队列', '/queue', 0),
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
  const response = await fetchWithTimeout(`${API_BASE}${requestPath}`, {
    method,
    headers: {
      Authorization: `QQBot ${accessToken}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, QQ_API_TIMEOUT_MS);

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

  throw buildQqApiError(requestPath, response.status, payload);
}

function buildQqApiError(requestPath, status, payload) {
  const error = new Error(`QQ API ${requestPath} failed (${status}): ${truncate(JSON.stringify(payload), 400)}`);
  error.status = status;
  error.requestPath = requestPath;
  error.qqCode = Number.isFinite(payload?.code) ? payload.code : null;
  error.qqErrCode = Number.isFinite(payload?.err_code) ? payload.err_code : null;
  error.qqMessage = String(payload?.message || '').trim();
  error.payload = payload;
  return error;
}

function getPeerSession(peerKey, kind) {
  if (!state.peers[peerKey]) {
    state.peers[peerKey] = {
      kind,
      workspaceDir: getDefaultWorkspaceDir(peerKey),
      codexThreadId: null,
      lastInputTokens: null,
      mode: DEFAULT_MODE,
      model: null,
      effort: null,
      profile: 'default',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastRun: null,
      lastPromptInput: null,
      lastPromptPreview: null,
      lastPromptAt: null,
      recentFiles: [],
      workspaceHistory: [],
      sessionHistory: [],
      pendingSummary: null,
      pendingSummarySourceSessionId: null,
      pendingSummaryCreatedAt: null,
      pendingSessionTitle: null,
      pendingForkSourceSessionId: null,
      quickActionsCapability: normalizeQuickActionCapability(null),
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
      textShortcutMenu: null,
      pendingActions: {},
    });
  }
  const runtime = peerRuntimes.get(peerKey);
  cleanupExpiredPendingActions(runtime.pendingActions, Date.now());
  return runtime;
}

function clearPeerTextShortcutMenu(peerKey) {
  const runtime = getPeerRuntime(peerKey);
  runtime.textShortcutMenu = null;
}

function createPendingActionToken(prefix = 'act') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function consumeTextShortcutCommand(event, content) {
  const runtime = getPeerRuntime(event.peerKey);
  if (isTextShortcutMenuExpired(runtime.textShortcutMenu)) {
    runtime.textShortcutMenu = null;
    return null;
  }
  const command = resolveTextShortcutCommand(content, runtime.textShortcutMenu);
  if (!command) return null;
  runtime.textShortcutMenu = null;
  return command;
}

async function promptPendingActionConfirmation(event, runtime, options = {}) {
  const token = createPendingActionToken(options.prefix || 'confirm');
  createPendingAction(runtime.pendingActions, token, {
    kind: options.kind || 'unknown',
    title: options.title || '',
    data: options.data || {},
  }, Date.now(), PENDING_ACTION_TTL_MS);

  const lines = [
    `⚠️ ${options.title || '需要确认的操作'}`,
    ...(options.lines || []),
    '',
    '请确认：',
  ];
  if (Array.isArray(options.confirmOptions)) {
    options.confirmOptions.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.label}`);
    });
  } else {
    lines.push('1. 确认');
    lines.push('2. 取消');
  }

  const menuItems = Array.isArray(options.confirmOptions) && options.confirmOptions.length > 0
    ? options.confirmOptions.map((item) => ({
      label: item.label,
      command: `/confirm-action ${token} ${item.value}`,
    }))
    : [
      { label: '确认', command: `/confirm-action ${token} confirm` },
      { label: '取消', command: `/confirm-action ${token} cancel` },
    ];

  await replyText(event, lines.join('\n'), {
    quickActions: true,
    uiCategory: options.uiCategory || 'status',
    replaceUiCard: true,
    textShortcutMenu: createTextShortcutMenu({
      category: 'confirm',
      items: menuItems,
      ttlMs: PENDING_ACTION_TTL_MS,
    }),
  });
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

function updateSessionFromResult(session, result, kind, activeRun = null) {
  const previousThreadId = String(session.codexThreadId || '').trim();
  const promptPreview = activeRun?.promptPreview || session.lastPromptPreview || '';
  const answerPreview = buildResultPreview(result);
  if (result.threadId) {
    session.codexThreadId = result.threadId;
    const isNewThread = !previousThreadId || previousThreadId !== String(result.threadId || '').trim();
    rememberSessionId(session, result.threadId, result.usage?.input_tokens, isNewThread ? (session.pendingForkSourceSessionId ? 'fork' : 'run') : 'run', {
      title: isNewThread
        ? (session.pendingSessionTitle || createAutoSessionTitle(promptPreview, result.threadId))
        : undefined,
      manualTitle: isNewThread ? Boolean(session.pendingSessionTitle) : undefined,
      parentSessionId: isNewThread ? session.pendingForkSourceSessionId : undefined,
      lastPromptPreview: promptPreview,
      lastAnswerPreview: answerPreview,
      lastRunOk: result.ok,
      runCountDelta: 1,
    });
    if (isNewThread) {
      clearPendingSessionDraft(session);
    }
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
    threadId: result.threadId || null,
    promptPreview: activeRun.promptPreview,
    latestActivity: activeRun.latestActivity,
    recentActivities: [...activeRun.recentActivities],
    answerPreview: buildResultPreview(result),
    logs: [...activeRun.logs].slice(-6),
  };
}

function buildResultPreview(result) {
  const answer = String(result?.finalAnswer || result?.messages?.join('\n\n') || '').replace(/\s+/g, ' ').trim();
  if (answer) return truncate(answer, 160);
  if (result?.error) return truncate(`失败：${String(result.error)}`, 160);
  return '';
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
  session.pendingSessionTitle = null;
  session.pendingForkSourceSessionId = null;
  session.updatedAt = new Date().toISOString();
}

function sanitizeStoredPromptInput(promptInput) {
  if (!promptInput || typeof promptInput !== 'object') return null;
  const text = String(promptInput.text || '');
  const attachments = Array.isArray(promptInput.attachments)
    ? promptInput.attachments
      .map((item) => ({
        content_type: String(item?.content_type || 'unknown'),
        filename: String(item?.filename || 'unnamed-file'),
        url: normalizeAttachmentUrl(item?.url),
        voice_wav_url: normalizeAttachmentUrl(item?.voice_wav_url),
      }))
      .filter((item) => item.url || item.voice_wav_url)
    : [];
  return { text, attachments };
}

function storeLastPromptInput(session, promptInput, preview = '') {
  session.lastPromptInput = sanitizeStoredPromptInput(promptInput);
  session.lastPromptPreview = preview || describePromptInput(promptInput);
  session.lastPromptAt = new Date().toISOString();
}

function normalizeIsoValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

function clearPendingSessionDraft(session) {
  session.pendingSessionTitle = null;
  session.pendingForkSourceSessionId = null;
}

function getSessionHistoryEntry(session, sessionId) {
  return findSessionHistoryItem(session?.sessionHistory || [], sessionId);
}

function rememberSessionIfCurrent(session, sessionId, reason = 'run') {
  const normalized = String(sessionId || '').trim();
  if (!normalized) return;
  if (normalized === String(session.codexThreadId || '').trim()) {
    rememberSessionId(session, normalized, session.lastInputTokens, reason, {});
  }
}

function renameSessionHistoryEntry(session, sessionId, title) {
  const normalizedId = String(sessionId || '').trim();
  if (!normalizedId) return;
  if (normalizedId === String(session.codexThreadId || '').trim()) {
    rememberSessionId(session, normalizedId, session.lastInputTokens, 'rename', {
      title,
      manualTitle: true,
    });
    return;
  }
  session.sessionHistory = renameSessionHistory(session.sessionHistory, normalizedId, title, SESSION_HISTORY_MAX);
}

function pinSessionHistoryEntry(session, sessionId, pinned = true) {
  const normalizedId = String(sessionId || '').trim();
  if (!normalizedId) return;
  if (!getSessionHistoryEntry(session, normalizedId) && normalizedId === String(session.codexThreadId || '').trim()) {
    rememberSessionId(session, normalizedId, session.lastInputTokens, 'pin', {});
  }
  session.sessionHistory = pinSessionHistory(session.sessionHistory, normalizedId, pinned, SESSION_HISTORY_MAX);
}

function getSortedSessionHistory(session) {
  return normalizeSessionHistory(session?.sessionHistory || [], SESSION_HISTORY_MAX);
}

function getSessionHistoryChoices(session) {
  const currentSessionId = String(session?.codexThreadId || '').trim();
  return getSortedSessionHistory(session)
    .filter((item) => item?.id && item.id !== currentSessionId);
}

function resolveSessionReference(session, raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  const numeric = Number.parseInt(trimmed, 10);
  if (String(numeric) === trimmed && numeric >= 1) {
    return getSessionHistoryChoices(session)[numeric - 1]?.id || '';
  }
  return trimmed;
}

function getDefaultSessionTargetId(session) {
  return String(session?.codexThreadId || '').trim() || getSortedSessionHistory(session)[0]?.id || '';
}

function parseSessionTargetWithOptionalText(session, raw, options = {}) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return { targetId: options.fallbackToCurrent ? getDefaultSessionTargetId(session) : '', text: '' };
  }
  const tokens = trimmed.split(/\s+/);
  const knownIds = new Set([
    String(session?.codexThreadId || '').trim(),
    ...getSortedSessionHistory(session).map((item) => item.id),
  ].filter(Boolean));
  const firstTokenTarget = resolveSessionReference(session, tokens[0]);
  if (tokens.length > 1 && knownIds.has(firstTokenTarget)) {
    return {
      targetId: firstTokenTarget,
      text: trimmed.slice(tokens[0].length).trim(),
    };
  }
  return {
    targetId: options.fallbackToCurrent ? String(session?.codexThreadId || '').trim() : '',
    text: trimmed,
  };
}

function parseForkCommandInput(session, raw) {
  const trimmed = String(raw || '').trim();
  const defaultSource = getDefaultSessionTargetId(session);
  if (!trimmed) {
    return {
      sourceSessionId: defaultSource,
      title: '',
    };
  }
  const tokens = trimmed.split(/\s+/);
  const knownIds = new Set([
    String(session?.codexThreadId || '').trim(),
    ...getSortedSessionHistory(session).map((item) => item.id),
  ].filter(Boolean));
  const firstTokenTarget = resolveSessionReference(session, tokens[0]);
  if (tokens.length > 1 && knownIds.has(firstTokenTarget)) {
    return {
      sourceSessionId: firstTokenTarget,
      title: trimmed.slice(tokens[0].length).trim(),
    };
  }
  return {
    sourceSessionId: knownIds.has(firstTokenTarget) ? firstTokenTarget : defaultSource,
    title: knownIds.has(firstTokenTarget) ? trimmed.slice(tokens[0].length).trim() : trimmed,
  };
}

function buildForkSessionTitle(sourceItem, sourceSessionId) {
  const base = String(sourceItem?.title || createAutoSessionTitle(sourceItem?.lastPromptPreview || '', sourceSessionId)).trim();
  return truncate(`${base} · 分支`, 36);
}

function buildForkSummary(session, sourceItem, sourceSessionId) {
  const lines = [
    '这是一个从旧会话分叉出来的新会话，请把它当成独立分支继续。',
    `来源会话：${sourceSessionId}`,
  ];
  if (sourceItem?.title) lines.push(`来源标题：${sourceItem.title}`);
  if (sourceItem?.lastPromptPreview) lines.push(`最近请求：${sourceItem.lastPromptPreview}`);
  if (sourceItem?.lastAnswerPreview) lines.push(`最近结果摘要：${sourceItem.lastAnswerPreview}`);
  if (Number.isFinite(sourceItem?.lastInputTokens)) lines.push(`最近上下文 token：${sourceItem.lastInputTokens}`);
  if (!sourceItem?.lastPromptPreview && session?.lastRun?.latestActivity) {
    lines.push(`最近进展：${session.lastRun.latestActivity}`);
  }
  lines.push('接下来请在新会话里继续完成用户的下一条请求，并延续以上上下文，但不要假设旧会话之后的修改会自动同步过来。');
  return lines.join('\n');
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
      const imageMeta = isImageAttachment(attachment)
        ? detectImageMetadata(absolutePath)
        : { width: null, height: null };
      output.push({
        ...attachment,
        sourceUrl,
        localPath: relativePath,
        isImage: isImageAttachment(attachment),
        imageWidth: imageMeta.width,
        imageHeight: imageMeta.height,
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
  let response = await fetchWithTimeout(sourceUrl, {}, QQ_DOWNLOAD_TIMEOUT_MS);
  if ((response.status === 401 || response.status === 403) && isQqAttachmentUrl(sourceUrl)) {
    const accessToken = await getAccessToken();
    response = await fetchWithTimeout(sourceUrl, {
      headers: {
        Authorization: `QQBot ${accessToken}`,
      },
    }, QQ_DOWNLOAD_TIMEOUT_MS);
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 0) {
  if (!(timeoutMs > 0)) {
    return await fetch(url, options);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`request timeout after ${timeoutMs}ms`);
      timeoutError.code = 'ETIMEDOUT';
      timeoutError.cause = err;
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function extractAttachmentTextPreviews({ attachments, workspaceDir, activeRun }) {
  const notes = [];
  const previews = [];
  const output = [];
  let remainingBudget = MAX_EXTRACTED_TEXT_TOTAL_CHARS;

  for (const attachment of attachments) {
    const next = { ...attachment, extractedText: '', extractedVia: '', extractError: '' };
    if (!attachment.localPath || remainingBudget <= 0) {
      output.push(next);
      continue;
    }

    activeRun.latestActivity = `提取文本：${attachment.filename}`;
    activeRun.updatedAt = Date.now();
    rememberActivity(activeRun, activeRun.latestActivity);

    const absolutePath = path.join(workspaceDir, attachment.localPath);
    const perFileLimit = attachment.isImage ? MAX_IMAGE_OCR_CHARS_PER_FILE : MAX_EXTRACTED_TEXT_CHARS_PER_FILE;
    const limit = Math.min(perFileLimit, remainingBudget);
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

  if (isImageAttachment(attachment)) {
    return extractImageTextPreviewFromFile(absolutePath, attachment, limit);
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
      if (Number.isFinite(attachment.imageWidth) && Number.isFinite(attachment.imageHeight)) {
        parts.push(`dimensions=${attachment.imageWidth}x${attachment.imageHeight}`);
      }
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

function buildHelpMessageForSession(event, session, runtime, variant = 'default') {
  return buildHelpMessage({
    textOnly: shouldPreferTextOnlyHelp(session),
    variant,
    currentSessionId: String(session?.codexThreadId || '').trim(),
    queueLength: Number(runtime?.queue?.length || 0) + (runtime?.activeRun ? 1 : 0),
    hasRetry: Boolean(session?.lastPromptInput),
    quickActionStatus: formatQuickActionCapability(session?.quickActionsCapability, QUICK_ACTION_RETRY_MS),
  });
}

function buildUnknownCommandMessageForSession(session, runtime) {
  return buildUnknownCommandMessage({
    textOnly: shouldPreferTextOnlyHelp(session),
    hasRetry: Boolean(session?.lastPromptInput || runtime?.activeRun),
  });
}

function shouldPreferTextOnlyHelp(session) {
  if (!ENABLE_QUICK_ACTIONS) return true;
  return String(session?.quickActionsCapability?.status || '') === 'unsupported';
}

function buildReplyTextShortcutMenu(event, options = {}) {
  if (options.textShortcutMenu) {
    return options.textShortcutMenu;
  }
  if (!options.uiCategory || !options.quickActions) return null;
  const session = getPeerSession(event.peerKey, event.kind);
  if (!shouldPreferTextOnlyHelp(session)) return null;
  const runtime = getPeerRuntime(event.peerKey);
  return createTextShortcutMenu({
    category: options.uiCategory,
    hasRetry: Boolean(session.lastPromptInput) && !runtime.activeRun,
    hasActiveRun: Boolean(runtime.activeRun),
    ttlMs: TEXT_SHORTCUT_TTL_MS,
  });
}

function buildSessionsShortcutMenu(session) {
  const history = getSessionHistoryChoices(session).slice(0, 6);
  if (history.length === 0) return null;
  return createTextShortcutMenu({
    category: 'sessions',
    items: history.map((item) => ({
      label: truncate(item.title || item.id, 10),
      command: `/resume ${item.id}`,
    })),
    ttlMs: TEXT_SHORTCUT_TTL_MS,
  });
}

function appendTextShortcutHintToReply(text, shortcutMenu) {
  const hint = formatTextShortcutHint(shortcutMenu);
  if (!hint) return text;
  const body = String(text || '').trim();
  return body ? `${body}\n\n${hint}` : hint;
}

function normalizeCommandAlias(command) {
  switch (String(command || '').trim().toLowerCase()) {
    case '/doctor':
      return '/diag';
    case '/ws':
      return '/workspace';
    case '/state':
    case '/health':
      return '/status';
    case '/debug':
      return '/diag';
    case '/git':
      return '/repo';
    case '/changes':
      return '/changed';
    case '/cat':
    case '/view':
      return '/open';
    case '/version':
    case '/ver':
    case '/about':
      return '/version';
    case '/history':
    case '/hist':
      return '/sessions';
    case '/rerun':
    case '/redo':
      return '/retry';
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

function normalizeHelpVariant(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['quick', 'short', 'mini', 'start', 'beginner'].includes(raw)) {
    return 'quick';
  }
  return 'default';
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

function formatJobReasonLabel(reason) {
  switch (String(reason || '').trim()) {
    case 'retry':
      return '重试';
    case 'fork':
      return '分支续写';
    case 'message':
    default:
      return '普通消息';
  }
}

function buildShortcutHint(kind = 'default') {
  switch (String(kind || '').trim()) {
    case 'running':
      return '快捷：`/progress` `/queue` `/status` `/stop`';
    case 'queue':
      return '快捷：`/queue` `/progress` `/status` `/cancel`';
    case 'idle':
      return '快捷：`/status` `/new` `/sessions` `/retry`';
    case 'session':
      return '快捷：`/rename` `/pin` `/fork` `/sessions`';
    case 'repo':
      return '快捷：`/repo` `/workspace` `/diff` `/branch`';
    default:
      return '快捷：`/progress` `/queue` `/status` `/sessions`';
  }
}

function buildOperationalHints(event, session, runtime, options = {}) {
  const hints = [];
  const pendingActions = listPendingActions(runtime.pendingActions);

  if (runtime.activeRun) {
    hints.push('任务进行中：发 `/progress` 看里程碑，必要时用 `/stop`。');
  }
  if (runtime.queue.length > 0) {
    hints.push(`队列里还有 ${runtime.queue.length} 条：发 \`/queue\` 查看，或用 \`/cancel\` 清空。`);
  }
  if (pendingActions.length > 0) {
    hints.push(`有 ${pendingActions.length} 条待确认：发 \`/confirm-action list\` 找回确认菜单。`);
  }
  if (shouldPreferTextOnlyHelp(session)) {
    hints.push('当前会话已走纯文本模式：发 `/help quick` 看更适合 QQ 手打的菜单。');
  }
  if (runtime.textShortcutMenu && shouldPreferTextOnlyHelp(session)) {
    hints.push('当前数字菜单仍有效，可直接回 `1` `2` `3`。');
  }
  if (!runtime.activeRun && runtime.queue.length === 0 && !session.codexThreadId) {
    hints.push('还没绑定当前会话：直接发消息即可开始，或先发 `/new`。');
  }
  if (options.includeGateway && !ws) {
    hints.push('QQ 网关当前离线：服务会自动重连；如持续异常可发 `/diag` 再看。');
  }

  return hints.slice(0, options.maxHints || 4);
}

function getPendingActionChoices(pending) {
  if (pending?.kind === 'rollback') {
    return [
      { label: '确认', value: 'confirm' },
      { label: '看状态', value: 'status' },
      { label: '取消', value: 'cancel' },
    ];
  }
  return [
    { label: '确认', value: 'confirm' },
    { label: '取消', value: 'cancel' },
  ];
}

function formatPendingActionSummary(token, pending) {
  const expiresAt = pending?.expiresAt ? formatIsoTimestamp(pending.expiresAt) : '(no expiry)';
  return `${token} | ${pending?.title || pending?.kind || 'unknown'} | 到期：${expiresAt}`;
}

function formatPendingActionDetailMessage(token, pending) {
  const lines = [
    '⚠️ 待确认操作',
    formatPendingActionSummary(token, pending),
  ];
  for (const item of getPendingActionChoices(pending)) {
    lines.push(`- ${item.label}：\`/confirm-action ${token} ${item.value}\``);
  }
  if (token !== 'latest') {
    lines.push('- 也可直接处理最新一条：`/confirm-action latest confirm`');
  }
  return lines.join('\n');
}

function formatPendingActionsMessage(runtime) {
  const pendingActions = listPendingActions(runtime.pendingActions);
  if (pendingActions.length === 0) {
    return '✅ 当前没有待确认操作。';
  }

  const lines = ['⚠️ 待确认操作'];
  for (const item of pendingActions.slice(0, 4)) {
    lines.push(`- ${formatPendingActionSummary(item.token, item)}`);
    for (const action of getPendingActionChoices(item)) {
      lines.push(`  ${action.label}：\`/confirm-action ${item.token} ${action.value}\``);
    }
  }
  if (pendingActions.length > 4) {
    lines.push(`- 其余 ${pendingActions.length - 4} 条请处理完上面几条后再发 \`/confirm-action list\` 查看。`);
  }
  lines.push('- 快速处理最新一条：`/confirm-action latest confirm`');
  return lines.join('\n');
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
  if (!session.codexThreadId && session.pendingSessionTitle) {
    lines.push(`新会话标题：${session.pendingSessionTitle}`);
  }
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
  if (!session.codexThreadId && session.pendingSessionTitle) {
    lines.push(`新会话标题：${session.pendingSessionTitle}`);
  }
  if (attachmentCount > 0) {
    lines.push(`附件：${attachmentCount} 个`);
  }
  lines.push(buildShortcutHint('queue'));
  return lines.join('\n');
}

function formatStatusMessage(event, session, runtime) {
  const currentSession = session.codexThreadId || '(下一条消息新建)';
  const currentHistory = session.codexThreadId ? getSessionHistoryEntry(session, session.codexThreadId) : null;
  const pinnedCount = getSortedSessionHistory(session).filter((item) => item.pinnedAt).length;
  const pendingActions = listPendingActions(runtime.pendingActions);
  const quickActionStatus = formatQuickActionCapability(session.quickActionsCapability, QUICK_ACTION_RETRY_MS);
  const workspaceDir = getWorkspaceDirForSession(event, session);
  const repoStatus = getRepoStatus(workspaceDir);
  const lines = [
    '📊 当前状态',
    `会话：${currentSession}`,
    `标题：${currentHistory?.title || session.pendingSessionTitle || '(未命名)'}`,
    `工作区：${workspaceDir} | ${formatWorkspaceModeLabel(event.peerKey, workspaceDir)}`,
    `Git：${formatRepoHeadline(repoStatus)}`,
    `profile：${session.profile || 'default'}`,
    `模式：${session.mode} | 模型：${session.model || DEFAULT_MODEL || '(default)'} | effort：${session.effort || DEFAULT_EFFORT || '(default)'}`,
    `排队：${runtime.queue.length} | 运行：${runtime.activeRun ? '处理中' : '空闲'} | 全局并发：${globalRunState.active}${MAX_GLOBAL_ACTIVE_RUNS > 0 ? `/${MAX_GLOBAL_ACTIVE_RUNS}` : ''}`,
    `上下文 token：${session.lastInputTokens ?? 0} | 压缩续聊：${COMPACT_CONTEXT_ON_THRESHOLD ? '开启' : '关闭'}${session.pendingSummary ? '（已准备压缩摘要）' : ''}`,
    `快捷按钮：${quickActionStatus}`,
    `附件：${DOWNLOAD_ATTACHMENTS ? `开启（最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 个，图片输入 ${MAX_IMAGE_ATTACHMENTS} 个）` : '仅 URL'} | 图片 OCR：${IMAGE_OCR_MODE}`,
    `最近文件：${Array.isArray(session.recentFiles) ? session.recentFiles.length : 0} | 历史会话：${Array.isArray(session.sessionHistory) ? session.sessionHistory.length : 0} | 置顶：${pinnedCount}`,
    `待确认操作：${pendingActions.length}`,
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
  const hints = buildOperationalHints(event, session, runtime, { maxHints: 3 });
  if (hints.length > 0) {
    lines.push('建议：');
    for (const hint of hints) {
      lines.push(`- ${hint}`);
    }
    lines.push('');
  }
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
      `任务类型：${formatJobReasonLabel(run.jobReason)}`,
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
      `最近请求：${session.lastRun.promptPreview || session.lastPromptPreview || '(none)'}`,
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

function formatQueueMessage(session, runtime) {
  const lines = ['🧵 队列状态'];
  if (runtime.activeRun) {
    lines.push(`- 运行中：${runtime.activeRun.promptPreview}`);
    lines.push(`  类型：${formatJobReasonLabel(runtime.activeRun.jobReason)} | 已运行：${formatDuration(Date.now() - runtime.activeRun.startedAt)}`);
    lines.push(`  阶段：${formatRunPhaseLabel(runtime.activeRun.phase)} | 最近进展：${runtime.activeRun.latestActivity || '(none)'}`);
  } else {
    lines.push('- 运行中：无');
  }
  if (runtime.queue.length === 0) {
    lines.push('- 排队中：无');
  } else {
    lines.push(`- 排队中：${runtime.queue.length} 个`);
    runtime.queue.slice(0, 6).forEach((job, index) => {
      lines.push(`  ${index + 1}. ${job.label || job.promptPreview}`);
      lines.push(`     等待：${formatDuration(Date.now() - job.enqueuedAt)} | 类型：${formatJobReasonLabel(job.reason)}`);
    });
  }
  lines.push('');
  lines.push(buildShortcutHint(runtime.activeRun || runtime.queue.length > 0 ? 'queue' : 'idle'));
  return lines.join('\n');
}

function getWorkspaceDirForSession(event, session) {
  const workspaceDir = resolveWorkspaceDir(session.workspaceDir || getDefaultWorkspaceDir(event.peerKey));
  session.workspaceDir = workspaceDir;
  ensureWorkspaceGitRepo(workspaceDir);
  return workspaceDir;
}

function getDefaultWorkspaceDir(peerKey) {
  return resolveWorkspaceDir(path.join(WORKSPACE_ROOT, sanitizePeerKey(peerKey)));
}

function getWorkspaceHistoryChoices(event, session) {
  const current = getWorkspaceDirForSession(event, session);
  const history = Array.isArray(session.workspaceHistory) ? session.workspaceHistory : [];
  const deduped = [];
  const seen = new Set();
  for (const dir of [current, ...history.map((item) => item.dir)]) {
    const normalized = resolveWorkspaceDir(dir);
    if (!normalized || seen.has(normalized)) continue;
    deduped.push(normalized);
    seen.add(normalized);
  }
  return deduped.slice(0, WORKSPACE_HISTORY_MAX);
}

function resolveWorkspaceReference(event, session, raw) {
  const trimmed = String(raw || '').trim();
  const numeric = Number.parseInt(trimmed, 10);
  if (String(numeric) === trimmed && numeric >= 1) {
    return getWorkspaceHistoryChoices(event, session)[numeric - 1] || '';
  }
  return trimmed;
}

function formatWorkspaceModeLabel(peerKey, workspaceDir) {
  return workspaceDir === getDefaultWorkspaceDir(peerKey) ? '默认 workspace' : '自定义 workspace';
}

function resolveWorkspaceOverrideInput(rawInput) {
  const input = expandHomePath(String(rawInput || '').trim());
  if (!input) {
    return { ok: false, error: '请提供目标路径。' };
  }

  let targetPath = input;
  let relativeToRoot = false;
  if (!path.isAbsolute(input)) {
    const normalizedRelative = input
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .trim();
    if (!normalizedRelative) {
      return { ok: false, error: '相对路径不能为空。' };
    }
    if (normalizedRelative.split('/').includes('..')) {
      return { ok: false, error: '相对路径不能包含 `..`；如需切到外部目录，请直接使用绝对路径。' };
    }
    targetPath = path.join(WORKSPACE_ROOT, normalizedRelative);
    relativeToRoot = true;
  }

  const workspaceDir = resolveWorkspaceDir(targetPath);
  if (fs.existsSync(workspaceDir) && !fs.statSync(workspaceDir).isDirectory()) {
    return { ok: false, error: '目标路径不是文件夹。' };
  }

  const created = !fs.existsSync(workspaceDir);
  ensureDir(workspaceDir);
  ensureWorkspaceGitRepo(workspaceDir);
  return {
    ok: true,
    workspaceDir,
    created,
    relativeToRoot,
  };
}

function expandHomePath(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function normalizeDiffMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'all') return 'all';
  if (['working', 'worktree', 'unstaged'].includes(raw)) return 'working';
  if (['staged', 'cached'].includes(raw)) return 'staged';
  return '';
}

function normalizeRollbackMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'tracked') return 'tracked';
  if (raw === 'all') return 'all';
  return '';
}

function formatRepoHeadline(repoStatus) {
  if (!repoStatus?.ok) return `不可用（${repoStatus?.error || 'unknown'}）`;
  const pieces = [repoStatus.branch || '(unknown)'];
  if (repoStatus.detached) pieces.push('detached');
  if (repoStatus.unborn) pieces.push('unborn');
  if (repoStatus.upstream) {
    pieces.push(`↔ ${repoStatus.upstream}`);
    if (repoStatus.ahead > 0 || repoStatus.behind > 0) {
      pieces.push(`ahead ${repoStatus.ahead} / behind ${repoStatus.behind}`);
    }
  }
  if (repoStatus.clean) {
    pieces.push('clean');
  } else {
    pieces.push(`改动 ${repoStatus.entries.length}`);
  }
  return pieces.join(' | ');
}

function formatWorkspaceMessage(event, session, options = {}) {
  const workspaceDir = getWorkspaceDirForSession(event, session);
  const defaultWorkspaceDir = getDefaultWorkspaceDir(event.peerKey);
  const repoStatus = getRepoStatus(workspaceDir);
  const lines = ['📁 Workspace'];
  if (options.notice) {
    lines.push(options.notice);
  }
  lines.push(`当前：${workspaceDir}`);
  lines.push(`默认：${defaultWorkspaceDir}`);
  lines.push(`类型：${formatWorkspaceModeLabel(event.peerKey, workspaceDir)}`);
  lines.push(`Git：${formatRepoHeadline(repoStatus)}`);
  lines.push(`WORKSPACE_ROOT：${WORKSPACE_ROOT}`);
  lines.push('');
  lines.push('用法：');
  lines.push('- `/workspace` 查看当前 workspace');
  lines.push('- `/workspace recent` 查看最近 workspace');
  lines.push('- `/workspace set demo` 切到 WORKSPACE_ROOT/demo');
  lines.push('- `/workspace set 2` 切到最近列表里的第 2 个');
  lines.push('- `/workspace set /absolute/path` 切到指定项目目录');
  lines.push('- `/workspace reset` 恢复默认 workspace');
  return lines.join('\n');
}

function formatWorkspaceHistoryMessage(event, session) {
  const current = getWorkspaceDirForSession(event, session);
  const choices = getWorkspaceHistoryChoices(event, session);
  const lines = ['🗂️ 最近 workspace'];
  for (const [index, dir] of choices.entries()) {
    lines.push(`- ${index + 1}. ${dir}${dir === current ? '  ← 当前' : ''}`);
  }
  if (choices.length === 0) {
    lines.push('- 暂无历史 workspace 记录');
  }
  lines.push('');
  lines.push('可直接回数字切换，或用 `/workspace set <编号|路径>`。');
  return lines.join('\n');
}

function buildWorkspaceShortcutMenu(event, session) {
  const choices = getWorkspaceHistoryChoices(event, session).slice(0, 6);
  if (choices.length === 0) return null;
  return createTextShortcutMenu({
    category: 'workspace',
    items: choices.map((dir) => ({
      label: truncate(path.basename(dir) || dir, 10),
      command: `/workspace set ${dir}`,
    })),
    ttlMs: TEXT_SHORTCUT_TTL_MS,
  });
}

function formatRepoStatusMessage(workspaceDir, repoStatus) {
  if (!repoStatus?.ok) {
    return [
      '❌ Git 仓库状态获取失败',
      repoStatus?.error || '(unknown)',
      `工作区：${workspaceDir}`,
    ].join('\n');
  }

  const lines = [
    '🗃️ Workspace 仓库状态',
    `路径：${workspaceDir}`,
    `分支：${repoStatus.branch}${repoStatus.upstream ? ` ↔ ${repoStatus.upstream}` : ''}`,
  ];
  if (repoStatus.ahead > 0 || repoStatus.behind > 0) {
    lines.push(`同步：ahead ${repoStatus.ahead} / behind ${repoStatus.behind}`);
  }
  lines.push(`HEAD：${repoStatus.headShort || '(no commits yet)'}`);
  if (repoStatus.lastCommit) {
    lines.push(`最近提交：${repoStatus.lastCommit.hash} ${repoStatus.lastCommit.subject} @ ${formatIsoTimestamp(repoStatus.lastCommit.committedAt)}`);
  }
  lines.push(`状态：${repoStatus.clean ? 'clean' : `staged ${repoStatus.counts.staged} | unstaged ${repoStatus.counts.unstaged} | untracked ${repoStatus.counts.untracked}`}`);
  if (repoStatus.entries.length > 0) {
    lines.push('');
    lines.push('最近改动：');
    repoStatus.entries.slice(0, 8).forEach((item) => {
      lines.push(`- [${item.code}] ${item.file}`);
    });
  }
  if (repoStatus.initialized || repoStatus.gitignoreUpdated) {
    lines.push('');
    lines.push(`仓库初始化：${repoStatus.initialized ? '本次已自动 init' : '已存在'} | gitignore：${repoStatus.gitignoreUpdated ? '本次已补齐' : 'ok'}`);
  }
  lines.push('');
  lines.push(buildShortcutHint('repo'));
  return lines.join('\n');
}

function formatRepoLogMessage(workspaceDir, repoLog) {
  if (!repoLog?.ok) {
    return [
      '❌ 仓库历史获取失败',
      repoLog?.error || '(unknown)',
      `工作区：${workspaceDir}`,
    ].join('\n');
  }
  if (!repoLog.commits?.length) {
    return [
      '🧾 最近提交',
      `工作区：${workspaceDir}`,
      '当前仓库还没有提交记录。',
    ].join('\n');
  }
  const lines = [
    '🧾 最近提交',
    `工作区：${workspaceDir}`,
  ];
  repoLog.commits.forEach((item) => {
    lines.push(`- ${item.hash} ${item.subject}`);
    lines.push(`  时间：${formatIsoTimestamp(item.committedAt)}`);
  });
  lines.push('');
  lines.push(buildShortcutHint('repo'));
  return lines.join('\n');
}

function formatBranchListMessage(repoStatus) {
  if (!repoStatus?.ok) {
    return [
      '❌ 分支信息获取失败',
      repoStatus?.error || '(unknown)',
    ].join('\n');
  }
  const lines = [
    '🌿 分支列表',
    `当前分支：${repoStatus.branch}`,
  ];
  if (!repoStatus.branches?.length) {
    lines.push('当前仓库还没有可展示的分支。');
  } else {
    repoStatus.branches.slice(0, 10).forEach((item) => {
      lines.push(`- ${item.current ? '* ' : ''}${item.name}`);
    });
  }
  lines.push('');
  lines.push('用 `/branch <name>` 可切换或创建新分支。');
  return lines.join('\n');
}

function formatChangedFilesMessage(workspaceDir, changed) {
  if (!changed?.ok) {
    return [
      '❌ 改动文件获取失败',
      changed?.error || '(unknown)',
      `工作区：${workspaceDir}`,
    ].join('\n');
  }
  const { status, groups } = changed;
  if (status.clean) {
    return [
      '🧾 当前没有改动文件',
      `工作区：${workspaceDir}`,
      `分支：${status.branch}`,
    ].join('\n');
  }
  const lines = [
    '🧾 改动文件',
    `工作区：${workspaceDir}`,
    `分支：${status.branch}`,
    `汇总：staged ${status.counts.staged} | unstaged ${status.counts.unstaged} | untracked ${status.counts.untracked}`,
  ];
  if (groups.staged.length) {
    lines.push('');
    lines.push('Staged:');
    groups.staged.forEach((file) => lines.push(`- ${file}`));
  }
  if (groups.unstaged.length) {
    lines.push('');
    lines.push('Unstaged:');
    groups.unstaged.forEach((file) => lines.push(`- ${file}`));
  }
  if (groups.untracked.length) {
    lines.push('');
    lines.push('Untracked:');
    groups.untracked.forEach((file) => lines.push(`- ${file}`));
  }
  lines.push('');
  lines.push('可继续用：`/patch <文件>` ` /open <文件>` ` /commit <说明>`');
  return lines.join('\n');
}

function formatDiffMessage(workspaceDir, report, mode) {
  if (!report?.ok) {
    return [
      '❌ 差异获取失败',
      report?.error || '(unknown)',
      `工作区：${workspaceDir}`,
    ].join('\n');
  }
  const status = report.status;
  if (status.clean) {
    return [
      '🧩 当前没有改动',
      `工作区：${workspaceDir}`,
      `分支：${status.branch}`,
    ].join('\n');
  }
  const lines = [
    `🧩 Git Diff（${mode}）`,
    `工作区：${workspaceDir}`,
    `分支：${status.branch}`,
  ];
  if (report.stagedStat) {
    lines.push('');
    lines.push('Staged stat:');
    lines.push(report.stagedStat);
  }
  if (report.workingStat) {
    lines.push('');
    lines.push('Working stat:');
    lines.push(report.workingStat);
  }
  if (report.stagedPatch) {
    lines.push('');
    lines.push('Staged preview:');
    lines.push(report.stagedPatch);
  }
  if (report.workingPatch) {
    lines.push('');
    lines.push('Working preview:');
    lines.push(report.workingPatch);
  }
  lines.push('');
  lines.push(buildShortcutHint('repo'));
  return lines.join('\n');
}

function formatPatchMessage(workspaceDir, patch, target = '') {
  if (!patch?.ok) {
    return [
      '❌ Patch 获取失败',
      patch?.error || '(unknown)',
      `工作区：${workspaceDir}`,
    ].join('\n');
  }
  if (patch.noChanges) {
    return [
      '🧩 当前没有可展示的 patch',
      `工作区：${workspaceDir}`,
      ...(target ? [`目标：${target}`] : []),
      '如果是未跟踪文件，可先用 `/open <文件>` 看内容。',
    ].join('\n');
  }
  const lines = [
    `🩹 Patch 预览${patch.relativePath ? `：${patch.relativePath}` : ''}`,
    `工作区：${workspaceDir}`,
    `分支：${patch.status?.branch || '(unknown)'}`,
  ];
  patch.sections.forEach((section) => {
    lines.push('');
    lines.push(`${section.label}:`);
    lines.push(section.content);
  });
  lines.push('');
  lines.push('提示：完整补丁可用 `/export diff` 导出到 workspace。');
  return lines.join('\n');
}

function formatOpenFileMessage(workspaceDir, opened) {
  if (!opened?.ok) {
    return [
      '❌ 打开文件失败',
      opened?.error || '(unknown)',
      `工作区：${workspaceDir}`,
    ].join('\n');
  }
  if (opened.kind === 'directory') {
    return [
      `📁 目录：${opened.relativePath}`,
      `工作区：${workspaceDir}`,
      opened.preview || '(empty directory)',
      ...(opened.truncated ? ['(目录过大，仅显示前 30 项)'] : []),
    ].join('\n');
  }
  if (opened.kind === 'binary') {
    return [
      `📦 二进制文件：${opened.relativePath}`,
      `工作区：${workspaceDir}`,
      `大小：${formatBytes(opened.byteLength)}`,
      `mime：${opened.mimeType || '(unknown)'}`,
      '该文件不是可直接预览的文本内容。',
    ].join('\n');
  }
  return [
    `📄 文件：${opened.relativePath}`,
    `工作区：${workspaceDir}`,
    `大小：${formatBytes(opened.byteLength)}${opened.mimeType ? ` | mime=${opened.mimeType}` : ''}`,
    '',
    opened.preview || '(empty file)',
    ...(opened.truncated ? ['', '(内容过长，仅显示前半部分)'] : []),
  ].join('\n');
}

function formatExportMessage(workspaceDir, exported, mode) {
  if (!exported?.ok) {
    return [
      '❌ 导出失败',
      exported?.error || '(unknown)',
      `工作区：${workspaceDir}`,
    ].join('\n');
  }
  if (exported.noChanges) {
    return [
      '🧾 当前没有可导出的 diff',
      `工作区：${workspaceDir}`,
      `模式：${mode}`,
    ].join('\n');
  }
  return [
    '📦 已导出 diff 文件',
    `工作区：${workspaceDir}`,
    `分支：${exported.status?.branch || '(unknown)'}`,
    `模式：${mode}`,
    `文件：${exported.relativePath}`,
    `大小：${formatBytes(exported.bytes)}`,
    '你可以继续用 `/open .exports/...` 或让 Codex 基于这个 patch 继续处理。',
  ].join('\n');
}

function formatRollbackMessage(workspaceDir, rolledBack, mode) {
  if (!rolledBack?.ok) {
    return [
      '❌ 回退失败',
      rolledBack?.error || '(unknown)',
      `工作区：${workspaceDir}`,
    ].join('\n');
  }
  const status = rolledBack.status;
  const lines = [
    '↩️ 已执行工作区回退',
    `模式：${mode === 'all' ? 'all（含未跟踪文件，保留 .attachments/）' : 'tracked（仅已跟踪改动）'}`,
    `工作区：${workspaceDir}`,
  ];
  if (status?.ok) {
    lines.push(`当前状态：${status.clean ? 'clean' : `staged ${status.counts.staged} | unstaged ${status.counts.unstaged} | untracked ${status.counts.untracked}`}`);
    lines.push(`当前分支：${status.branch}`);
  }
  lines.push('');
  lines.push(buildShortcutHint('repo'));
  return lines.join('\n');
}

function formatDiagnosticsMessage(event) {
  const runtime = getPeerRuntime(event.peerKey);
  const session = getPeerSession(event.peerKey, event.kind);
  const pendingActions = listPendingActions(runtime.pendingActions);
  const uptimeMs = Math.floor(process.uptime() * 1000);
  const heartbeatAge = gatewayRuntime.lastHeartbeatAckAt
    ? formatDuration(Date.now() - gatewayRuntime.lastHeartbeatAckAt)
    : '(none)';
  const lines = [
    '🩺 诊断信息',
    `版本：CodeX-to-QQ v${APP_VERSION} | Node ${process.version}`,
    `Codex CLI：${codexHealth.version} via ${codexHealth.bin}`,
    `peer：${event.peerKey}`,
    `运行时长：${formatDuration(uptimeMs)}`,
    `网关 session：${state.gateway.sessionId || '(none)'}`,
    `最近连上：${formatTimestamp(state.gateway.lastConnectedAt)}`,
    `最近事件：${formatTimestamp(state.gateway.lastEventAt)}`,
    `最近错误：${state.gateway.lastError || '(none)'}`,
    `重连级别：${reconnectIndex}`,
    `当前连接：${ws ? '在线' : '离线'}`,
    `网关模式：${gatewayRuntime.usingResume ? 'resume' : 'identify'} | 心跳：${gatewayRuntime.heartbeatIntervalMs || 0}ms | 最近 ACK：${heartbeatAge}`,
    `最近关闭：${gatewayRuntime.lastCloseCode ?? '(none)'} ${gatewayRuntime.lastCloseReason || ''}`.trim(),
    `会话超时连续次数：${gatewayRuntime.sessionTimeoutStreak} | gateway 要求重连次数：${gatewayRuntime.reconnectRequestedStreak}`,
    `fresh identify 冷却到：${gatewayRuntime.forceFreshIdentifyUntil ? formatIsoTimestamp(new Date(gatewayRuntime.forceFreshIdentifyUntil).toISOString()) : '(off)'}`,
    `当前排队：${runtime.queue.length} | 处理中：${runtime.activeRun ? '是' : '否'}`,
    `待确认操作：${pendingActions.length}`,
    `快捷按钮：${formatQuickActionCapability(session.quickActionsCapability, QUICK_ACTION_RETRY_MS)}`,
    `数字菜单：${runtime.textShortcutMenu ? `已激活（到 ${formatIsoTimestamp(runtime.textShortcutMenu.expiresAt)})` : '未激活'}`,
    `图片 OCR：${IMAGE_OCR_MODE} | 后端：${resolveImageOcrBackend() || '(none)'}`,
    `QQ API timeout：${QQ_API_TIMEOUT_MS > 0 ? `${QQ_API_TIMEOUT_MS}ms` : 'off'} | 下载 timeout：${QQ_DOWNLOAD_TIMEOUT_MS > 0 ? `${QQ_DOWNLOAD_TIMEOUT_MS}ms` : 'off'}`,
    `收消息：${state.telemetry.inboundMessages} | 发消息：${state.telemetry.outboundMessages} | 发送失败：${state.telemetry.outboundFailures}`,
    `完成：${state.telemetry.completedRuns} | 失败：${state.telemetry.failedRuns} | 取消：${state.telemetry.cancelledRuns} | 撤回：${state.telemetry.retracts}`,
  ];
  const hints = buildOperationalHints(event, session, runtime, { includeGateway: true, maxHints: 4 });
  if (hints.length > 0) {
    lines.push('');
    lines.push('建议：');
    for (const hint of hints) {
      lines.push(`- ${hint}`);
    }
  }
  return lines.join('\n');
}

function formatVersionMessage() {
  return [
    '🧾 版本信息',
    `CodeX-to-QQ：v${APP_VERSION}`,
    `Node.js：${process.version}`,
    `Codex CLI：${codexHealth.version} via ${codexHealth.bin}`,
    `平台：${process.platform} ${process.arch}`,
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

function rememberSessionId(session, sessionId, lastInputTokens = null, reason = 'run', updates = {}) {
  const normalized = String(sessionId || '').trim();
  if (!normalized) return;
  session.sessionHistory = upsertSessionHistory(session.sessionHistory, normalized, {
    lastUsedAt: new Date().toISOString(),
    lastInputTokens: Number.isFinite(lastInputTokens) ? lastInputTokens : null,
    reason,
    ...updates,
  }, SESSION_HISTORY_MAX);
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
  const currentHistory = session.codexThreadId ? getSessionHistoryEntry(session, session.codexThreadId) : null;
  return [
    '🧠 当前会话',
    `当前 session：${session.codexThreadId || '(下一条消息新建)'}`,
    `标题：${currentHistory?.title || session.pendingSessionTitle || '(未命名)'}`,
    `置顶：${currentHistory?.pinnedAt ? '是' : '否'}`,
    `工作区：${session.workspaceDir}`,
    `上下文 token：${session.lastInputTokens ?? 0}`,
    `profile：${session.profile || 'default'}`,
    `模式：${session.mode} | 模型：${session.model || DEFAULT_MODEL || '(default)'} | effort：${session.effort || DEFAULT_EFFORT || '(default)'}`,
    session.pendingSummary ? `压缩摘要：已准备（来源 ${session.pendingSummarySourceSessionId || 'unknown'}）` : '压缩摘要：无',
    '',
    '操作建议：',
    '- `/rename <标题>` 改当前会话标题',
    '- `/pin` 置顶当前会话',
    '- `/fork [新标题]` 开一个分支会话',
    '- `/new` 开新会话',
    '- `/sessions` 查看历史会话',
    '- `/resume <id>` 切回旧会话',
    '',
    buildShortcutHint('session'),
  ].join('\n');
}

function formatSessionHistoryMessage(session) {
  const currentSessionId = String(session.codexThreadId || '').trim();
  const history = getSessionHistoryChoices(session);
  const lines = ['🗂️ 最近会话'];
  if (currentSessionId) {
    const currentItem = getSessionHistoryEntry(session, currentSessionId);
    lines.push(`- 当前：${currentSessionId}${session.lastInputTokens ? ` (tokens=${session.lastInputTokens})` : ''}`);
    if (currentItem?.title) lines.push(`  标题：${currentItem.title}${currentItem.pinnedAt ? ' | 📌 已置顶' : ''}`);
  }
  if (history.length === 0) {
    lines.push(currentSessionId ? '- 暂无其他历史会话记录' : '- 暂无历史会话记录');
    lines.push('');
    lines.push('先发普通消息开始会话，之后可用 `/new` 切到新会话。');
    return lines.join('\n');
  }
  for (const [index, item] of history.slice(0, 8).entries()) {
    lines.push(`- ${index + 1}. ${item.pinnedAt ? '📌 ' : ''}${item.id}`);
    lines.push(`  标题：${item.title}`);
    lines.push(`  最近使用：${formatIsoTimestamp(item.lastUsedAt)} | 来源：${item.reason || 'run'}${item.lastInputTokens ? ` | tokens=${item.lastInputTokens}` : ''}${item.parentSessionId ? ` | parent=${item.parentSessionId}` : ''}`);
    if (item.lastPromptPreview) lines.push(`  最近请求：${item.lastPromptPreview}`);
    if (item.lastAnswerPreview) lines.push(`  最近结果：${truncate(item.lastAnswerPreview, 120)}`);
  }
  lines.push('');
  lines.push('可直接回数字切回会话，也可以用 `/resume <编号|id>`、`/pin <编号|id>`、`/fork <编号|id>`。');
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

function normalizeWorkspaceHistoryEntry(value) {
  if (!value || typeof value !== 'object') return null;
  const dir = String(value.dir || '').trim();
  if (!dir) return null;
  return {
    dir: resolveWorkspaceDir(dir),
    usedAt: normalizeIsoValue(value.usedAt) || new Date().toISOString(),
  };
}

function rememberWorkspaceHistory(session, workspaceDir) {
  if (!Array.isArray(session.workspaceHistory)) {
    session.workspaceHistory = [];
  }
  const normalized = normalizeWorkspaceHistoryEntry({ dir: workspaceDir, usedAt: new Date().toISOString() });
  if (!normalized) return;
  const deduped = session.workspaceHistory
    .map((item) => normalizeWorkspaceHistoryEntry(item))
    .filter(Boolean)
    .filter((item) => item.dir !== normalized.dir);
  session.workspaceHistory = [normalized, ...deduped].slice(0, WORKSPACE_HISTORY_MAX);
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

function extractImageTextPreviewFromFile(absolutePath, attachment, limit) {
  if (IMAGE_OCR_MODE === 'off') {
    return { text: '', via: '', error: 'image ocr disabled', note: '图片 OCR 已关闭' };
  }

  if (!shouldAttemptImageOcr({
    mode: IMAGE_OCR_MODE,
    attachment,
  })) {
    return { text: '', via: '', error: '', note: '' };
  }

  const backend = resolveImageOcrBackend();
  if (!backend) {
    return { text: '', via: '', error: 'image ocr unavailable', note: '当前环境没有可用的图片 OCR 后端' };
  }

  const raw = backend === 'vision'
    ? runExtractorToStdout('/usr/bin/swift', [path.join(ROOT, 'scripts', 'ocr-image.swift'), absolutePath])
    : runExtractorToStdout('tesseract', [absolutePath, 'stdout']);
  const text = sanitizeExtractedText(raw.stdout, limit);
  if (text) {
    return { text, via: backend, error: '' };
  }
  return {
    text: '',
    via: '',
    error: raw.error || 'image ocr failed',
    note: raw.error || '图片 OCR 未识别到可用文字',
  };
}

function resolveImageOcrBackend() {
  if (cachedImageOcrBackend !== undefined) return cachedImageOcrBackend;
  if (IMAGE_OCR_MODE === 'off') {
    cachedImageOcrBackend = '';
    return cachedImageOcrBackend;
  }

  const visionScript = path.join(ROOT, 'scripts', 'ocr-image.swift');
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/swift') && fs.existsSync(visionScript)) {
    cachedImageOcrBackend = 'vision';
    return cachedImageOcrBackend;
  }

  if (binaryExists('tesseract', ['--version'])) {
    cachedImageOcrBackend = 'tesseract';
    return cachedImageOcrBackend;
  }

  cachedImageOcrBackend = IMAGE_OCR_MODE === 'on' ? '' : '';
  return cachedImageOcrBackend;
}

function detectImageMetadata(absolutePath) {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sips')) {
    return { width: null, height: null };
  }
  const result = spawnSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', absolutePath], {
    env: buildSpawnEnv(process.env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    return { width: null, height: null };
  }
  const output = String(result.stdout || '');
  const widthMatch = output.match(/pixelWidth:\s*(\d+)/);
  const heightMatch = output.match(/pixelHeight:\s*(\d+)/);
  return {
    width: widthMatch ? Number.parseInt(widthMatch[1], 10) : null,
    height: heightMatch ? Number.parseInt(heightMatch[1], 10) : null,
  };
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
    if (isGatewayHeartbeatOverdue(gatewayRuntime, Date.now(), GATEWAY_HEARTBEAT_ACK_GRACE_MS)) {
      console.warn('⚠️ QQ heartbeat ack overdue; reconnecting gateway');
      requestGatewayReconnect('heartbeat ack overdue', resolveGatewayReconnectDelay({
        code: 4009,
        reconnectIndex,
        sessionTimeoutStreak: Math.max(1, gatewayRuntime.sessionTimeoutStreak),
        defaultDelays: RECONNECT_DELAYS,
      }));
      return;
    }
    if (socket.readyState === WebSocket.OPEN) {
      try {
        noteGatewayHeartbeatSent(gatewayRuntime, Date.now());
        socket.send(JSON.stringify({ op: 1, d: state.gateway.lastSeq }));
      } catch (err) {
        console.error('QQ heartbeat failed:', safeError(err));
        requestGatewayReconnect('heartbeat failed', resolveGatewayReconnectDelay({
          code: 4009,
          reconnectIndex,
          sessionTimeoutStreak: Math.max(1, gatewayRuntime.sessionTimeoutStreak),
          defaultDelays: RECONNECT_DELAYS,
        }));
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

function binaryExists(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    env: buildSpawnEnv(process.env),
    stdio: 'ignore',
    timeout: 5000,
  });
  return !result.error;
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

function readPackageVersion() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return String(parsed?.version || '').trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
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
  const expectedWorkspace = getDefaultWorkspaceDir(peerKey);

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
  if (session.lastPromptInput === undefined) {
    session.lastPromptInput = null;
    dirty = true;
  } else if (session.lastPromptInput !== null) {
    const normalized = sanitizeStoredPromptInput(session.lastPromptInput);
    if (JSON.stringify(normalized) !== JSON.stringify(session.lastPromptInput)) {
      session.lastPromptInput = normalized;
      dirty = true;
    }
  }
  if (session.lastPromptPreview === undefined) {
    session.lastPromptPreview = null;
    dirty = true;
  } else if (session.lastPromptPreview !== null) {
    const normalized = String(session.lastPromptPreview || '').replace(/\s+/g, ' ').trim() || null;
    if (normalized !== session.lastPromptPreview) {
      session.lastPromptPreview = normalized;
      dirty = true;
    }
  }
  if (session.lastPromptAt === undefined) {
    session.lastPromptAt = null;
    dirty = true;
  } else if (session.lastPromptAt !== null) {
    const normalized = normalizeIsoValue(session.lastPromptAt);
    if (normalized !== session.lastPromptAt) {
      session.lastPromptAt = normalized;
      dirty = true;
    }
  }
  if (!Array.isArray(session.recentFiles)) {
    session.recentFiles = [];
    dirty = true;
  } else if (session.recentFiles.length > RECENT_FILES_MAX) {
    session.recentFiles = session.recentFiles.slice(0, RECENT_FILES_MAX);
    dirty = true;
  }
  if (!Array.isArray(session.workspaceHistory)) {
    session.workspaceHistory = [];
    dirty = true;
  } else if (session.workspaceHistory.length > WORKSPACE_HISTORY_MAX) {
    session.workspaceHistory = session.workspaceHistory.slice(0, WORKSPACE_HISTORY_MAX);
    dirty = true;
  } else {
    const normalized = session.workspaceHistory
      .map((item) => normalizeWorkspaceHistoryEntry(item))
      .filter(Boolean);
    if (JSON.stringify(normalized) !== JSON.stringify(session.workspaceHistory)) {
      session.workspaceHistory = normalized;
      dirty = true;
    }
  }
  if (!Array.isArray(session.sessionHistory)) {
    session.sessionHistory = [];
    dirty = true;
  } else {
    const normalized = normalizeSessionHistory(session.sessionHistory, SESSION_HISTORY_MAX);
    if (JSON.stringify(normalized) !== JSON.stringify(session.sessionHistory)) {
      session.sessionHistory = normalized;
      dirty = true;
    }
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
  if (session.pendingSessionTitle === undefined) {
    session.pendingSessionTitle = null;
    dirty = true;
  } else if (session.pendingSessionTitle !== null) {
    const normalized = String(session.pendingSessionTitle || '').replace(/\s+/g, ' ').trim() || null;
    if (normalized !== session.pendingSessionTitle) {
      session.pendingSessionTitle = normalized;
      dirty = true;
    }
  }
  if (session.pendingForkSourceSessionId === undefined) {
    session.pendingForkSourceSessionId = null;
    dirty = true;
  } else if (session.pendingForkSourceSessionId !== null) {
    const normalized = String(session.pendingForkSourceSessionId || '').trim() || null;
    if (normalized !== session.pendingForkSourceSessionId) {
      session.pendingForkSourceSessionId = normalized;
      dirty = true;
    }
  }
  const normalizedQuickActions = normalizeQuickActionCapability(session.quickActionsCapability);
  if (JSON.stringify(normalizedQuickActions) !== JSON.stringify(session.quickActionsCapability || null)) {
    session.quickActionsCapability = normalizedQuickActions;
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
  const numeric = Number(ms);
  const total = Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric / 1000)) : 0;
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
