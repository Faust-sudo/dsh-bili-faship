# 安全策略（SECURITY）

## 这个插件会碰什么

- **B 站 cookie**：`SESSDATA` / `bili_jct` / `buvid3` 存在 `~/.bili-ai/credentials.json`，**只写不读回**：
  设置页保存后立即清空输入框，日志/报错/`GET /settings` 都不会回显；真投稿时才读取。
- **真投稿**：默认完全关闭。要真发必须同时满足：设置页打开 `autoPublish.allowGo`（二次确认）+
  `autoPublish.dryRun=false` + 每个调用方显式 `confirm`（工具 / HTTP / CLI `--confirm` 三处）。
- **网络**：只访问 B 站公开接口（`member.bilibili.com` / `api.bilibili.com` / upos 上传域）与
  Edge TTS；不访问其它地址，不上传本地文件到第三方。
- **本地文件**：只读写 `<DSH_HOME>/bili-faship/**`、配置文件和成片目录；
  `/media` 只读 `videoRoot()` 内的白名单文件（`video.mp4` / `cover.jpg` / `subtitles.srt` / `review.json` 等），
  句柄判定走 realpath 防 junction/symlink 逃逸。

## 红线（代码强制，不是提示词）

1. AI 生成内容必须**画面 + 简介**双标注，配置不能关闭；
2. 不冒充真人、不搬运未标注片段（引用必须三要素齐全且单段 ≤ 3 秒）；
3. 不刷量、不群发、不诱导互关；撞 412 / 429 / 601 立即停，**永不自动重试、不绕验证码**；
4. `review.pass !== true` 不得发布。

## 报告漏洞

请**不要**公开 Issue 里贴 cookie / SESSDATA / bvid 之外的账号信息。直接发邮件或在仓库用
GitHub Security Advisory（Security → Advisories → Report a vulnerability）私密报告。

请附：插件版本、DSH 版本、复现步骤、日志里**已脱敏**的片段。
