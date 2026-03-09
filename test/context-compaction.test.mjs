import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompactRequestPrompt,
  buildPromptFromCompactedContext,
  shouldCompactByTokens,
} from '../src/context-compaction.js';

test('shouldCompactByTokens requires all compact conditions', () => {
  assert.equal(shouldCompactByTokens({
    enabled: true,
    sessionId: 'abc',
    lastInputTokens: 300000,
    threshold: 250000,
  }), true);
  assert.equal(shouldCompactByTokens({
    enabled: false,
    sessionId: 'abc',
    lastInputTokens: 300000,
    threshold: 250000,
  }), false);
});

test('buildCompactRequestPrompt includes structured instructions', () => {
  const prompt = buildCompactRequestPrompt({ maxChars: 900 });
  assert.match(prompt, /900 字以内/);
  assert.match(prompt, /关键代码\/文件/);
});

test('buildPromptFromCompactedContext embeds summary and user prompt', () => {
  const output = buildPromptFromCompactedContext('摘要内容', '继续修复 bug');
  assert.match(output, /摘要内容/);
  assert.match(output, /继续修复 bug/);
  assert.match(output, /压缩摘要开始/);
});
