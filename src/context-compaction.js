export function shouldCompactByTokens({ enabled, sessionId, lastInputTokens, threshold }) {
  if (!enabled) return false;
  if (!sessionId) return false;
  if (!Number.isFinite(lastInputTokens)) return false;
  return lastInputTokens >= threshold;
}

export function buildCompactRequestPrompt({ maxChars = 1200 } = {}) {
  return [
    '请压缩总结当前会话上下文，供新会话继续工作使用。',
    '输出要求：',
    `1) 用中文，结构化分段，控制在 ${maxChars} 字以内。`,
    '2) 包含：目标、已完成工作、关键代码/文件、未完成事项、风险与约束、下一步建议。',
    '3) 只输出摘要正文，不要寒暄，不要代码块。',
  ].join('\n');
}

export function buildPromptFromCompactedContext(summary, userPrompt) {
  return [
    '下面是上一轮会话的压缩摘要，请先把它作为上下文再回答新的用户请求。',
    '',
    '【压缩摘要开始】',
    String(summary || '').trim(),
    '【压缩摘要结束】',
    '',
    '请在不丢失关键上下文的前提下继续处理以下新请求：',
    String(userPrompt || '').trim(),
  ].join('\n');
}
