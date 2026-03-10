import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDoctorSuggestions } from '../src/doctor-report.js';

test('buildDoctorSuggestions recommends env and QQ credential fixes', () => {
  const suggestions = buildDoctorSuggestions([
    { name: '.env file', ok: false },
    { name: '.env / QQBOT_APP_ID', ok: false },
    { name: '.env / QQBOT_CLIENT_SECRET', ok: false },
  ], { platform: 'darwin', imageOcrMode: 'auto' });

  assert.match(suggestions.join('\n'), /\.env\.example/);
  assert.match(suggestions.join('\n'), /QQBOT_APP_ID/);
});

test('buildDoctorSuggestions recommends platform-specific service hint', () => {
  const mac = buildDoctorSuggestions([
    { name: 'Service integration', ok: false },
  ], { platform: 'darwin', imageOcrMode: 'auto' });
  const linux = buildDoctorSuggestions([
    { name: 'Service integration', ok: false },
  ], { platform: 'linux', imageOcrMode: 'auto' });

  assert.match(mac.join('\n'), /install:launchd/);
  assert.match(linux.join('\n'), /install:systemd/);
});

test('buildDoctorSuggestions recommends OCR fallback only when OCR enabled', () => {
  const enabled = buildDoctorSuggestions([
    { name: 'Image OCR backend', ok: false },
  ], { platform: 'darwin', imageOcrMode: 'auto' });
  const disabled = buildDoctorSuggestions([
    { name: 'Image OCR backend', ok: false },
  ], { platform: 'darwin', imageOcrMode: 'off' });

  assert.match(enabled.join('\n'), /IMAGE_OCR_MODE=off/);
  assert.equal(disabled.some((line) => line.includes('IMAGE_OCR_MODE=off')), false);
});

test('buildDoctorSuggestions deduplicates overlapping QQ connectivity hints', () => {
  const suggestions = buildDoctorSuggestions([
    { name: 'QQ access token', ok: false },
    { name: 'QQ API', ok: false },
    { name: 'QQ gateway API', ok: false },
  ], { platform: 'darwin', imageOcrMode: 'auto' });

  assert.equal(suggestions.filter((line) => line.includes('bots.qq.com')).length, 1);
});
