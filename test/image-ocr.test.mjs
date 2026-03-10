import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLikelyScreenshotImage,
  normalizeImageOcrMode,
  shouldAttemptImageOcr,
} from '../src/image-ocr.js';

test('normalizeImageOcrMode maps common toggles', () => {
  assert.equal(normalizeImageOcrMode('on'), 'on');
  assert.equal(normalizeImageOcrMode('false'), 'off');
  assert.equal(normalizeImageOcrMode('something-else'), 'auto');
});

test('isLikelyScreenshotImage detects screenshot-like pngs', () => {
  assert.equal(isLikelyScreenshotImage({
    filename: 'Screenshot 2026-03-10 at 10.00.00.png',
    content_type: 'image/png',
    imageWidth: 1440,
    imageHeight: 900,
  }), true);

  assert.equal(isLikelyScreenshotImage({
    filename: 'photo.jpg',
    content_type: 'image/jpeg',
    imageWidth: 3024,
    imageHeight: 4032,
  }), false);
});

test('shouldAttemptImageOcr keeps auto mode screenshot-friendly', () => {
  assert.equal(shouldAttemptImageOcr({
    mode: 'auto',
    attachment: {
      filename: 'capture.png',
      content_type: 'image/png',
      imageWidth: 1280,
      imageHeight: 720,
    },
  }), true);

  assert.equal(shouldAttemptImageOcr({
    mode: 'auto',
    attachment: {
      filename: 'vacation.jpeg',
      content_type: 'image/jpeg',
      imageWidth: 4032,
      imageHeight: 3024,
    },
  }), false);
});
