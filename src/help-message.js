export function buildHelpMessage(options = {}) {
  const {
    textOnly = false,
    variant = 'default',
    currentSessionId = '',
    queueLength = 0,
    hasRetry = false,
    quickActionStatus = '',
  } = options;

  if (String(variant || '').trim() === 'quick') {
    return buildQuickStartHelp({
      textOnly,
      currentSessionId,
      queueLength,
      hasRetry,
      quickActionStatus,
    });
  }

  return textOnly
    ? buildTextOnlyHelp({
      currentSessionId,
      queueLength,
      hasRetry,
      quickActionStatus,
    })
    : buildDefaultHelp({
      currentSessionId,
      queueLength,
      hasRetry,
      quickActionStatus,
    });
}

export function buildUnknownCommandMessage(options = {}) {
  const { textOnly = false, hasRetry = false } = options;
  if (!textOnly) {
    return '未知命令，发 `/help quick` 看上手菜单，或发 `/help` 看完整命令。';
  }
  return [
    '未知命令。',
    `试试这些：\`/help quick\` \`/status\` \`/new\` \`${hasRetry ? '/retry' : '/sessions'}\``,
  ].join('\n');
}

function buildQuickStartHelp({ textOnly, currentSessionId, queueLength, hasRetry, quickActionStatus }) {
  const lines = [
    textOnly ? '🚀 QQ 快速上手' : '🚀 快速上手',
    '1. 直接发普通消息 = 交给 Codex',
    '2. 发 `/new` 开新会话',
    '3. 发 `/status` 看当前状态',
    '4. 发 `/sessions` 或 `/workspace recent` 管理上下文',
  ];
  if (quickActionStatus) {
    lines.push(textOnly ? `当前按钮模式：${quickActionStatus}` : `快捷按钮：${quickActionStatus}`);
  }
  if (currentSessionId || queueLength > 0) {
    lines.push(`当前上下文：session=${currentSessionId || '(下一条消息新建)'} | queue=${queueLength}`);
  }
  lines.push('');
  lines.push('常用场景：');
  lines.push(`- 继续刚才的话题：直接发消息${hasRetry ? '，或 `/retry` 重跑上一条' : ''}`);
  lines.push('- 切回旧任务：`/sessions` 后回数字，或 `/resume <编号|id>`');
  lines.push('- 切项目目录：`/workspace recent` 后回数字，或 `/workspace set demo`');
  lines.push('- 看代码改动：`/changed`、`/diff`、`/open <文件>`');
  lines.push('- 高风险操作会先二次确认，比如 `/rollback all`；忘了提示可用 `/confirm-action list` 找回');
  lines.push('');
  lines.push('再看完整命令：`/help`');
  return lines.join('\n');
}

function buildTextOnlyHelp({ currentSessionId, queueLength, hasRetry, quickActionStatus }) {
  const lines = [
    '⌨️ QQ 手打菜单',
    '直接发普通消息 = 交给 Codex 处理',
    '当前会话不显示快捷按钮，请直接输入命令。',
  ];
  if (quickActionStatus) {
    lines.push(`按钮状态：${quickActionStatus}`);
  }
  if (currentSessionId) {
    lines.push(`当前 session：${currentSessionId}`);
  }
  if (queueLength > 0) {
    lines.push(`当前队列：${queueLength} 个`);
  }
  lines.push('');
  lines.push('先用这些：');
  lines.push(`/new  /status  /queue  /progress${hasRetry ? '  /retry' : ''}`);
  lines.push('可直接回数字执行菜单项（如 `1` `2` `3`）');
  lines.push('');
  lines.push('会话：');
  lines.push('/sessions  /resume <id>  /rename <标题>  /pin  /fork [id] [标题]');
  lines.push('');
  lines.push('仓库：');
  lines.push('/workspace  /workspace recent  /repo  /changed');
  lines.push('/patch [文件]  /open <文件>');
  lines.push('/branch <name>  /diff  /commit <说明>  /rollback  /export diff');
  lines.push('');
  lines.push('其他：');
  lines.push('/files  /diag  /doctor  /version  /confirm-action list');
  lines.push('/mode safe|dangerous  /profile default|code|docs|review|image');
  return lines.join('\n');
}

function buildDefaultHelp({ currentSessionId, queueLength, hasRetry, quickActionStatus }) {
  const lines = [
    '可用命令',
    '直接发送普通消息 = 交给 Codex 处理',
    '群聊里需要 @ 机器人 才会触发',
    '私聊可用 `/new` 主动开启新会话，旧会话可用 `/sessions` + `/resume <id>` 继续',
    '可用 `/rename` `/pin` `/fork` 管理会话资产，用 `/queue` `/retry` 看运行控制',
    'workspace 自带 Git 仓库，可用 `/repo` `/branch` `/diff` `/commit` `/rollback` 做轻量工作流',
    '图片会尽量作为图片输入直接交给 Codex，其他附件会下载到当前 workspace 后再引用',
    '长上下文会在阈值处自动压缩续聊，长回复会自动按代码块安全分片',
  ];
  if (quickActionStatus) {
    lines.push(`快捷按钮：${quickActionStatus}`);
  }
  if (currentSessionId || queueLength > 0) {
    lines.push(`当前上下文：session=${currentSessionId || '(下一条消息新建)'} | queue=${queueLength}`);
  }
  lines.push(
    '',
    '/help',
    '/whoami',
    '/status',
    '/state',
    '/diag',
    '/version',
    '/stats',
    '/audit',
    '/session',
    '/sessions',
    '/rename <新标题>',
    '/pin [session_id|clear]',
    '/fork [source_session_id] [新标题]',
    '/history',
    '/new',
    '/start',
    '/files',
    '/workspace [show|recent|set <path|index>|reset]',
    '/repo [status|log|path]',
    '/changed',
    '/patch [file]',
    '/open <file>',
    '/branch [name]',
    '/diff [working|staged|all]',
    '/commit <message>',
    '/rollback [tracked|all]',
    '/export diff [working|staged|all]',
    '/progress',
    '/queue',
    '/cancel',
    '/stop',
    ...(hasRetry ? ['/retry'] : []),
    '/reset',
    '/resume <session_id|clear>',
    '/confirm-action list',
    '/profile default|code|docs|review|image',
    '/mode safe|dangerous',
    '/model <name|default>',
    '/effort low|medium|high|default',
  );
  return lines.join('\n');
}
