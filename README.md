# dsh-bili-faship ｜ 鲸鱼娘视频工坊

> **先看三行**
> - 这是 DSH 插件：给「鲸鱼娘 / 大肥鱼」装一条**自己会做 B 站视频**的流水线 ——
>   自己构思 → 写 storyboard → 配音 / 逐帧渲染 → 代码自审 → 出投稿包。**真投稿默认关着**。
> - 推荐用 DSH 插件管理器装（本地目录 → 自动启用；桌面版带 HMR 时**立即生效**，没有 HMR 就重启一次）。
>   装好进 **设置 → 视频工坊**。
> - 撞到 B 站风控（412 / 429 / **601**）就**停**：不自动重试，也不替你绕过验证码。首次真发卡在 601 的完整记录见
>   [`docs/video-publish.md`](docs/video-publish.md)。

---

## 它是什么

一段「个人运营号」的自动化：插件里的生物钟每隔几天把她叫醒一次，那一轮 agent
从日记和偏好里挑一个题目，写成 **storyboard v4**（十来场的小剧本），
调 Edge TTS 配音、用 Python 逐帧画出画面（深海蓝背景 / 角色 / 卡片 / 大字 / 印章 / 胶囊字幕），
混上 BGM 和音效，产出 `video.mp4` + `cover.jpg` + `subtitles.srt`；
再用**代码**跑 7 项硬闸门自审，过了才生成投稿包（`--dry`）；真发（`--go`）另加两道开关。

v0.2 起，每次「做一条」都是一个**工单**：有 id、有目录、有会话、有阶段、有时间线；
「为什么今天做 / 为什么没做」落一条准入记录；失败有看门狗和重试；做不下去的、等你拍板的，
集中显示在设置页顶部的「**待你处理**」里。结构借鉴了 DeepSeek 官方研究原型
`dsh-superagent-prototype`（详见 [`docs/SUPERAGENT-NOTES.md`](docs/SUPERAGENT-NOTES.md)）。

能力边界（它**不会**做什么）：

- ❌ 不会替你做账号安全设置、不会关注/三连/投币/花钱、不会群发私信
- ❌ 不会刷量、不会搬运、不会冒充真人
- ❌ 不会自动重试风控、不会绕验证码
- ❌ 不会在你没显式打开「允许真发」时投稿

## 它和 dsh-bili-whale / 原 bili-faship 是什么关系

| 名字 | 是什么 | 现状 |
|---|---|---|
| **原独立项目 `D:/agent_train/bili-faship`** | 视频创作流水线（plan→render→review→publish）最早住的地方；`tools/**` 与部分文档由它移植而来 | **只读参考**，不再往里加东西 |
| **`dsh-bili-whale`** | 她的「日常」插件：按生物钟刷 B 站、写两本日记、@ 主人 | 独立插件，本插件**代码零依赖**它；只沿用它的家目录约定（共享表情包 / ffmpeg / cookie 位置） |
| **本插件 `dsh-bili-faship`** | 把视频能力正式做成 DSH 插件：设置页 + 生物钟 + `faship_*` 工具 + 完整视频管线 | 你现在装的这个 |

简单说：**whale 管「看和说」，faship 管「做和发」**；两本日记是 faship 最重要的素材来源。

## 装之前（30 秒确认）

| 要什么 | 必须？ | 说明 |
|---|---|---|
| **DSH ≥ `0.1.7-rc.1`**（桌面版 0.2.x 亦可） | ✅ | 插件按 bundle patch 挂载；桌面版默认开 HMR，装完即可用（没开 HMR 要重启一次） |
| **Node 18+** | ✅ | 宿主会探测「真能跑脚本的 node」；Electron 的 `process.execPath` 不能直接跑脚本 |
| **ffmpeg** | ✅ | 走 `FFMPEG` env → PATH → 插件 `bin/` → `~/.dsh/bili-whale/bin` → 剪映自带 |
| **Python 3 + Pillow** | ✅ | 逐帧渲染用；`python -c "import PIL"` 能过即可，可用 `WHALE_PYTHON` / 设置页指定 |
| **BGM / SFX** | ✅ | 已随包（CC0 程序合成），不用另下 |
| **数据目录可写** | ✅ | 视频根目录 + 任务目录（`<DSH_HOME>/bili-faship`）要能写 |
| **她的表情包** | ⬜ 缺失只 warn | 默认找 `~/.dsh/bili-whale/stickers/packs/大肥鱼`，设置页可改 |
| **中文字体** | ⬜ 缺失只 warn | Windows 自带雅黑/行楷/舒体；非 Windows 会退化 |
| **投稿 cookie** | ⬜ 只有真发要 | `~/.bili-ai/credentials.json`（`SESSDATA` / `bili_jct` / `buvid3`），从设置页粘贴写入 |
| **两本日记** | ⬜ 缺失只 warn | 默认 `D:/bilibili-scroll/bili_whale/whale-diary.md` + `whale-diary-private.md` |

> ⚠️ 材质（表情包 / 角色形象）**不随插件分发**；请自行确认你有权使用本机那份素材。

## 装

**推荐：用 DSH 自带的插件管理器装本地目录**（会自动启用 + 写进 profile 的 bundle 列表；
桌面版带 HMR 时立即生效，没有 HMR 就重启一次）：

- 图形界面：**设置 → 插件 → 添加插件 → 从本地目录安装**，选 `D:\Agent\skills\chajian\dsh-bili-faship`；
- 或者对 DSH 里的 agent 说「把 `D:\Agent\skills\chajian\dsh-bili-faship` 装成插件」，
  它会调 `plugin_manager` 的 `install_bundle`（target 传绝对路径）。

**手动/CLI 装法**（等价，适合没开插件管理器或想完全手动的情况）：

```bash
# 1) 把包装进 profile（link 到源码目录；Windows 路径带引号更稳）
dsh plugin --profile desktop add "link:D:\Agent\skills\chajian\dsh-bili-faship"

# 2) 打开 C:\Users\zcr\.dsh\profiles\desktop\package.json，
#    把 "dsh-bili-faship" 加进 dsh.profile.bundles（建议放最后）
# 3) 重启一次 DSH
```

装好后进 **设置 → 视频工坊**（如果没出现，刷新一下页面；再没有就重启 DSH）。

> ⚠️ 包里 `cordis.patch.yml` 的 `name:` 必须与安装后的**包名**一致（`dsh-bili-faship`），
> 否则表现为「装上了但设置页 404 / entry did not activate」。

## 第一次用（四步）

1. **依赖体检** —— 设置页点「依赖体检」（或跑 `node tools/bili-faship.mjs deps --json`）。
   硬依赖（node / ffmpeg / Python+Pillow / BGM+音效 / 数据目录可写）全绿再往下走；
   表情包 / 中文字体 / cookie / 日记缺失只提示，不挡路。
2. **粘贴 cookie** —— 只有真发需要：浏览器登录 B 站 → F12 → Application/存储里抄
   `SESSDATA`、`bili_jct`、`buvid3` 三项，粘进设置页「凭据」分区按保存。
   **只写不读回**：保存后页面不会再显示它们，日志与报错里也不会有。
3. **确认素材路径** —— 「渲染与路径」分区里填表情包目录、缓存目录、Python、ffmpeg 的绝对路径（留空走默认链）。
   「人物与素材」里确认笔名、称呼和她要读的日记文件。
4. **先做一条 dry 的** —— 设置页点「现在做一条」（会二次确认），或者直接跑 CLI：

   ```bash
   node tools/bili-faship.mjs plan --dir D:\videos\demo --topic "第一天，站在中间"
   # 改 storyboard.json 的 scenes，然后：
   node tools/bili-faship.mjs render --dir D:\videos\demo
   node tools/bili-faship.mjs review --dir D:\videos\demo
   node tools/bili-faship.mjs publish --dir D:\videos\demo --dry
   ```

   dry 只生成 `<dir>/publish.json` 投稿包，**不联网**。

## 设置页（设置 → 视频工坊）

- **状态卡**：今天到不到期、上次发布、待发片单、最近任务、调度原因。
- **待你处理**（v0.2）：需要人才能继续的工单（投递失败 / 受阻 / 失败 / 等你审阅），每项带「重试 / 我知道了」；
  没有需要处理的时候整块隐藏。
- **工单**（v0.2）：最近工单的阶段标签、尝试次数、目录，展开看时间线。
- **准入**（v0.2）：今天建了几个工单 / 上限、最近一次 accept / reject 的原因。
- **节奏**：总开关、生物钟开关、允许叫醒的窗口（`HH:MM`–`HH:MM`）、几天一条（`cadenceDays`）。
- **发布与红线**：投稿开关、分区（`tid`，默认 138 生活·日常）、默认 dry、附加标签、标题前缀、
  自审分数线 / 字幕覆盖 / 响度范围 / 引用单段上限、红线词表；
  **「允许真发」是 danger 开关，打开要二次确认**（打开后也还要调用方显式 `confirm`）。
- **声音**：Edge TTS 音色 / 语速 / 音高（默认 `zh-CN-XiaoyiNeural` / `+8%` / `+8Hz`）。
- **渲染与路径**：`outDir`、表情包、缓存、python、ffmpeg。
- **人物与素材**：角色名 / 怎么称呼主人 / 自称，日记文件列表、额外素材。
- **凭据**：`SESSDATA` / `bili_jct` / `buvid3`（只写不读回）。
- **视频列表**：封面预览、点开播放、展开看 `review.json` 摘要与发布状态。
- 按钮：保存 / 依赖体检 / 重新读取 / 现在做一条（二次确认）。

v0.2 新增的 7 项设置（分在「节奏」和「工单与看门狗」两组）：
`tickets.maxPerDay`（每天最多几个工单，默认 2）、`worker.sessionMode`（`per-ticket`（默认）/ `persistent`）、
`admission.observeOnly`（观察模式，见下）、`worker.autoRetry.enabled`、`worker.autoRetry.maxAttempts`、
`watchdog.enabled`、`watchdog.maxJobMinutes`。

配置写在 `<DSH_HOME>/bili-faship.config.json`（`DSH_HOME` 默认 `~/.dsh`），
形状 `{ "version": 1, "video": { ... } }`。设置页保存的是**整份合并后的配置**，未显示字段原样保留。

## CLI（`node tools/bili-faship.mjs <sub>`）

五个创作命令 + 一个体检：

| 命令 | 作用 |
|---|---|
| `plan --dir <dir> [--topic <主题>] [--width 320 --height 180 --fps 15] [--json]` | 生成 / 校验 `<dir>/storyboard.json`（已存在只校验，不覆盖） |
| `render --dir <dir> [--json]` | TTS → 时间轴 / 字幕 → 逐帧渲染 → 混音 → `video.mp4` / `cover.jpg` / `subtitles.srt` / `timing.json` / `meta.json`；失败非 0，不留半成品 |
| `review --dir <dir> [--json]` | 7 项硬闸门自审，写 `review.json`；exit 0 = pass |
| `publish --dir <dir> [--dry\|--go] [--json]` | 默认 `--dry` 只出投稿包、不联网；`--go` 才真发（自审 pass + 频率闸 + 双重开关） |
| `status [--json]` | 最近发布 / 下次到期 / 待发（自审 pass 未发） |
| `deps [--json]` | 依赖体检：node / ffmpeg / Python+Pillow / 表情包 / 字体 / BGM / cookie / 日记 |

`--dir` 省略时 `plan` 会按 `--topic` 生成 slug 落到 `<视频根>/<slug>`。
小尺寸（320×180）只用于**快速验证整条链路**，正式成片请改回 1920×1080。

## Agent 工具（`faship_*`）

| 工具 | 参数 | 返回 |
|---|---|---|
| `faship_status` | `{}` | 到期 / 上次发布 / 待发 / 调度原因 / 最近任务 / 上次汇报 / `needsAttention` |
| `faship_tickets` | `{}` | 工单列表（阶段 / 尝试次数 / attention）+ 准入摘要（v0.2） |
| `faship_report` | `{ ticket, status, note? }` | 结构化报告：`progress/waiting/ready/blocked/failed/dropped`（v0.2） |
| `faship_ticket_action` | `{ id, action:"retry"\|"ack"\|"stop" }` | 重试 / 我知道了 / 停止（v0.2） |
| `faship_deps` | `{}` | 依赖体检（硬依赖 + 软素材） |
| `faship_videos` | `{}` | 视频列表（封面/自审/发布状态） |
| `faship_plan` | `{ topic, dir?, width?, height?, fps? }` | `{ ok, dir, file, created, errors, warnings }` |
| `faship_render` | `{ dir }` | 启动后台渲染任务 `{ ok, job }` |
| `faship_review` | `{ dir }` | 同步自审（≤90s）`{ pass, score, reviewPath, checks }` |
| `faship_publish` | `{ dir, mode:"dry"\|"go", confirm? }` | dry 同步出投稿包；go 只启动后台任务（三重闸） |
| `faship_job` | `{ id? }` | 任务状态 + 日志尾部（≤4000 字符）；不传 id 列最近任务 |
| `faship_wake` | `{ force: true }` | 立刻建一个手动工单并派工（`force` 防误触） |
| `faship_config` | `{}` | 只读当前配置（改配置走设置页） |

工具注册失败只记日志，**不连累插件激活**；`defineTool` 从宿主树解析，拿不到就用本地等价实现。

## 生物钟怎么工作：准入 → 工单 → 派工 → 报告

`lib/scheduler.mjs` 每 **60 秒** tick 一次，每次 tick 做三件事（顺序固定）：

1. **看门狗**：检查正在跑的后台任务有没有超时 / 长时间没日志（见下）；
2. **自动重试**：给满足条件的失败工单再派一次工（见下）；
3. **准入 → 派工**：判断现在该不该建新工单，该就建并投递叫醒词。

**准入（admission）是确定性的，不调 LLM**，按顺序检查，第一条失败就是拒绝原因：

1. 总开关 `video.enabled` 关 → `disabled`
2. 自动触发时 `schedule.enabled` 关 → `schedule-off`
3. 投稿索引 `<videoRoot>/index.json` 损坏 → `index-corrupt`（不在坏账本上自动开工）
4. 已有后台任务在跑 → `job-running`
5. 已有开放工单在 `working/*` → `ticket-working`
6. 今天工单数 ≥ `tickets.maxPerDay`（默认 2）→ `daily-limit`
7. 自动触发且未到期 → `not-due`
8. 自动触发且不在 `schedule.window` 窗口内 → `out-of-window`
9. 自动触发且距上次叫醒 < `schedule.cooldownHours`（默认 30 小时）→ `cooldown`

通过 → 建工单（自动触发 = `inferred`，手动 = `explicit`）→ **派工**（见下）。
每次 accept、每次手动触发、以及「到期却因窗口/冷却/限额没做」都会写一条准入记录；
**完全没到期的 tick 不记录**（安静）。

**派工（Assignment）** = 往会话投递一次叫醒词。两种模式（`worker.sessionMode`）：

- **`per-ticket`（v0.2 默认）**：会话 id = `bili-faship-<short>`，cwd = **该工单目录**。
  每条片一个干净上下文；记忆走文件（日记 / 报告 / 工单历史），不靠会话长大。
- **`persistent`**：沿用 v0.1 的固定会话 `bili-faship` + `<DSH_HOME>/faship-work`。

投递成功 → `dispatched` 事件 + `attempts += 1`；投递失败 → 「待你处理」里的 `delivery-failed`，下个 tick 重试。
叫醒词里带着 **Mandate**（为什么允许做、basis、observeOnly）、工单目录、素材与上次汇报、
流程五步、红线、投稿策略、**结构化报告要求（用 `faship_report`）**，以及「今天不想做也可以」；
如果是重试/宿主重启，还会带**恢复说明**：先检查目录，别重复已经做完的步骤。

**报告**：worker 干完（或停下）必须调一次
`faship_report { ticket, status, note? }`，status 只认六个值：

| status | 含义 | 宿主据此做什么 |
|---|---|---|
| `progress` | 还在做 / 阶段性进展 | 保持 `working/running` |
| `waiting` | 这一轮做完了，等下一次触发 | `idle` |
| `ready` | 成片 + 自审 pass + dry 投稿包就绪 | `person/review`（等你决定发不发） |
| `blocked` | 被卡住（含 601 / 风控） | `person/blocked` + attention |
| `failed` | 这一轮失败 | `person/failed` + attention |
| `dropped` | 这件事不用做了 | 直接结案 `done/dropped`（不发消息） |

## 工单、待你处理、观察模式与看门狗

**工单阶段**（`stage`）由宿主从证据推导，客户端只显示；从上往下第一个匹配的行生效：

| 阶段 | 条件 | 面板标签 |
|---|---|---|
| `person/delivery` | 叫醒投递失败且还没重试成功 | 待你处理（投递失败） |
| `person/blocked` | 有 attention（report=blocked 或 601/风控） | 受阻，等你 |
| `person/failed` | 最近 report=failed，或任务失败且自动重试用尽 | 失败，等你 |
| `person/review` | 有 `review.pass=true` 的成片 + dry 投稿包，还没发布 | 等你审阅 / 决定发布 |
| `working/queued` | 工单开放但还没派工 | 排队中 |
| `working/running` | 已派工（会话在跑）或该工单的任务在跑 | 制作中 |
| `idle` | report=waiting，或这一轮结束、没在等任何人 | 等下一次触发 |
| `done/*` | `published` / `dropped` / `stopped` / `failed` | 已发布 / 无需处理 / 已停止 / 已失败 |

`person/*` = **不能无人继续**，这些会出现在「待你处理」；`idle` = 这一轮做完了，等下一次触发。

**「待你处理」** 只放需要人的 attention，按钮按类型给（不是每项都能重试）：

- **重试**（`retry`）：开放工单；清 attention、重新派工（不受窗口/冷却限制，但受「有任务在跑 / 已有工单在做」约束）；
- **我知道了**（`ack`）：清 attention，工单保持开放（适合看完觉得不用管的情况）；
- **停止**（`stop`）：结案 `done/stopped`；工单的任务在跑就先结束它。

常见 attention 与按钮：

| kind | 什么时候出现 | 按钮 |
|---|---|---|
| `delivery-failed` | 叫醒词投递失败 | 重试 / 我知道了 |
| `rate-limited` | 任务日志出现 601 / 412 / 429（B 站风控） | 我知道了 / 停止（**永不自动重试**） |
| `stalled` | 任务卡住、被看门狗结束 | 重试 / 我知道了 |
| `host-restarted` | 宿主重启时工单还在做，状态待确认 | 重试 / 我知道了 |
| `render-failed` / `job-failed` / `publish-failed` | 渲染 / 任务 / 真发失败 | 重试 / 我知道了 |
| `review-failed` | 自审没过（内容问题，**不自动重试**） | 重试（让 agent 改） / 我知道了 |
| `blocked` / `failed` | agent 报告受阻 / 失败 | 重试 / 我知道了 |
| `ready-for-review` | 成片 + 自审 + dry 包都好了，等你决定发布 | 我知道了 |

**看门狗（watchdog）**：每 60 秒 tick 检查每个运行中任务——超过 `watchdog.maxJobMinutes`（默认 40 分钟）
或 `watchdog.idleMinutes`（默认 8 分钟）日志没增长 → 结束子进程、任务标 `failed`、工单挂 `stalled` attention。
宿主启动时还会把 `jobs.json` 里遗留的 `running` 标成 `interrupted`，并给「开放但没在跑」的工单挂
`host-restarted`。

**自动重试**：`worker.autoRetry.enabled`（默认开）只管执行/投递类失败
（`render-failed` / `publish-failed` / `job-failed` / `stalled` / `host-restarted` / `delivery-failed`），
在 `maxAttempts`（默认 2）内按 `backoffMinutes`（默认 10）退避重派；用尽转 `person/failed`。
**`review-failed` 不自动重试**（内容问题）；**601/412/429 永不自动重试**（红线）。

**观察模式（`admission.observeOnly`）**：打开后仍然建工单、仍然叫醒，但 mandate 标 `observeOnly`——
worker 只做「选题 + storyboard 草稿 + 依赖检查 + 计划」，**禁止 render / publish**，
把「如果放开会怎么做」写进汇报。先看它想做什么，再决定放不放权；默认关闭。

**对应工具与接口**：`faship_tickets`（工单 + 阶段 + attention + 准入摘要）、
`faship_report`（结构化报告）、`faship_ticket_action { id, action:"retry"|"ack"|"stop" }`；
HTTP 侧是 `GET /tickets` 与 `POST /tickets`，`GET /status`/`faship_status` 里的 `needsAttention` 一眼就能看出来。

## 红线（代码强制，不是提示词）

1. **AI 生成如实标注**：画面 topbar 右下角 + 投稿简介都必须含「AI 生成」；review 硬闸门校验。
2. **不冒充真人**：「我是真人」类表述直接 FAIL。
3. **不搬运**：引用他人片段必须 `citations` 三要素（UP / 标题 / BV）齐全，且单段 ≤ 3 秒。
4. **不刷量、不群发、不诱导互关**：撞 412 / 429 / 601 立即停，不自动重试、不绕验证码。
5. `review.pass !== true` 不得发布；`publish --go` 在插件层还必须同时满足
   设置里 `autoPublish.allowGo === true`、`autoPublish.dryRun === false`、`publish.enabled` 为真，
   **且**调用方显式 `confirm: true`（工具 / HTTP 双层）。

## ⚠️ 601 风险：不要自动重试

**2026-10-26 00:14**，第一次真实投稿在**预上传**这一步被平台拦下：

```
HTTP 406 · code=601 · 您上传视频过快，请您稍作休息后再继续
detail: {"v_voucher":"voucher_..."}
```

- 按红线**立即停止**：没有分片、没有提交、账号上没有产生任何稿件；
- 判断是**平台风险验证 / 冷却**，不是参数错误（换上传 profile、补 cookie 后仍是 601）；
- 正确做法：**人去创作中心（`https://member.bilibili.com/platform/upload/video/frame`）完成一次验证，
  或者等冷却**，然后再跑 `publish --go`；**不要自动重试、不要绕验证码、不要连点**。
- 插件里所有 go 入口（设置页「允许真发」、`faship_publish`、`POST /jobs`）都带有「显式确认」闸门，
  就是为这一刻准备的。详见 [`docs/video-publish.md`](docs/video-publish.md) 的 601 记录与排错表。

## 数据在哪

| 用途 | 位置（`<DSH_HOME>` 默认 `~/.dsh`） |
|---|---|
| 插件家目录 | `<DSH_HOME>/bili-faship/` |
| 配置文件 | `<DSH_HOME>/bili-faship.config.json`（`BILI_FASHIP_CONFIG` 可覆盖；兼容旧 `BILI_WHALE_CONFIG` 的 `video` 段） |
| 成片根目录 | 配置 `video.outDir`；空 = `<DSH_HOME>/bili-faship/videos` |
| 表情帧缓存 | 配置 `video.paths.cache`；空 = `<DSH_HOME>/bili-faship/cache`（首次渲染几十秒重建，可删） |
| 任务日志 | `<DSH_HOME>/bili-faship/jobs/<jobId>.log` + `jobs.json` |
| 工单与准入记录 | `<DSH_HOME>/bili-faship/tickets.json`（最近 50 个工单 / 50 条准入记录） |
| 调度状态 | `<DSH_HOME>/bili-faship/schedule.json` |
| 最后一次汇报 | `<DSH_HOME>/bili-faship/last-report.md` |
| 叫醒会话工作目录 | `per-ticket` 模式 = 各工单目录；`persistent` 模式 = `<DSH_HOME>/faship-work` |
| 表情包 | 配置 `video.paths.stickers` → `WHALE_STICKER_DIR` → `<DSH_HOME>/bili-whale/stickers/packs/大肥鱼` → `<DSH_HOME>/bili-faship/stickers` |
| 投稿 cookie | `<HOME>/.bili-ai/credentials.json`（**插件只写不读回**） |
| 日记素材 | 配置 `video.materials.diary`（默认 `D:/bilibili-scroll/bili_whale/whale-diary.md` 等） |

## 回滚

**推荐：通过插件管理器移除**（设置 → 插件 → 已安装插件 → `dsh-bili-faship` → 移除；或对 agent 说「移除 dsh-bili-faship」）。

手动方式：

1. 把 `dsh-bili-faship` 从 profile 的 `dsh.profile.bundles` 里**删掉**；
2. `dsh plugin --profile desktop remove dsh-bili-faship`；
3. 如果当前 profile 没开 HMR，**重启一次 DSH**。

数据不会自动删：`<DSH_HOME>/bili-faship`（成片 / 日志 / 调度状态）和配置、cookie 都还在。
想清干净就手动删那两个位置 —— 注意 cookie 文件 `~/.bili-ai/credentials.json` 可能 whale 也在用，
别顺手删掉别人家的凭据。

## 测试与自检

```bash
node selfcheck.mjs                      # 宿主 + 设置页两个半端的预检，退出码 0/1
node --test                             # 管线 + 宿主 + 设置页 + 包清单（自动发现 tests/*.test.mjs）
node --test tests/package.test.mjs      # 只跑包清单/挂载声明
node tools/bili-faship.mjs --help       # CLI 冒烟
node tools/bili-faship.mjs status --json
```

单测**不联网、不真渲染、不真投**；真投稿一律不在开发/测试里执行。

## 已知限制（先看，省得怀疑人生）

- **真投稿链路没跑通**：只到预上传就被 601 拦（见上）。upos 分片 / 封面 / `add/v3` 是按公开协议实现的，
  **真实网络未实测**；接口随时可能变。
- **`citations` 只是元数据 + 标注 + 引用卡**：不会真把别人的片段剪进成片（后续版本的目标）。
- **自审只扫文本 / 数值**，不 OCR 画面；红线词表可配，报错了先看 `review.json.checks`。
- **渲染慢**：1080p 逐帧约 6fps，40 秒片 3–4 分钟；320×180 只是成片缩放，不加速。
- **非 Windows**：字体退化（找不到雅黑/行楷/舒体就退回 Pillow 默认字体），不崩但不好看。
- **一次一条、单机串行**：没有定时批量、多账号、并发发布；工单同时最多一个在 `working/*`。
  请求保护层的保守值是故意的。想看"如果放开会怎么做"用观察模式，不要靠多开。
- **每工单一个会话**：v0.2 默认 `per-ticket`（干净上下文，记忆走文件）；想沿用 v0.1 单会话就把
  `worker.sessionMode` 设成 `persistent`。两种模式都不共享未落盘的上下文。
- **设置页的「允许真发」默认关**：首版刻意这样，确认过 601 状态再打开。

## 许可与致谢

- 代码：**MIT**（见 [`LICENSE`](LICENSE)）。
- 随包 BGM / SFX 为 **CC0** 程序合成；表情包等本地素材**不随包分发**；设计上参考了
  `dsh-bili-whale` 与 `dsh-bili-scroll`。完整说明见 [`NOTICE.md`](NOTICE.md)。
- 内容写作规范和做片章程见 [`prompts/charter.md`](prompts/charter.md)，投稿细节见
  [`docs/video-publish.md`](docs/video-publish.md)，插件内部结构见 [`docs/PLUGIN.md`](docs/PLUGIN.md)。
