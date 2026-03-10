export function buildDoctorSuggestions(checks = [], context = {}) {
  const status = new Map(
    (Array.isArray(checks) ? checks : []).map((item) => [String(item?.name || '').trim(), Boolean(item?.ok)]),
  );
  const suggestions = [];

  const has = (name) => status.get(name) !== false;
  const add = (message) => {
    const text = String(message || '').trim();
    if (text && !suggestions.includes(text)) {
      suggestions.push(text);
    }
  };

  if (!has('.env file')) {
    add('复制 `.env.example` 为 `.env`，再填写你的 QQ bot 配置。');
  }

  if (!has('.env / QQBOT_APP_ID') || !has('.env / QQBOT_CLIENT_SECRET')) {
    add('检查 `.env` 里的 `QQBOT_APP_ID` 和 `QQBOT_CLIENT_SECRET`，保存后重新执行 `npm run doctor`。');
  }

  if (!has('Codex CLI binary')) {
    add('安装 Codex CLI，或把 `CODEX_BIN` 指向可执行文件的绝对路径。');
  }

  if (!has('Git binary')) {
    add('安装 Git 并确保它在 `PATH` 中可用。');
  }

  if (!has('Workspace root') || !has('Data dir') || !has('Log dir')) {
    add('确认项目目录和 `WORKSPACE_ROOT` 可读可写，必要时把 workspace 指到你有权限的目录。');
  }

  if (!has('Service integration')) {
    if (context.platform === 'darwin') {
      add('如果要后台常驻，执行 `npm run install:launchd`，然后用 `npm run service:status:launchd` 检查状态。');
    } else if (context.platform === 'linux') {
      add('如果要后台常驻，执行 `npm run install:systemd`，然后用 `npm run service:status:systemd` 检查状态。');
    }
  }

  if (!has('Image OCR backend') && context.imageOcrMode !== 'off') {
    add('图片 OCR 需要 macOS Vision (`/usr/bin/swift`) 或 `tesseract`；若暂时不用，可设 `IMAGE_OCR_MODE=off`。');
  }

  if (!has('QQ access token') || !has('QQ API') || !has('QQ gateway API')) {
    add('检查 QQ bot 凭证、机器人状态，以及主机到 `bots.qq.com` 和 `api.sgroup.qq.com` 的网络连通性。');
  }

  if (suggestions.length === 0 && checks.some((item) => item && item.ok === false)) {
    add('优先查看失败项详情，再结合 `README` 和 `docs/TROUBLESHOOTING*.md` 排查。');
  }

  return suggestions;
}
