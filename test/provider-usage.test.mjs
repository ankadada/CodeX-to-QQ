import test from 'node:test';
import assert from 'node:assert/strict';
import { extractInputTokensFromUsage } from '../src/provider-usage.js';

test('extractInputTokensFromUsage reads direct input token fields', () => {
  assert.equal(extractInputTokensFromUsage({ input_tokens: 321 }), 321);
  assert.equal(extractInputTokensFromUsage({ promptTokens: 654 }), 654);
});

test('extractInputTokensFromUsage finds nested input token fields', () => {
  assert.equal(extractInputTokensFromUsage({
    usage: {
      totals: {
        prompt_token_count: 987,
      },
    },
  }), 987);
});

test('extractInputTokensFromUsage ignores unrelated numeric fields', () => {
  assert.equal(extractInputTokensFromUsage({
    output_tokens: 111,
    nested: {
      cache_write_tokens: 222,
    },
  }), null);
});
