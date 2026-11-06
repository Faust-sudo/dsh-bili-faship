# 插件内部结构（给维护者看）

> 这份文件讲**代码怎么组织、为什么这样组织、坏了怎么查**。
> 使用说明见 [`../README.md`](../README.md)；接口与路径契约见 [`../DESIGN.md`](../DESIGN.md)。

## 1. 一眼看清：五个部分

```
dsh-bili-faship/
  index.js                 宿主入口：信任栅栏 → 路由 → 后台任务 / 调度
  client.js                设置页半端：「视频工坊」（自注册，浏览器里跑）
  lib/                     宿主侧实现（在 DSH 主进程里跑）
  tools/                   视频管线 + CLI（起真 node 子进程跑，跟宿主解耦）
  prompts/                 叫醒词与做片章程（给 agent 读的提示词，不是代码）
```

为什么要分这五块：

- **宿主（`index.js` + `lib/`）** 只做「编排」：读写配置、体检依赖、起任务、到点叫人、提供 HTTP API。
  它跑在 DSH 主进程（桌面版是 Electron），**不能**在里面跑重活（ffmpeg / 逐帧渲染会卡住 UI）。
- **管线（`tools/`）** 是原独立项目搬过来的纯 Node + Python 代码，**零 npm 依赖**，
  用真 node 子进程跑（`lib/node-runtime.mjs` 探测「真能跑脚本的 node」——Electron 的
  `process.execPath` 跑 `.mjs` 会静默 exit 0，这是 whale 踩过的坑）。
- **设置页（`client.js`）** 是浏览器里跑的独立模块，只能通过 HTTP API 跟宿主说话；
  没有它插件也能用（CLI 仍可用），但有它才像「插件」。
- **提示词（`prompts/`）** 归内容层：叫醒词怎么写、章程怎么定，跟代码解耦，改文案不用动逻辑。

## 2. 宿主侧（`index.js` + `lib/`）

| 文件 | 职责 |
|---|---|
| `index.js` | 插件入口（默认导出 `{ name, inject, apply }`）：注册工具、挂路由、起调度 tick、注册清理 |
| `lib/hostdeps.mjs` | 从宿主树解析 `defineTool`；拿不到就用本地等价实现，**绝不裸 import 炸掉插件** |
| `lib/node-runtime.mjs` / `lib/runtime.mjs` | 找「真 node」：`DSH_NODE` → desktop 运行时目录 → PATH → Electron + `ELECTRON_RUN_AS_NODE` 兜底 |
| `lib/config.mjs` | 宿主侧配置：读 / 合并 / 校验 / 写；唯一真相仍是 `tools/lib/video-config.mjs` 的 `VIDEO_DEFAULTS` |
| `lib/dirs.mjs` | 插件家目录（`<DSH_HOME>/bili-faship`）下的 jobs / schedule / report / workDir 路径 |
| `lib/deps.mjs` | 依赖体检（必需：node / ffmpeg / Python+Pillow / BGM+SFX / 数据目录可写；可选：表情包 / 字体 / cookie / 日记） |
| `lib/jobs.mjs` | 长任务队列：起子进程、写日志、状态机、重入保护 |
| `lib/status.mjs` | 「现在什么状态」的唯一口径（管线状态 + 视频列表 + 生物钟原因 + 汇报），设置页 / 工具 / 调度共用 |
| `lib/scheduler.mjs` | 生物钟：每 60s tick，条件全满足 → `sessionController.prompt` |
| `lib/prompt.mjs` | 叫醒词生成（对应 `prompts/wake.md`） |
| `lib/tools.mjs` | `faship_*` 工具注册（DESIGN §6 的九个 + 只读的 `faship_config`） |
| `lib/api.mjs` | HTTP API 的业务实现 + 路由分发（`index.js` 只挂一条 prefix 路由） |

### 路由

API 前缀 `/dsh-bili-faship/api`，见 `DESIGN.md` §5。`index.js` 只注册一条 `kind:"prefix"` 的路由，
具体分发在 `lib/api.mjs`。要点：

- **每一个**请求（包括 GET）先过 `connection.requestRejection` 信任栅栏，fail-closed；只接受本机回环。
- 失败统一 `{ ok:false, error }`；参数错误 400、找不到 404、没权限 403、冲突 409、不可用 503。
- `/media` 只读 `videoRoot()` 内的**白名单文件**（`video.mp4` / `cover.jpg` / `subtitles.srt` /
  `review.json` / `storyboard.json` / `meta.json` …），`dir` 解析后必须落在根内，防路径穿越。
- 凭据（cookie）**只写不读回**：`POST /cookie` 只落盘，不回显、不进日志。

### 后台任务（`lib/jobs.mjs`）

- 动作：`render` / `publish-go`（`plan` / `review` / `publish-dry` 是同步的）。
- 一个动作同时在跑 → `409 { ok:false, error:"已有任务在跑" }`。
- 日志：`<DSH_HOME>/bili-faship/jobs/<jobId>.log`；状态：`jobs.json`（`running / done / failed / interrupted`）。
- 进程退出码非 0 或写文件失败 → `failed`，**不会**把半成品当成成功。
- 插件停用 / DSH 退出时，`effect` 的清理函数负责收尾（残留的 `running` 标成 `interrupted`）。

### 生物钟（`lib/scheduler.mjs`）

- 每 60 秒 tick；`ctx.get('sessionController')` **懒取**，拿不到就显示「不可用」，不报错、不崩溃。
- 条件全满足才叫醒（详见 `DESIGN.md` §7）；叫醒 = `create` 会话（失败就复用已有会话）→ `prompt({ mode:"queue" })`。
- 成功写 `schedule.json`，失败保留状态、下个 tick 按 `minGapMinutes` 重试，**不会**一失败就疯狂重投。
- `POST /wake` 与 `faship_wake` 复用同一个投递函数，不等窗口。

## 3. 设置页（`client.js`）

- 自注册：`window.__ModuleLoader__.load({ id:"dsh-bili-faship", factory })`，`require('react')`。
- 导出 `inject = ["slots"]` 与 `apply(ctx)`；用
  `ctx.slots.inject("settings.section", () => ctx.slots.register({...}, Section))` 挂到设置页。
- 数据驱动表单 `FIELDS`（`{ group, path, label, hint, kind }`），保存时提交**整份配置**，
  未显示字段原样保留（所以不会因为页面没画某个字段就把它冲掉）。
- 所有请求都检查 `res.ok` 和 `body.ok`，失败在页面上显示错误，**不静默成功**。
- 样式只用 DSH 主题 CSS 变量（`--dsw-alias-*`），类名前缀 `bf-`，只注入一个 `<style>`。
- 「允许真发」是 danger 开关，打开前二次确认；页面上**没有**任何「无确认一键真发」的入口。

## 4. 视频管线（`tools/`）

```
tools/bili-faship.mjs          CLI 入口（plan/render/review/publish/status/deps）
tools/commands/video.mjs       子命令分发 + 人类可读输出
tools/lib/                     通用件：paths / video-config / config / cred / traffic / ffmpeg / capture / deps
tools/video/
  tts.mjs                      纯 Node Edge TTS（免费、无 key、零依赖）
  storyboard.mjs               schema v4 校验 / normalize / plan 模板
  render.mjs                   TTS → 时间轴/字幕 → Python 渲染 → 混音 → 合成（原子落盘）
  review.mjs                   7 项硬闸门 + 软检查 + 0–100 分
  publish.mjs                  dry 投稿包 / go 真发（B 站 web 上传流程 + 请求保护层）
  renderer/{lib,cards,render}.py   逐帧渲染（Pillow）
  assets/{bgm,sfx}/            CC0 程序合成音频（附 LICENSE / 生成脚本）
```

- **路径**全部从 `tools/lib/paths.mjs` / `video-config.mjs` 取，不在别处硬编码 `.dsh`（这是旧代码踩过的分叉坑）。
- **配置**唯一真相是 `VIDEO_DEFAULTS`；宿主写配置后会调 `resetVideoConfig()` 让缓存失效。
- **单测**（`tests/video-*.test.mjs`）不联网、临时目录、mock transport；真实投稿一律不测。

## 5. 数据与状态

| 文件 / 目录 | 写的人 | 用途 |
|---|---|---|
| `<DSH_HOME>/bili-faship.config.json` | 宿主（设置页保存） | 用户配置（`{version, video:{...}}`） |
| `<DSH_HOME>/bili-faship/videos/` | 管线 | 成片根目录（`outDir` 可改） |
| `<videoRoot>/<slug>/` | 管线 | 单条视频的工作目录（storyboard + 产物 + review + publish） |
| `<videoRoot>/index.json` | 管线 | 发布账本（频率闸的唯一依据） |
| `<DSH_HOME>/bili-faship/jobs/` | 宿主 | 任务日志与状态 |
| `<DSH_HOME>/bili-faship/schedule.json` | 调度 | 上次叫醒时间 / 日期 / 会话 |
| `<DSH_HOME>/bili-faship/last-report.md` | agent 那一轮 | 给主人看的最后汇报 |
| `<DSH_HOME>/faship-work/` | 叫醒会话 | 那一轮的 cwd（不用主目录） |
| `<HOME>/.bili-ai/credentials.json` | 设置页 / 用户 | 投稿 cookie（与 whale 共用格式） |

## 6. 借鉴了 whale / scroll 什么

| 来源 | 借的做法 | 为什么 |
|---|---|---|
| **dsh-bili-whale** | 生物钟「窗口 + 冷却 + 今天没叫过」的判据、设置页数据驱动表单、DSH 信任栅栏、依赖体检输出形状、node 运行时探测 | 这些是在真实使用里磨出来的；重写一遍只会再踩一遍坑 |
| **dsh-bili-scroll** | `defineTool` 注册与宿主依赖解析（`lib/hostdeps.mjs` 思路）、`selfcheck.mjs` 预检形态、`package.json` / bundle patch 打包规范、`safe()` 式 lossless JSON 返回 | 打包与预检规范是从「重启才知道错」里长出来的 |
| **原 `bili-faship`** | 整条视频管线（storyboard / 渲染 / 自审 / 投稿）与 46 项单测 | 同一作者，直接移植并改成插件路径 |

**没有借的**：whale 的评论 / 私信 / 直播能力、scroll 的 Python MCP 依赖 —— 本插件不需要它们，
保持**零 npm 运行时依赖**、管线只用 Node 内置 + 系统 ffmpeg / Python。

## 7. 故障排查

### 插件没激活（日志一句 `1 entry did not activate`）

1. 看 DSH 日志里的**具体报错**：多半是 `index.js` 顶层 import 失败，或 `defineTool` 参数 schema 不合法。
2. 跑 `node selfcheck.mjs`（假 ctx 真调 `apply()`），能复现的这里都会炸出来。
3. 确认 profile 的 `dsh.profile.bundles` 里**有** `dsh-bili-faship`，且 `cordis.patch.yml` 的 `name:` 与包名一致。

### 设置页里没有「视频工坊」/ 404

- 没重启 DSH（bundle 层要重启才组装）。
- 包名 / patch `name:` 不一致 → 表现为「装上了但 404」。
- 打开浏览器开发者工具看 `/dsh-bili-faship/api/settings` 是否 404：是 → 宿主半端没挂上；
  是 500 → 看宿主日志里的栈（多半是配置读不出来或路径不对）。
- `client.js` 的 `window.__ModuleLoader__.load({ id })` 必须等于 `package.json` 的 `name`。

### 依赖体检红 / 渲染失败

| 症状 | 先查 |
|---|---|
| `ffmpeg` 找不到 | `where ffmpeg`；或设置页填绝对路径 / `FFMPEG` env |
| `Python + Pillow` 红 | `python -c "import PIL"`；或 `WHALE_PYTHON` 指向正确的解释器 |
| 表情包目录为空 | 默认路径 `~/.dsh/bili-whale/stickers/packs/大肥鱼` 是否存在；设置页改 `video.paths.stickers` |
| TTS 没声音 / 渲染卡住 | Edge TTS 要联网；断网会失败（不会静默出无声片） |
| 字幕覆盖不足 | 旁白太短或标点太少；加长句子 / 补标点 |
| 响度不在范围 | 混音参数变了；看 `review.json` 里的实测值 |

### 任务卡住 / 「已有任务在跑」

- `GET /dsh-bili-faship/api/jobs`（或 `faship_job`）看状态与日志尾部；
- 真正卡死时：等子进程超时（jobs 有超时），或重启 DSH —— 重启后残留的 `running` 会被标成 `interrupted`；
- 任务在跑时生物钟**不会**叫醒（`job-running`），这是故意的。

### 生物钟不叫醒

设置页状态卡的 `schedule.reason` 会直接告诉你原因：
`disabled`（总开关关）/ `schedule-off`（生物钟关）/ `out-of-window`（不在窗口）/ `not-due`（没到期）/
`already-woke-today`（今天已经叫过）/ `cooldown`（离上次太近）/ `job-running`（有任务在跑）/
`due`（该醒但没醒 → 看日志里 `sessionController` 是否拿不到）。
`POST /wake` 可以绕过窗口立刻投一次，用来验证链路。

### 发布被拒

错误码表与「先看什么」见 [`video-publish.md`](video-publish.md) 的「排错速查」。
最常见的三个：`REVIEW_NOT_PASSED`（先跑 review）、`CADENCE`（没到频率）、`AUTH_MISSING`（cookie 不全）。
撞到 `RISK_BLOCKED` / 601：**停**，人工去创作中心处理，不要重试。
