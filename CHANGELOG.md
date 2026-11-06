# CHANGELOG · dsh-bili-faship（鲸鱼娘视频工坊）

版本号跟 `package.json` 走。当前 `0.2.0`。

---

## 0.2.0 — 2026-11-07 · 工单模型（借鉴 DeepSeek Super-agent）

**这一版给「叫醒 → 干活」加上了身份、记录和恢复能力。** 结构上借鉴了 DeepSeek 官方研究原型
`dsh-superagent-prototype`（MIT）的 Source → Trigger → Eval → Ticket → Executor → Report → Panel 模型，
但只借**结构**、不搬规模与实现：我们仍然只有一台机器、一个时钟、一条流水线。
学习笔记见 [`docs/SUPERAGENT-NOTES.md`](docs/SUPERAGENT-NOTES.md)；契约见 `DESIGN.md` §10。

**① 工单（Ticket）**
- 一次「做一条视频」现在是一个有 id、有目录、有会话、有尝试次数、有时间线的工单，落在
  `<DSH_HOME>/bili-faship/tickets.json`（只保留最近 50 个工单 / 50 条准入记录，原子写盘）。
- **阶段由宿主按证据推导**，客户端只显示：`person/delivery`、`person/blocked`、`person/failed`、
  `person/review`（需要人）、`working/queued`、`working/running`（在跑）、`idle`（等下一次触发）、
  `done/published|dropped|stopped|failed`（已结案）。
- 每个工单有事件时间线（`admitted / dispatched / report / job-started / job-finished / attention / retry / ack / stopped / ended`）。

**② 准入（Admission，确定性闸门）**
- 建工单前按顺序检查：总开关 → 生物钟开关 → 投稿索引是否损坏 → 有没有后台任务在跑 →
  有没有工单正在做 → 今日工单数是否达 `tickets.maxPerDay`（默认 2）→ 是否到期 → 是否在窗口 → 冷却。
- 第一条失败即记录原因（`index-corrupt / job-running / ticket-working / daily-limit / not-due /
  out-of-window / cooldown / disabled / schedule-off`）；**不调 LLM、不花 token、可解释**。
- 每次 accept、手动触发、以及「到期却因为窗口/冷却/限额没做」都写一条 admission 记录；
  完全没到期的 tick 不记录（安静）。

**③ Worker 会话模式**
- 新设置 `worker.sessionMode`，默认 **`per-ticket`**：会话 id = `bili-faship-<short>`，cwd = 工单目录。
  每条片一个干净上下文，记忆走文件（日记 / 报告 / 工单历史），不让会话无限长大。
- 可选 `persistent`：沿用 v0.1 的固定会话 `bili-faship` + `<DSH_HOME>/faship-work`。
- 投递成功写 `dispatched` 事件、`attempts += 1`；投递失败挂 `delivery-failed` attention，下个 tick 重试（不 ++attempts）。

**④ 结构化报告 `faship_report`**
- 新工具 `faship_report { ticket, status, note? }`，status ∈ `progress | waiting | ready | blocked | failed | dropped`。
- 宿主据此推阶段/生成 attention/结案：`dropped` 直接结案（不发消息）、`blocked/failed` 进入「待你处理」、
  `ready` 进入 `person/review`（等人决定发布）。
- **不解析自由文本**：「在等人」必须来自结构化字段。

**⑤ 看门狗与恢复（Watchdog / Recovery）**
- 每 60 秒 tick 顺带检查运行中任务：超过 `watchdog.maxJobMinutes`（默认 40）或
  `watchdog.idleMinutes`（默认 8）无日志增长 → 结束子进程、任务标 `failed`（note 写明 watchdog）、工单挂 `stalled` attention。
- 插件启动时：`jobs.json` 里遗留的 running 标 `interrupted`；开放工单若在 `working/*` 却没有活任务 →
  挂 `host-restarted` attention；下一次派工带**恢复说明**（先检查目录，别重复已完成的步骤）。

**⑥ 自动重试**
- `worker.autoRetry.enabled`（默认 true）：只对执行/投递类失败（`render-failed / publish-failed / job-failed /
  stalled / host-restarted / delivery-failed`）在 `maxAttempts`（默认 2）内按 `backoffMinutes`（默认 10）退避重试；
  次数用尽转 `person/failed`。
- **`review-failed` 不自动重试**（内容问题，等人或 agent 手动改）；**平台风控（601/412/429）永不自动重试**（红线）。

**⑦ 设置页「待你处理」面板**
- 顶部新增三块：**待你处理**（attention 列表，带「重试 / 我知道了」；为空时整块隐藏）、
  **工单**（最近工单：阶段标签、尝试次数、目录、折叠时间线）、**准入**（今日工单数 / 上限、最近一次 accept/reject 原因）。
- 新增 7 项设置：`tickets.maxPerDay`、`worker.sessionMode`、`worker.autoRetry.enabled`、
  `worker.autoRetry.maxAttempts`、`watchdog.enabled`、`watchdog.maxJobMinutes`、`admission.observeOnly`。

**⑧ 观察模式 `admission.observeOnly`**
- 打开后仍然建工单、仍然叫醒，但 mandate 标 `observeOnly`：worker 只做「选题 + storyboard 草稿 + 依赖检查 + 计划」，
  **禁止 render / publish**，把"如果放开会怎么做"写进汇报。先看它想做什么，再决定放不放权。

**⑨ API / 工具增量**
- HTTP：`GET /tickets`（工单 + 阶段 + attention + 准入摘要）、`POST /tickets`（`retry / ack / stop`）；
  `GET /status` 增加 `tickets:{open,attention}` 与 `admission.last`。
- 工具：`faship_tickets {}`、`faship_report {ticket,status,note?}`、`faship_ticket_action {id,action}`；
  `faship_status` 增加 `needsAttention`；`faship_wake` 改为「建 manual 工单 + 派工」。

**⑩ 兼容与文档**
- v0.1 的 `/settings`、`/status` 字段全部保留；旧配置无需迁移（新字段有默认值）。
- 新增 `docs/SUPERAGENT-NOTES.md`；`README.md` 增加「工单 / 待你处理 / 准入 / 观察模式 / 看门狗」一节，
  `VIDEO-CAPABILITY.md` 增加阶段表 / 准入闸门 / 看门狗重试 / 结构化报告，`docs/PLUGIN.md` 补工单与面板实现，
  `prompts/wake.md` 对齐新的工单叫醒词。
- 单测新增工单/准入/阶段推导/看门狗/重试/面板数据等用例；**真投稿仍然不测**。

---

**审计修复（同版本内，2026-11-07）**

- 看门狗空闲检测默认关闭（`watchdog.idleMinutes=0`）：渲染器不把逐帧进度转发到宿主日志，8 分钟没日志会误杀正常长渲染；总时长上限仍是 40 分钟。
- 修复「成片就绪」ack 后又冒出来：报告 `ready` 与产物扫描两种表示现在会被同时压住。
- 新增存活检查（liveness）：开放工单 20 分钟无新事件且没有运行中任务 → `stalled` attention（60 分钟去重），兜底插件重载后工单卡在「制作中」。
- 叫醒词补插件目录与文档绝对路径（`worker.sessionMode=per-ticket` 时 cwd 是工单目录，相对路径找不到文档）。
- `/jobs` 的 render 恢复透传 `width/height/fps`（重构时的回归）。
- 新增 `scripts/e2e-ticket.mjs`：320×180 真机跑通「叫醒→plan→render→review→dry→report ready→attention→ack→stop」（36 秒，不属于测试套件）。
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
