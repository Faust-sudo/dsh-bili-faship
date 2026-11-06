# CHANGELOG · dsh-bili-faship（鲸鱼娘视频工坊）

版本号跟 `package.json` 走。当前 `0.1.0`。

---

## 0.1.0 — 2026-11-06 · 首版

**第一版：把原独立项目 `bili-faship` 的视频能力，正式做成一枚 DSH 插件。**
灵感与教训来自 `dsh-bili-whale`（生物钟 / 设置页）与 `dsh-bili-scroll`（工具注册 / 自检 / 打包）。

**① 设置页「视频工坊」**
- 状态卡：今天到不到期、上次发布、待发片单、最近任务、调度原因
  （`due / not-due / out-of-window / cooldown / disabled / schedule-off / already-woke-today / job-running`）。
- 分组表单：节奏、发布与红线（「允许真发」是 danger 开关，要二次确认）、声音、渲染与路径、人物与素材、凭据。
- 视频列表：封面预览、播放链接、展开看自审摘要。
- 按钮：保存 / 依赖体检 / 重新读取 / 现在做一条（POST `/wake`，二次确认）。
- 凭据**只写不读回**：cookie 保存后页面上不会回显。

**② 生物钟（`lib/scheduler.mjs`）**
- 每 60 秒 tick 一次，条件全满足才叫醒：总开关开、在允许窗口内、到期、今天没叫过、过了冷却、没有任务在跑。
- 叫醒方式：`sessionController.create({ sessionId:"bili-faship", cwd:<DSH_HOME>/faship-work })` → `prompt({ mode:"queue" })`。
- 叫醒词（`lib/prompt.mjs`）带身份、到期信息、素材与 CLI 路径、五步流程、红线、投稿策略、汇报路径，
  并且**明确允许「今天不想做」**：写日记说明原因，不算偷懒。
- 叫醒成功写 `schedule.json`（`lastWakeAt / lastWakeDay`），失败保留状态、下个 tick 按 `minGapMinutes` 重试。

**③ Agent 工具（`faship_*`）**
`faship_status` / `faship_deps` / `faship_videos` / `faship_plan` / `faship_render` / `faship_review` /
`faship_publish` / `faship_job` / `faship_wake`，外加只读的 `faship_config`。`defineTool` 优先从宿主树解析，
拿不到就用本地等价实现 —— **工具注册失败不连累插件激活**。

**④ 后台任务队列（`lib/jobs.mjs`）**
- `render` / `publish-go` 起真 node 子进程（Electron 的 `process.execPath` 跑不了脚本，必须探测真 node）。
- 日志写 `<DSH_HOME>/bili-faship/jobs/<jobId>.log`，状态写 `jobs.json`；同类任务重入保护（409）。
- 任务在跑时生物钟自动让路（`job-running`）。

**⑤ 宿主 HTTP API（`/dsh-bili-faship/api/*`）**
`GET/POST /settings`、`GET /status`、`GET /videos`、`GET /deps`、`POST /cookie`、`POST /jobs`、
`GET /jobs[?id=]`、`POST /wake`、`GET /report`、`GET /media`。全部先过 DSH 信任栅栏（fail-closed），只收本机回环；
`/media` 只读 `videoRoot()` 内的白名单文件，防路径穿越。

**⑥ 视频管线（`tools/**`）**
- 从原独立项目移植：storyboard v4 校验 / plan 模板、纯 Node Edge TTS、Python 逐帧渲染、混音与响度归一、
  自审 7 硬闸门、投稿包（dry）与真发（go）两步。
- 路径全部改到插件语境：插件家目录 `<DSH_HOME>/bili-faship`，配置 `<DSH_HOME>/bili-faship.config.json`，
  成片默认 `<DSH_HOME>/bili-faship/videos`；仍然兼容旧环境变量（`WHALE_*`）与旧配置（`BILI_WHALE_CONFIG` 的 `video` 段）。
- CLI：`node tools/bili-faship.mjs plan|render|review|publish|status|deps`。
- 依赖体检：node / ffmpeg / Python+Pillow / 表情包 / 字体 / BGM 资源 / cookie / 日记文件；
  硬依赖缺失才 `ok:false`，表情包 / cookie / 日记缺失只 warn。

**⑦ 安全与红线（代码强制）**
- AI 生成如实标注（画面 + 简介）、不冒充真人、不搬运未标注片段（引用 ≤3s + UP/标题/BV）、不刷量不群发。
- `publish-go` 三重闸：`review.pass === true` + 设置里 `autoPublish.allowGo === true` + 调用方显式 `confirm: true`
  （另外还要求 `autoPublish.dryRun === false` 且 `publish.enabled` 为真）；默认 `allowGo=false`，**真发默认关着**。
- 撞 412 / 429 / 601 立即停，不自动重试、不绕验证码（沿用原项目的请求保护层）。

**⑧ 文档与自检**
- `README.md`（使用说明）、`docs/PLUGIN.md`（架构 + 排障）、`docs/video-storyboard.md`（schema）、
  `docs/video-publish.md`（投稿流程 + **首次 601 记录**）、`VIDEO-CAPABILITY.md`（能力合同 v0.1）、
  `prompts/charter.md`（做片章程）、`prompts/wake.md`（叫醒词模板）。
- `selfcheck.mjs`：假 ctx 跑宿主半端 `apply()`（工具数 / 路由数），假 `window.__ModuleLoader__` + 假 React 跑
  设置页半端（section 注册），失败退出码 1。
- `tests/package.test.mjs`：包清单 / bundle patch / 路由字符串 / client id 一致性。

**已知限制（首版就写清楚）**
- 真投稿链路**没有跑通**：2026-10-26 首次 `--go` 在预上传被 B 站 **601** 拦下（`v_voucher`，需人工验证/冷却），
  账号上没有产生任何稿件。见 `docs/video-publish.md` 末节。
- `citations` 目前是元数据 + 标注 + 引用卡，**不会真把别人的片段剪进成片**。
- 自审只扫文本/数值，不 OCR 画面；红线词表可配。
- 渲染性能：1080p 逐帧约 6fps，40 秒片要 3–4 分钟；320×180 只缩成片、不加速。
- 非 Windows：字体退化；接口与分区随时可能变。

**升级 / 回滚**：装法见 `README.md`；回滚 = 从 profile 的 `dsh.profile.bundles` 去掉本包名 +
`dsh plugin --profile desktop remove dsh-bili-faship`，重启 DSH。数据留在 `~/.dsh/bili-faship`，删不删随你。
