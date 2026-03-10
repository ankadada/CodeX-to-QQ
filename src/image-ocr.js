export function normalizeImageOcrMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'off' || raw === 'false' || raw === '0') return 'off';
  if (raw === 'on' || raw === 'true' || raw === '1') return 'on';
  return 'auto';
}

export function shouldAttemptImageOcr(options = {}) {
  const mode = normalizeImageOcrMode(options.mode || 'auto');
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return isLikelyScreenshotImage(options.attachment);
}

export function isLikelyScreenshotImage(attachment = {}) {
  const filename = String(attachment.filename || '').toLowerCase();
  const contentType = String(attachment.content_type || attachment.contentType || '').toLowerCase();
  const width = normalizeNumber(attachment.imageWidth ?? attachment.width);
  const height = normalizeNumber(attachment.imageHeight ?? attachment.height);
  const ratio = width && height ? width / height : 0;
  const ext = filename.split('.').pop() || '';

  if (containsScreenshotKeyword(filename)) return true;

  const isLosslessUiImage = ['png', 'webp'].includes(ext)
    || contentType === 'image/png'
    || contentType === 'image/webp';
  if (isLosslessUiImage && width >= 1000 && height >= 600 && ratio >= 1.1 && ratio <= 2.4) {
    return true;
  }

  if ((contentType === 'image/jpeg' || ext === 'jpg' || ext === 'jpeg') && width >= 1200 && height >= 700) {
    return containsScreenshotKeyword(filename);
  }

  return false;
}

function containsScreenshotKeyword(filename) {
  return [
    'screenshot',
    'screen-shot',
    'screen_shot',
    'screen shot',
    'screencapture',
    'screen_capture',
    '截屏',
    '截图',
    '捕获',
    'snip',
    'capture',
  ].some((keyword) => filename.includes(keyword));
}

function normalizeNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric);
}
