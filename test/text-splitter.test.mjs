import test from 'node:test';
import assert from 'node:assert/strict';
import { splitForChat } from '../src/text-splitter.js';

test('splitForChat keeps short text intact', () => {
  const text = 'hello\nworld';
  assert.deepEqual(splitForChat(text, 100), ['hello\nworld']);
});

test('splitForChat keeps code fences balanced across chunks', () => {
  const text = [
    '前言',
    '```js',
    'const a = 1;',
    'const b = 2;',
    'console.log(a + b);',
    '```',
    '结尾'.repeat(60),
  ].join('\n');

  const parts = splitForChat(text, 120);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.length <= 120);
    const fences = part.match(/```/g) || [];
    assert.equal(fences.length % 2, 0);
  }
});
