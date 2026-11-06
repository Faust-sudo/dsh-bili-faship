# 视频工坊能力清单（插件语境）

> 这份文件回答三个问题：**它能做什么、数据怎么流、发布要过哪些闸门**。
> 契约（接口形状、路径、红线）以 [`DESIGN.md`](DESIGN.md) 为准；使用说明见 [`README.md`](README.md)；
> storyboard 字段细节见 [`docs/video-storyboard.md`](docs/video-storyboard.md)；
> 投稿流程与 601 记录见 [`docs/video-publish.md`](docs/video-publish.md)。

## 1. 能力清单

| 能力 | 入口 | 产物 | 状态 |
|---|---|---|---|
| 生成 storyboard 模板 | `plan` / `faship_plan` / POST `/jobs` `action:"plan"` | `<dir>/storyboard.json` | ✅ |
| 渲染成片 | `render` / `faship_render` / POST `/jobs` `action:"render"` | `video.mp4`、`cover.jpg`、`subtitles.srt`、`timing.json`、`meta.json` | ✅（本机 42.5s 片实测 3–4 分钟） |
| 代码自审 | `review` / `faship_review` / POST `/jobs` `action:"review"` | `<dir>/review.json`（pass / score / checks） | ✅ |
| 出投稿包（不联网） | `publish --dry` / `faship_publish mode:"dry"` | `<dir>/publish.json` | ✅ |
| 真投稿 | `publish --go` / `faship_publish mode:"go"` | `publish.json` + `<videoRoot>/index.json` | ⚠️ 链路完整但**未跑通**：首测被 601 拦（见 §6） |
| 依赖体检 | `deps` / `faship_deps` / GET `/deps` | 软硬件检查清单 | ✅ |
| 视频列表 / 状态 | `status` / `faship_status` / GET `/status`、`/videos` | 到期 / 待发 / 上次发布 | ✅ |
| 生物钟叫醒 | `lib/scheduler.mjs` / POST `/wake` / `faship_wake` | `schedule.json` + 一次 agent 会话 | ✅ |
| 设置页 | 设置 → 视频工坊（`client.js`） | 读写配置、触发动作、看视频 | ✅ |

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

宿主侧：

```
设置页 client.js ──/dsh-bili-faship/api/*──► index.js（信任栅栏 → 路由）
                                               ├─ lib/config.mjs   读/合并/校验/写配置
                                               ├─ lib/deps.mjs     依赖体检
                                               ├─ lib/jobs.mjs     render / publish-go 后台任务
                                               └─ lib/scheduler.mjs 每 60s tick → sessionController.prompt
                                                      └─ 叫醒词 lib/prompt.mjs → 鲸鱼娘那一轮会话
                                                             └─ 用 tools/bili-faship.mjs 做片
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

## 6. 已知风险（必须知道）

- **601 风控**：2026-10-26 首次真发在预上传被拦（HTTP 406 / code 601 / `v_voucher`）。
  处理方式：人工去创作中心验证 / 等冷却，**不要自动重试、不要绕验证码**。
- **协议未实测**：upos 分片、封面上传、`add/v3` 按公开协议实现，真实网络只走到预上传。
- **接口会变**：B 站 web 接口没有公开承诺；返回缺字段时模块一律报错停下，不猜。
- **citations 不会真剪片段**：目前只做元数据 + 标注 + `videos` 卡片。
- **自审不 OCR 画面**：只扫文本与数值，画面上的违规内容靠人。
- **分区 / 字体 / 平台可能变**：`tid` 可配；非 Windows 字体退化。

## 7. 红线（代码强制）

1. **AI 生成如实标注**：画面 + 简介都必须有；review 硬闸门 + publish 闸门双保险。
2. **不冒充真人**：「我是真人」类表述直接 FAIL。
3. **不搬运**：引用三要素齐全且单段 ≤ 3 秒。
4. **不刷量、不群发、不诱导互关**；撞 412 / 429 / 601 立即停，不自动重试。
5. `copyright` 固定写 **1（自制）**，不开放配置（AI 生成内容不能标转载）。
