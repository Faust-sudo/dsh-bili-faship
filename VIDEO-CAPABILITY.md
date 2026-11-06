# 视频工坊能力清单（插件语境）

> 这份文件回答四个问题：**它能做什么、数据怎么流、发布要过哪些闸门、一次「做一条」是怎么被组织成工单的**。
> 契约（接口形状、路径、红线）以 [`DESIGN.md`](DESIGN.md) 为准；使用说明见 [`README.md`](README.md)；
> storyboard 字段细节见 [`docs/video-storyboard.md`](docs/video-storyboard.md)；
> 投稿流程与 601 记录见 [`docs/video-publish.md`](docs/video-publish.md)；
> 工单模型的学习笔记见 [`docs/SUPERAGENT-NOTES.md`](docs/SUPERAGENT-NOTES.md)。

## 1. 能力清单

| 能力 | 入口 | 产物 | 状态 |
|---|---|---|---|
| 生成 storyboard 模板 | `plan` / `faship_plan` / POST `/jobs` `action:"plan"` | `<dir>/storyboard.json` | ✅ |
| 渲染成片 | `render` / `faship_render` / POST `/jobs` `action:"render"` | `video.mp4`、`cover.jpg`、`subtitles.srt`、`timing.json`、`meta.json` | ✅（本机 42.5s 片实测 3–4 分钟） |
| 代码自审 | `review` / `faship_review` / POST `/jobs` `action:"review"` | `<dir>/review.json`（pass / score / checks） | ✅ |
| 出投稿包（不联网） | `publish --dry` / `faship_publish mode:"dry"` | `<dir>/publish.json` | ✅ |
| 真投稿 | `publish --go` / `faship_publish mode:"go"` | `publish.json` + `<videoRoot>/index.json` | ⚠️ 链路完整但**未跑通**：首测被 601 拦（见 §10） |
| 依赖体检 | `deps` / `faship_deps` / GET `/deps` | 软硬件检查清单 | ✅ |
| 视频列表 / 状态 | `status` / `faship_status` / GET `/status`、`/videos` | 到期 / 待发 / 上次发布 / `needsAttention` | ✅ |
| 生物钟叫醒 | `lib/scheduler.mjs` / POST `/wake` / `faship_wake` | 工单 + 一次 agent 会话 | ✅（v0.2 改为「建工单 + 派工」） |
| 工单 / 准入 | GET `/tickets` / `faship_tickets` | `tickets.json`（工单、阶段、准入记录） | ✅ |
| 结构化报告 | `faship_report` | 工单 `report` 字段 → 阶段 / attention | ✅ |
| 待你处理 | 设置页顶部 / `faship_ticket_action` / POST `/tickets` | attention 列表 + `retry / ack / stop` | ✅ |
| 观察模式 | 设置 `admission.observeOnly` | 只做选题 + 草稿 + 计划，不 render/publish | ✅ |
| 看门狗 / 恢复 | `lib/scheduler.mjs` tick + `lib/jobs.mjs` | 卡死任务标 failed、attention、恢复说明 | ✅ |
| 设置页 | 设置 → 视频工坊（`client.js`） | 读写配置、触发动作、看视频、看待你处理 | ✅ |

## 2. 数据流

```
日记 / 偏好 / 平台现实（素材）
   └─ agent 选题 + 写 storyboard.json（v4，约 12 场）
        └─ render.mjs
             · 每场 TTS（Edge TTS，免费无 key，去尾静音）
             · 时间轴 / 字幕 cue（标点切句、关键词高亮）
             · 调 Python 逐帧渲染（Pillow：背景 / 气泡 / 表情包 / 12 种卡片 / 大字 / 印章 / 胶囊字幕 / 封面）
             · BGM + SFX 混音 + loudnorm（-16 LUFS）
             · 输出 video.mp4 / cover.jpg / subtitles.srt / meta.json / timing.json（先写临时目录再换名）
        └─ review.mjs → review.json（pass / score / checks；发布前置硬闸门）
             └─ publish.mjs --dry → publish.json（投稿包，不联网）
                  └─ publish.mjs --go → preupload → upos 分片 → 封面 → add/v3
                       → publish.json + <videoRoot>/index.json
```

宿主侧（v0.2 的「准入 → 工单 → 派工 → 报告」主线）：

```
时钟 tick（每 60s）
  ├─ 相位 1 看门狗：检查运行中任务是否超时/无输出 → 结束 + 标 failed + attention
  ├─ 相位 2 自动重试：失败工单在次数/退避内 → 再派工
  └─ 相位 3 准入 → 派工：
        admission（确定性闸门）→ accept → 建工单（tickets.json）→ 派工
             → Worker 会话（per-ticket 默认；cwd = 工单目录）→ buildTicketPrompt 叫醒词
                    └─ 用 tools/bili-faship.mjs 做片
             → faship_report（progress/waiting/ready/blocked/failed/dropped）
                    └─ 宿主推导 stage / 生成 attention / 结案
设置页 client.js ──/dsh-bili-faship/api/*──► index.js（信任栅栏 → 路由）
                                               ├─ lib/config.mjs   配置读写
                                               ├─ lib/tickets.mjs  工单 / 准入 / 阶段 / attention
                                               ├─ lib/jobs.mjs     后台任务 + 看门狗挂钩
                                               ├─ lib/status.mjs   状态口径
                                               ├─ lib/deps.mjs     依赖体检
                                               └─ lib/scheduler.mjs 三相位 tick
```

## 3. storyboard v4 关键字段

完整 schema、卡片种类与最小可渲染示例见 [`docs/video-storyboard.md`](docs/video-storyboard.md)。
这里只列最容易写错的：

```jsonc
{
  "version": 4,
  "slug": "day1-stand-in-middle",
  "title": "站在中间的一天",
  "date": "2026-11-06",
  "width": 1920, "height": 1080, "fps": 30,
  "voice": { "voice": "zh-CN-XiaoyiNeural", "rate": "+8%", "pitch": "+8Hz" },
  "topbar": { "badge": "Day 1", "label": "AI 接管中 · 大肥鱼的运营日志", "right": "本视频含 AI 生成内容" },
  "scenes": [{
    "id": "s1",
    "narration": "旁白，会被 TTS 念出来；空字符串 = 这场不出声",
    "mascot": "happy",
    "card": { "kind": "big", "text": "...", "sub": "..." },
    "stamp": { "text": "自审通过", "angle": -6 },
    "shout": { "text": "全归我", "color": "yellow", "pos": "top", "angle": -5 },
    "subtitleEmph": ["关键词"],
    "minDuration": 2.8
  }],
  "audio": { "bgm": "soft-groove", "bgmVolume": 0.72 },
  "publish": { "titleForPost": "...", "description": "...（必须含「AI 生成」）", "tags": [], "aiLabel": "本视频含 AI 生成内容" },
  "citations": []   // 有引用才填 {bv, up, title, clipSec}
}
```

- 场次：约 12 场，每场 2–3 秒，一条 35–45 秒；旁白**不要**和大字重复同一句话。
- 12 种卡片：`big / profile / stats / note / dm / list / videos / bubble / alert / cta / ending / none`。
- 可用表情：`happy / surprised / idea / lazy / fish / hop / brave / heal / arrow / dian / special`。
- `citations` 每条必须有 `bv` + `up` + `title`，且 `clipSec ≤ selfReview.maxClipSec`（默认 3 秒）。

## 4. 自审 7 项硬闸门（`review.json.pass` 必须 `true`）

| # | check id | 判据 | 不通过的后果 |
|---|---|---|---|
| 1 | `schema` | storyboard 是合法 v4（字段 / 场次 / 枚举） | FAIL |
| 2 | `duration` | 成片时长在 `[minDurationSec, maxDurationSec]`（默认 15–180s） | FAIL |
| 3 | `loudness` | 集成响度在 `selfReview.loudnessRange`（默认 −20..−12 LUFS，ffmpeg ebur128 实测） | FAIL |
| 4 | `aiLabel` | `topbar.right` / `publish.description` / `publish.aiLabel` 至少一处含「AI 生成」 | FAIL |
| 5 | `citations` | 引用三要素齐全 + 单段 ≤ `maxClipSec` | FAIL |
| 6 | `redline` | 不命中 `redlines.bannedWords`，不出现冒充真人短语 | FAIL |
| 7 | `subtitleCoverage` | 有旁白场次的字幕覆盖率 ≥ `minSubtitleCoverage`（默认 0.9） | FAIL |

外加软检查（只影响分数，不改变 pass）：`artifacts`（meta 产物清单）、`publishMetadata`（投稿标题/简介已填）、
`scoreLine`（评分是否达到 `selfReview.passScore`，默认 80）。
`pass` **只看硬闸门**；任何硬闸门失败 → `publish` 直接拒绝。

## 5. 投稿前置条件（`publish.mjs`）

`--dry` 与 `--go` **跑同一套闸门**，区别只是发不发网络：

1. `review.json.pass === true`（缺文件 / 非 true → `REVIEW_NOT_PASSED`）
2. `video.mp4` / `cover.jpg` 存在且非 0 字节（→ `MISSING_MEDIA`）
3. 标题 ≤ 80 字、简介 ≤ 2000 字、标签 ≤ 10 个（→ `INVALID_TITLE / INVALID_DESC / INVALID_TAGS`）
4. 简介必须含「AI 生成」（→ `REDLINE_AI_LABEL`）
5. 简介不命中红线词（→ `REDLINE_BANNED`）
6. 距 `index.json.lastPublishedAt` ≥ `cadenceDays` 天（→ `CADENCE`）
7. 同一 `slug` 没发过（→ `DUPLICATE_SLUG`）
8. `index.json` 可读且结构正确（损坏 → `INDEX_CORRUPT`，**不静默当成没发过**）
9. `video.publish.enabled === true`（→ `PUBLISH_DISABLED`）
10. `--go` 还要求凭据齐全：`SESSDATA` + `bili_jct` + `buvid3`（→ `AUTH_MISSING`，且 0 网络请求）

再加**插件层**的闸门（宿主 / 工具侧，CLI 不强制但宿主强制）：

11. `video.autoPublish.allowGo === true`（设置页 danger 开关，默认 `false`）
12. 调用方显式 `confirm: true`（`faship_publish` 参数 / `POST /jobs` body）
13. `video.autoPublish.dryRun === false`（只做 dry 时不允许真发）
14. `video.publish.enabled === true`，且 `review.json.pass === true`（工具层再复核一次）

任何一步失败都**立即停止、不重试、不发半截稿件**；真发成功后只写 `publish.json` + 追加 `index.json`。
失败行为与错误码表见 [`docs/video-publish.md`](docs/video-publish.md)。

**投稿前置 ↔ 工单阶段**的关系（v0.2）：

- 上面 1–14 全过、且真的发出去 → 工单走 `done/published`；
- 全过但还没发（`review.pass` + dry 包就绪）→ 工单停在 **`person/review`**，在「待你处理」里等人决定发布；
  不会自己发（除非 `allowGo` + `dryRun=false` 都打开且 agent 被明确要求真发）；
- 撞 601 / 412 / 429 → 工单进入 **`person/blocked`** + `rate-limited` attention，**永不自作主张重试**；
- 自审不过 → `review-failed` attention，在 `person/failed`（内容问题不自动重试，等人或 agent 改）。

## 6. 工单阶段表（v0.2）

`stage` 由宿主从**证据**（工单 report / 任务状态 / 文件 / attention）推导，客户端只显示。
从上往下读，第一个匹配的行生效：

| stage | 条件 | 面板标签 | 归谁处理 |
|---|---|---|---|
| `person/delivery` | 叫醒投递失败且还没重试成功 | 待你处理（投递失败） | 人（或自动重试） |
| `person/blocked` | 有 attention（report=blocked 或 601/风控） | 受阻，等你 | 人 |
| `person/failed` | 最近 report=failed，或任务失败且自动重试用尽 | 失败，等你 | 人 |
| `person/review` | 成片 + `review.pass=true` + dry 投稿包就绪，还没发布 | 等你审阅 / 决定发布 | 人 |
| `working/queued` | 开放但还没派工 | 排队中 | 宿主 |
| `working/running` | 已派工（会话在跑）或该工单的后台任务在跑 | 制作中 | worker |
| `idle` | report=waiting，或这一轮结束且没在等任何人 | 等下一次触发 | 时钟 |
| `done/published` | 已发布 | 已发布 | — |
| `done/dropped` | report=dropped 结案 | 无需处理 | — |
| `done/stopped` | 人工 stop | 已停止 | — |
| `done/failed` | 失败且处理完毕 | 已失败 | — |

`person/*` = **不能无人继续**；`idle` = 这一轮做完了，等下一次触发；
`done/*` 是终态，工单保留在历史里（最近 50 个）。

## 7. 准入闸门（v0.2）

调度每次想建工单前，按顺序检查（第一条失败即原因；**确定性、不调 LLM、不花 token**）：

1. `video.enabled`（总开关）
2. 自动触发还要 `schedule.enabled`
3. 投稿索引损坏 → `index-corrupt`
4. 已有后台任务在跑 → `job-running`
5. 已有开放工单在 `working/*` → `ticket-working`
6. 今天工单数 ≥ `tickets.maxPerDay`（默认 2）→ `daily-limit`
7. 自动触发：未到期 → `not-due`
8. 自动触发：不在窗口 → `out-of-window`
9. 自动触发：距上次叫醒 < `schedule.cooldownHours`（默认 30h）→ `cooldown`

通过 → `accept`，建工单：自动触发 = `inferred`，手动 = `explicit`。

- 每次 accept、每次手动触发、以及「到期却因窗口/冷却/限额没做」都写一条 **admission 记录**；
  **完全没到期的 tick 不记录**（安静）。
- `admission.observeOnly=true` 时仍然建工单、仍然叫醒，但 mandate 标 `observeOnly`：
  worker 只做「选题 + storyboard 草稿 + 依赖检查 + 计划」，**禁止 render / publish**，
  把「如果放开会怎么做」写进汇报。

## 8. 看门狗与重试（v0.2）

**看门狗**（`watchdog.enabled`，默认开）：

- 每 60 秒 tick 检查每个运行中任务：超过 `watchdog.maxJobMinutes`（默认 40 分钟）
  → 结束子进程、任务标 `failed`（note 写明 watchdog）、工单挂 `stalled` attention。
  `watchdog.idleMinutes` 默认 **0（关闭）**——渲染器不转发逐帧进度，空闲检测会误杀长渲染；
- 同一 tick 做**存活检查**：开放工单 20 分钟没有新事件、也不属于运行中任务 → `stalled`（60 分钟去重）；
- 宿主启动时：`jobs.json` 里遗留 `running` → `interrupted`；开放工单若在 `working/*` 却没有活任务 →
  挂 `host-restarted` attention；下次派工带**恢复说明**（先检查目录，别重复已完成的步骤）。

**自动重试**（`worker.autoRetry.enabled`，默认开）：

- 只对执行/投递类失败：`render-failed / publish-failed / job-failed / stalled / host-restarted / delivery-failed`；
- 条件：`attempts < maxAttempts`（默认 2）且距上次尝试 ≥ `backoffMinutes`（默认 10）；
- 重试 = 再派一次工（工单事件 `retry`），用尽后转 `person/failed`；
- **`review-failed` 不自动重试**（内容问题，等人或 agent 手动 `retry`）；
- **平台风控（日志含 601/412/429）→ `rate-limited`，永不自动重试**（红线）。

## 9. 结构化报告（v0.2）

`faship_report { ticket, status, note? }`，宿主只认这六个 status：

| status | 含义 | 宿主行为 |
|---|---|---|
| `progress` | 还在做 / 阶段性进展 | 保持 `working/running` |
| `waiting` | 这一轮做完，等下一次触发 | `idle` |
| `ready` | 成片 + 自审 pass + dry 投稿包就绪 | `person/review`（等人决定发布） |
| `blocked` | 被卡住（含 601 / 风控） | `person/blocked` + attention |
| `failed` | 这一轮失败 | `person/failed` + attention |
| `dropped` | 这件事不用做了 | 直接结案 `done/dropped`（不发消息） |

设计要点（借自 super-agent 的 Report 概念）：

- **不解析自由文本**：「在等人」必须来自结构化字段，不从 `note` 里猜；
- 工单 id 由叫醒词给出；工具校验工单存在且开放；
- attention 的「重试 / 我知道了 / 停止」都从这里的结构化状态推导。

## 10. 已知风险（必须知道）

- **601 风控**：2026-10-26 首次真发在预上传被拦（HTTP 406 / code 601 / `v_voucher`）。
  处理方式：人工去创作中心验证 / 等冷却，**不要自动重试、不要绕验证码**。
- **协议未实测**：upos 分片、封面上传、`add/v3` 按公开协议实现，真实网络只走到预上传。
- **接口会变**：B 站 web 接口没有公开承诺；返回缺字段时模块一律报错停下，不猜。
- **citations 不会真剪片段**：目前只做元数据 + 标注 + `videos` 卡片。
- **自审不 OCR 画面**：只扫文本与数值，画面上的违规内容靠人。
- **分区 / 字体 / 平台可能变**：`tid` 可配；非 Windows 字体退化。
- **工单是单机串行**：同时最多一个 `working/*`；不引入 worker 池 / 多账号 / 多 Executor 并发。
- **工单阶段由推导得出**：极端的中间态（比如任务刚结束但报告还没落盘）会短暂显示上一个阶段，
  以 `tickets.json` 与 `jobs.json` 为准。

## 11. 红线（代码强制）

1. **AI 生成如实标注**：画面 + 简介都必须有；review 硬闸门 + publish 闸门双保险。
2. **不冒充真人**：「我是真人」类表述直接 FAIL。
3. **不搬运**：引用三要素齐全且单段 ≤ 3 秒。
4. **不刷量、不群发、不诱导互关**；撞 412 / 429 / 601 立即停，不自动重试。
5. `copyright` 固定写 **1（自制）**，不开放配置（AI 生成内容不能标转载）。
