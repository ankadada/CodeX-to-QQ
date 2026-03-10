# 故障排查

这份文档主要解决“已经能连上，但体验还不够顺”时最常见的问题。

## 提 issue 之前建议先收集

```bash
npm run doctor
npm run doctor:json
npm run service:status
```

如果 QQ 里还能正常回复，也建议再收集：

- `/status`
- `/diag`

公开发 issue 前请先打码：密钥、私聊内容、敏感路径、用户标识。

## 机器人完全不回复

先看这几项：

1. `npm run doctor`
2. `.env` 里是否填了 `QQBOT_APP_ID` 和 `QQBOT_CLIENT_SECRET`
3. doctor 里的 `Codex CLI binary` 是否通过
4. 如果你是后台服务运行，`npm run service:status` 是否显示正常

如果 doctor 卡在 QQ API：

- 检查 bot 凭证是否正确
- 检查机器人在 QQ 平台侧是否正常启用
- 检查主机能否访问 `https://bots.qq.com` 和 `https://api.sgroup.qq.com`

## 某些聊天能回复，某些不能

常见原因：

- 当前发送者不在 `QQBOT_ALLOW_FROM`
- 当前群不在 `QQBOT_ALLOW_GROUPS`
- `QQBOT_ENABLE_GROUP=false`
- 群聊里没有 `@bot`

可以在对应聊天里发 `/whoami` 看当前 peer 标识。

## QQ 按钮不显示，或者只显示一部分

这在部分 QQ 客户端上是正常现象。

项目已经做了兜底：

- QQ 不支持自定义键盘时会自动降级为纯文本
- 可直接发 `/help quick`
- 可直接回复数字快捷项，例如 `1`、`2`、`3`

如果只是 QQ 自定义键盘限制触发了降级，通常不算服务故障。

## 危险操作的确认提示找不到了

直接发：

```text
/confirm-action list
```

或者直接确认最新一条：

```text
/confirm-action latest confirm
```

## 私聊里总是接着同一个会话继续

这是当前设计行为。

你可以用：

- `/new` 新开会话
- `/sessions` 查看旧会话
- `/resume <id>` 切回指定会话
- `/rename`、`/pin`、`/fork` 管理长期工作线程

## QQ gateway 经常重连

先收集：

- `npm run doctor`
- `/diag`
- `npm run service:status`

重点排查：

- 主机网络是否不稳定
- QQ 凭证是否失效或被轮换
- gateway session 是否频繁过期
- 后台服务是否被系统重启

项目内部已经做了 heartbeat ACK 监控、重连退避，以及 repeated `4009` 后强制 fresh identify 的兜底。

## OCR 看起来没生效

先看：

```bash
npm run doctor
```

当 `IMAGE_OCR_MODE` 不是 `off` 时，doctor 应该能看到：

- macOS 上的 `vision(swift)`，或者
- `tesseract`

补充说明：

- OCR 更适合截图、报错界面、UI 图
- `auto` 模式会故意更保守，普通照片不会强行注入太多文字
- 如果你不需要 OCR，直接设 `IMAGE_OCR_MODE=off`

## 前台运行正常，但后台服务不稳定

可以对比：

```bash
npm start
npm run service:status
```

常见原因：

- 服务环境变量还是旧的
- 服务 PATH 不一致
- 改了 `.env` 后没有重启服务

改完配置后建议明确重启：

```bash
npm run service:restart
```

## 一个好 issue 应该带什么

- 精确版本号或 commit
- 操作系统和 Node.js 版本
- 是前台、`launchd` 还是 `systemd`
- 只在私聊、只在群聊，还是两者都有
- `npm run doctor` 输出
- 如果方便，附上 `npm run doctor:json`
- 如果 QQ 还能回复，附上 `/diag`
- 打码后的日志和截图
