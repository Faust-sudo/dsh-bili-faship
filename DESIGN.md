# dsh-bili-faship · 设计契约（多人协作版）

> 本文件是**唯一契约**：宿主半端（index.js/lib）、设置页（client.js）、视频管线（tools/）、
> 文档与自检（README/selfcheck/tests）都按这里的名字与形状实现。改契约先改本文件，并在群里说一声。
>
> 背景：能力原本在独立项目 `D:/agent_train/bili-faship`（plan → render → review → publish）。
> 现在把它**单独做成一个 DSH 插件**，借鉴 `dsh-bili-whale`（设置页/生物钟/信任栅栏/依赖体检/node 运行时）
> 和 `dsh-bili-scroll`（defineTool 注册/宿主依赖解析/selfcheck/打包规范）。
>
> 原项目 `D:/agent_train/bili-faship` 与 `C:/Users/zcr/.dsh/plugins/dsh-bili-whale` **只读参考，不许改**。
> 真投稿（`publish --go`）**一律不许在开发/测试中触发**。

---

## 1. 红线（代码强制，不是提示词）

1. **AI 生成如实标注**：画面 topbar.right + 投稿简介都必须含「AI 生成」；review 硬闸门校验。
2. **不冒充真人**：「我是真人」类表述直接 FAIL。
3. **不搬运**：引用他人片段必须 `citations` 三要素（UP / 标题 / BV）齐全且单段 ≤3 秒。
4. **不刷量、不群发、不诱导互关**；撞 412/429/601 立即停，不自动重试、不绕验证码。
5. `review.pass !== true` 不得发布；`publish --go` 还必须同时满足：设置里 `autoPublish.allowGo === true`
   且调用方显式 `confirm: true`（工具/HTTP 双层）。

安全：

- 所有 HTTP 路由先过 **DSH 信任栅栏**（`connection.requestRejection`，fail-closed）再处理；只接受本机回环。
- `/media` 只能读 `videoRoot()` 之内的文件，防路径穿越。
- 凭据（cookie）**只写不读回**，不落日志、不回显。
- 任何渲染/投稿进程都不由设置页直接拼接任意参数：动作白名单 + 目录必须在 `videoRoot()` 内。

---

## 2. 目录与归属（write scope）

```
D:\Agent\skills\chajian\dsh-bili-faship\
  package.json / cordis.patch.yml      [Lead]
  index.js                             [Lead]  宿主入口
  lib/                                 [Lead]
    hostdeps.mjs      # 从宿主树解析 defineTool（拿不到给本地兜底，不炸插件）
    node-runtime.mjs  # 真 node（Electron 的 process.execPath 跑不了脚本）
    config.mjs        # 宿主侧配置：读/合并/校验/写（唯一真相，复用 tools/lib/video-config.mjs）
    deps.mjs          # 依赖体检（node/ffmpeg/Python+Pillow/表情包/字体/cookie/日记/目录）
    jobs.mjs          # 长任务队列（render/publish-go…）：启动子进程、日志、状态、重入保护
    scheduler.mjs     # 生物钟：每 60s tick，到期+窗口内 → sessionController.prompt 叫醒
    prompt.mjs        # 叫醒词（做片流程/红线/路径/汇报要求）
    tools.mjs         # faship_* 工具注册
  client.js                            [Client] 设置页「视频工坊」
  tools/**                             [Pipeline] 视频管线 + CLI
  tests/video-*.test.mjs               [Pipeline]
  tests/client.test.mjs                [Client]
  tests/package.test.mjs, selfcheck.mjs [Docs]
  docs/**, prompts/**, README.md,
  CHANGELOG.md, LICENSE, NOTICE.md,
  VIDEO-CAPABILITY.md                  [Docs]
  tests/host-*.test.mjs                [Lead]
```

写文件前先确认没有别人占同一文件；**不要跨范围改文件**。需要契约变更 → 改 DESIGN.md 并通知 Lead。

---

## 3. 路径与数据（所有模块统一从 `tools/lib/paths.mjs` 取）

| 用途 | 解析 |
|---|---|
| `HOME` | `USERPROFILE` → `HOME` → `os.homedir()` |
| `DSH_HOME` | `DSH_HOME` → `<HOME>/.dsh` |
| 插件家目录 | `<DSH_HOME>/bili-faship` |
| 配置文件 | `BILI_FASHIP_CONFIG` → `<DSH_HOME>/bili-faship.config.json`（兼容旧 `BILI_WHALE_CONFIG` 里取 `video` 段） |
| 成片根目录 | 配置 `video.outDir`（空 = `<DSH_HOME>/bili-faship/videos`） |
| 表情帧缓存 | 配置 `video.paths.cache`（空 = `<DSH_HOME>/bili-faship/cache`），env `WHALE_VIDEO_CACHE` 仍最优先 |
| 任务日志 | `<DSH_HOME>/bili-faship/jobs/<jobId>.log` + `jobs.json` |
| 调度状态 | `<DSH_HOME>/bili-faship/schedule.json` |
| 最后一次汇报 | `<DSH_HOME>/bili-faship/last-report.md` |
| 叫醒会话 cwd | `<DSH_HOME>/faship-work`（**不许用主目录**） |
| 表情包 | 配置 `video.paths.stickers` → env `WHALE_STICKER_DIR` → `<DSH_HOME>/bili-whale/stickers/packs/大肥鱼`（存在时）→ `<DSH_HOME>/bili-faship/stickers` |
| Python | 配置 `video.paths.python` → env `WHALE_PYTHON` → `python` |
| ffmpeg | 配置 `video.paths.ffmpeg` → env `FFMPEG` → PATH → 插件 `bin/` → `~/.dsh/bili-whale/bin` → 剪映自带（沿用原逻辑） |
| cookie | `<HOME>/.bili-ai/credentials.json`（SESSDATA / bili_jct / buvid3） |
| 日记素材 | 配置 `video.materials.diary`（默认 `D:/bilibili-scroll/bili_whale/whale-diary.md`、`whale-diary-private.md`） |

`tools/lib/video-config.mjs` 是**配置唯一真相**：`VIDEO_DEFAULTS` 定义全部字段，宿主与 CLI 都读它。
宿主写配置后调用 `resetVideoConfig()` 让缓存失效。

---

## 4. 配置 schema（默认值即 `VIDEO_DEFAULTS`）

用户文件形状：`{ "version": 1, "video": { ... } }`（也接受把字段平铺在根上的旧写法）。

```jsonc
video: {
  enabled: true,                       // 总开关（关 = 不叫醒、不渲染）
  outDir: "",                          // 空 = <DSH_HOME>/bili-faship/videos
  cadenceDays: 3,                      // 几天一条
  minDurationSec: 15, maxDurationSec: 180,
  voice: { voice: "zh-CN-XiaoyiNeural", rate: "+8%", pitch: "+8Hz" },
  selfReview: {
    enabled: true, passScore: 80, minSubtitleCoverage: 0.9,
    loudnessRange: [-20, -12], requireAiLabel: true,
    requireRedlineCard: false, maxClipSec: 3
  },
  publish: {
    enabled: true, dryRunByDefault: true, selfApprove: true,
    profile: "ugcfx/bup", tid: 138, partitionName: "生活·日常",
    copyright: 1, noReprint: true,
    tags: [],                          // 追加标签（投稿）
    titlePrefix: ""                    // 可选：标题前缀
  },
  redlines: {
    requireAiLabel: true, forbidImpersonation: true,
    forbidSpam: true, forbidUncreditedClips: true,
    bannedWords: ["政治敏感","赌博","色情","诈骗","代实名","刷量"]
  },
  persona: { name: "大肥鱼", ownerTitle: "主人", selfClaim: "我" },
  materials: {
    diary: ["D:/bilibili-scroll/bili_whale/whale-diary.md",
            "D:/bilibili-scroll/bili_whale/whale-diary-private.md"],
    extraNotes: []
  },
  paths: { stickers: "", cache: "", python: "", ffmpeg: "" },
  schedule: {
    enabled: true,
    window: { start: "21:00", end: "23:30" },   // 每天允许叫醒的窗口
    minGapMinutes: 10,                          // 两次叫醒最小间隔
    cooldownHours: 30                           // 叫醒成功后的硬冷却（避免重复投递）
  },
  autoPublish: { dryRun: true, allowGo: false } // allowGo 默认关；开了也还要 confirm
}
```

宿主保存时只合并白名单字段并做范围校验（见 §5）。**设置页保存整份配置**（load 回来改几个键），
未显示字段原样保留。

---

## 5. 宿主 HTTP API（`/dsh-bili-faship/api/*`）

全部 JSON；失败 `{ ok:false, error }`；全部先过信任栅栏（GET 也过）。

### GET `/settings`
```json
{ "ok": true, "config": { ...完整合并后 video 段... },
  "configPath": "...", "videoRoot": "...", "pluginRoot": "...",
  "home": "...", "version": "0.1.0" }
```

### POST `/settings`
body 接受 `{ config:{...} }` 或直接 `{...}`（只认白名单键，其余忽略并回 `ignored:[]`）。
校验失败 400；成功回 `{ ok:true, config, warnings:[] }`。
范围：`cadenceDays` 1–30；`minDurationSec` 5–600；`maxDurationSec` ≥ min 且 ≤ 900；
`passScore` 0–100；`minSubtitleCoverage` 0–1；`loudnessRange` 两个数 −60..0 且升序；
`maxClipSec` 0.5–10；`schedule.window` 为 `HH:MM`；`tid` 正整数；字符串长度上限（titlePrefix≤40、
persona.name≤40、paths ≤ 500）。

### GET `/status`
```json
{ "ok": true, "now": "ISO", "home": "...", "configPath": "...", "videoRoot": "...",
  "due": true, "nextDueAt": null, "cadenceDays": 3,
  "indexState": "missing|ok|error", "lastPublishedAt": null,
  "last": { "slug":"", "title":"", "bvid":null, "publishedAt":null } | null,
  "pending": [ { "slug":"", "title":"", "dir":"", "reviewedAt":null } ],
  "videos": 0,
  "schedule": { "enabled":true, "inWindow":true, "lastWakeAt":null, "lastWakeDay":null,
                "wakeable":true,
                "reason":"due|not-due|out-of-window|cooldown|disabled|schedule-off|already-woke-today|job-running" },
  "jobs": [ { "id":"", "action":"render", "dir":"", "status":"running|done|failed|interrupted",
              "startedAt":"ISO", "finishedAt":null, "exitCode":null } ],
  "lastReport": { "updatedAt":"ISO|null", "bytes":0 } }
```

### GET `/videos`
```json
{ "ok": true, "root": "...", "videos": [ {
  "slug":"", "title":"", "dir":"", "mtime":"ISO",
  "hasVideo":true, "hasCover":true, "hasStoryboard":true,
  "review": { "pass":true, "score":100 } | null,
  "published": { "bvid":"", "publishedAt":"" } | null } ] }
```

### GET `/deps`
```json
{ "ok": true, "items": [ { "name":"node", "ok":true, "detail":"v24.20.0", "fix":null } ],
  "node": { "path":"", "version":"" }, "ffmpeg": { "path":"", "version":"" },
  "python": { "path":"", "pillow":"" }, "home": "..." }
```
`ok` = 所有硬依赖（node/ffmpeg/python+Pillow/BGM 资源）都真跑通；表情包/cookie/日记缺失只 warn（`ok:false` 但 `items[].optional:true`，`ok` 只由必需项决定）。

### POST `/cookie`
body `{ sessdata, bili_jct, buvid3 }`；复用 dsh-bili-whale 的清洗+校验逻辑（SESSDATA ≥20 字符、
bili_jct 32 位 hex、buvid3 可选告警）；**不读回**；成功 `{ ok:true, detail, self? }`。

### POST `/jobs`
body：`{ action: "plan"|"render"|"review"|"publish-dry"|"publish-go", dir?, topic?, width?, height?, fps?, confirm? }`
- 同步动作（直接回结果）：
  - `plan` → `{ ok:true, result:{dir,file,created,errors,warnings}, job:null }`
  - `review` → `{ ok, result:<review.json 同构> }`（几秒；失败也回 200 + ok:false + error 摘要）
  - `publish-dry` → `{ ok, result:<publish 返回> }`（只建投稿包，不联网；几十秒内）
- 后台动作（立刻回 job，用 GET /jobs 轮询）：
  - `render`、`publish-go` → `{ ok:true, job:{ id, action, dir, status:"running", log:"..." } }`
- 已有同类运行中任务 → 409 `{ ok:false, error:"已有任务在跑", job }`
- `publish-go`：`confirm!==true` → 400；`video.autoPublish.allowGo!==true` 或 `publish.enabled===false` → 403；
  `review.pass!==true` 或 `autoPublish.dryRun!==false` → 409。
- `dir` 必须是 `videoRoot()` 下的绝对路径，否则 400。

> 说明：`publish-dry` 是**同步**的（它只跑本地打包，不联网、幂等，不会像真发那样等 125 秒冷却）；
> `render` 与 `publish-go` 才是后台任务。工具层与 HTTP 层规则一致。

### GET `/jobs`、GET `/jobs?id=`
列表 / 单个（`{ ok:true, job:{...}, log:"<最后 4000 字符>" }`）。

### POST `/wake`
立即投递一次叫醒（不等窗口；仅供"现在做一条"与调试）。
成功 `{ ok:true, sessionId:"bili-faship", at:"ISO" }`；拿不到 sessionController 回 503。

### GET `/report`
`{ ok:true, text:"", updatedAt:"ISO|null" }`（读 `last-report.md`）。

### GET `/media?dir=<slug 或 videoRoot 内的绝对路径>&file=<name>`
白名单文件：`video.mp4`、`cover.jpg`、`subtitles.srt`、`review.json`、`storyboard.json`、`meta.json`。
`dir` 解析后必须落在 `videoRoot()` 内；越界 403；不存在 404；返回原始字节 + `Content-Type`。

---

## 6. Agent 工具（`ctx.tools.register(defineTool(...))`）

工具名统一 `faship_` 前缀；参数 JSON Schema 一律 `{ type:'object', properties:{...}, additionalProperties:false }`；
返回值必须是 lossless JSON（见 dsh-bili-scroll 的 `safe()`）。

| 工具 | 参数 | 返回 |
|---|---|---|
| `faship_status` | `{}` | `/status` 同构（去掉 jobs 细节） |
| `faship_deps` | `{}` | `/deps` 同构 |
| `faship_videos` | `{}` | `/videos` 同构 |
| `faship_plan` | `{ topic, dir?, width?, height?, fps? }` | `{ ok, dir, file, created, errors, warnings }` |
| `faship_render` | `{ dir }` | 启动后台任务：`{ ok, job:{...} }`（已有任务 → `{ok:false, error}`） |
| `faship_review` | `{ dir }` | 同步跑 review（≤90s）：`{ pass, score, reviewPath, checks }` |
| `faship_publish` | `{ dir, mode:"dry"\|"go", confirm? }` | dry 同步返回投稿包结果；go 只启动后台任务（同 `/jobs` 规则） |
| `faship_job` | `{ id }` | `{ ok, job, log }`（日志尾部 ≤4000 字符） |
| `faship_wake` | `{ force?:true }` | `{ ok, sessionId, at }` |

`defineTool` 从宿主树解析（`lib/hostdeps.mjs`，抄 dsh-bili-scroll 的 lib/hostdeps.mjs 思路）；
拿不到就用本地兜底（原样返回 spec，不炸插件）。工具注册失败只 log，不影响插件激活。

---

## 7. 生物钟（`lib/scheduler.mjs`）

- 每 60 秒 tick；`ctx.get('sessionController')` 懒取（拿不到 → 设置页显示"不可用"，不报错）。
- 条件全满足才叫醒：`video.enabled` && `schedule.enabled` && 在窗口内 && `due`
  && `lastWakeDay !== 今天` && 距上次叫醒 ≥ `cooldownHours` && 没有运行中任务。
- 叫醒 = `controller.create({ sessionId:'bili-faship', cwd })`（失败忽略，复用已有会话）
  → `controller.prompt({ requestId, sessionId:'bili-faship', mode:'queue', content:[{type:'text',text}] })`。
- 成功写 `schedule.json`（`{ version:1, lastWakeAt, lastWakeDay, lastAction:'wake', lastSessionId }`）；
  失败记日志、保留状态，下个 tick 按 `minGapMinutes` 重试。
- 叫醒词（`lib/prompt.mjs`）必须包含：身份（persona）、到期信息、素材路径、CLI 绝对路径、
  五步流程（status→选题→plan/storyboard→render→review→publish-dry）、红线、投稿策略
  （`allowGo` 关闭时明确写"本轮只做 dry 投稿包，不要 --go"）、汇报路径（`last-report.md`）、
  "今天不想做也可以，写日记说明原因，不算偷懒"。
- `POST /wake` 与 `faship_wake` 复用同一投递函数。

---

## 8. 设置页（`client.js`）契约

- 自注册：`window.__ModuleLoader__.load({ id:"dsh-bili-faship", factory:(require)=>{...} })`，
  `require('react')`；导出 `inject = ["slots"]`、`apply(ctx)`。
- `ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register(
    { name:"settings.section", id:"bili-faship", order:7, label:()=>"视频工坊" }, Section)))`
- API base `/dsh-bili-faship/api`；`jget/jpost` 必须检查 `res.ok`（抄 dsh-bili-scroll 的 asJson）。
- 数据驱动 `FIELDS`（`{group,path,label,hint,kind:text|number|switch|select|list|range}`）；保存提交整份配置。
- 界面分区：**状态卡**（到期/上次发布/待发/任务/依赖）、**节奏**、**发布与红线**、**声音**、
  **渲染与路径**、**人物与素材**、**凭据**、**视频列表**（封面预览 + 播放链接 + 展开 review 摘要）。
- 按钮：保存 / 依赖体检 / 重新读取 / 现在做一条（POST /wake，二次确认）/ 渲染选中视频 / 生成投稿包（dry）/
  允许真发（switch，danger 样式 + 二次确认）。
- 样式用 DSH 主题 CSS 变量（`--dsw-alias-*`），只注入一个 `<style>`，类名前缀 `bf-`。
- 不允许出现"真发"一键且无确认的入口。

---

## 9. 测试与自检（必须全绿）

- `node --test "tests/*.test.mjs"`：当前 **131 项全绿**（管线 51：原项目 46 项等价移植 + 2 项新契约 + 3 项 publish.tags/titlePrefix；宿主 38；设置页 26；包清单 13）。
- `node selfcheck.mjs`：假 ctx 跑 `apply()`（工具注册数、路由注册数、scheduler 不启动但对象存在），
  假 `window.__ModuleLoader__` + 假 React 跑 client factory（能 apply、能注册 section）。
- `node tools/bili-faship.mjs --help` / `status --json` 可跑。
- 冒烟渲染：320×180 小片（真实 TTS/ffmpeg/Python），时间允许时由 Lead 统一跑；
  单测里**不联网、不真渲染**。
- 真投稿一律不测。

---

## 10. 参考文件（先读再写）

- 原项目：`D:/agent_train/bili-faship/`（HANDOFF.md、README.md、docs/、tools/、tests/）
- 设置页/生物钟/信任栅栏/依赖体检/node 运行时：
  `C:/Users/zcr/.dsh/plugins/dsh-bili-whale/lib/{index.js,client.js,scheduler.js,session-delivery.js,node-runtime.js}`、
  `tools/lib/{runtime.mjs,config.mjs,paths.mjs,traffic.mjs}`
- 工具注册/宿主依赖/自检/打包：
  `C:/Users/zcr/.dsh/profiles/desktop/node_modules/dsh-bili-scroll/{index.js,client.js,selfcheck.mjs,package.json}`、
  `lib/hostdeps.mjs`
- DSH 版本：0.2.2-rc.1（桌面版 profile `desktop`）

---

## 11. 禁止事项

- 不改 `D:/agent_train/bili-faship`、不改 `C:/Users/zcr/.dsh/plugins/dsh-bili-whale`。
- 不动 `C:/Users/zcr/.dsh/profiles/desktop` 里的任何文件（安装由 Lead 统一做）。
- 不真投稿、不真发评论/私信、不刷量。
- 不把 cookie / 密钥写进仓库或日志。
- 不在 1080p 全片渲染上耗时间；冒烟用 320×180。
- 不新增 npm 运行时依赖（除 optional peer 兜底）；管线保持零依赖（只用 Node 内置 + 系统 ffmpeg/Python）。
