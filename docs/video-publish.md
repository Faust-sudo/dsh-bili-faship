# 视频投稿（publish）

> 代码：`tools/video/publish.mjs` · 测试：`tests/video-publish.test.mjs`
> 能力合同：仓库根目录 [`VIDEO-CAPABILITY.md`](../VIDEO-CAPABILITY.md)
> 一句话：自审 `review.json.pass === true` 之后，`--dry` 出投稿包，`--go` 才真发；
> 任何闸门不过 / 风控 / 非 0 code 都**立刻停**，不重试、不发半截稿件。

## 分工

| 谁 | 做什么 |
| --- | --- |
| `tools/video/review.mjs` | 代码自审，写 `<dir>/review.json`（`{pass, score, checks[], reviewedAt}`） |
| `tools/video/publish.mjs` | 复核自审 → 硬闸门 → 组投稿包 →（`--go`）上传视频/封面 → `add/v3` → 记账 |
| `tools/commands/video.mjs` / `tools/bili-faship.mjs` | CLI：`publish --dir <dir> [--dry\|--go] [--json]`，内部调本模块 |
| 插件宿主（`index.js`） | `POST /jobs`、`faship_publish`：在 CLI 之上再加 **allowGo + confirm** 两道闸 |

发布者（鲸鱼娘）只能通过「自审 pass」这一条路走到发布；本模块不再做内容判断，
只守最后一道代码闸门（红线 + 频率 + 字段 + 风控）。

## 用法

### CLI

```bash
# 默认 dry：只生成 <dir>/publish.json 并打印，不联网
node tools/bili-faship.mjs publish --dir "$env:USERPROFILE\.dsh\bili-faship\videos\day0-full-authority"

# 真发：必须显式 --go（没有默认开启这一说）
node tools/bili-faship.mjs publish --dir <dir> --go

# 给 agent / 脚本看的 JSON 输出（stdout 只有最终 JSON）
node tools/bili-faship.mjs publish --dir <dir> --dry --json
```

### 插件里的入口（都会再过两道闸）

| 入口 | 行为 |
|---|---|
| 设置页「生成投稿包（dry）」 | 走 `POST /jobs action:"publish-dry"`，同步出包 |
| 设置页「允许真发」+ 调用 | 是**配置开关**（`autoPublish.allowGo`），只管放开权限，不发请求 |
| `faship_publish { dir, mode:"go", confirm:true }` | 后台任务；要求 `allowGo === true` 且 `confirm === true` |
| `POST /dsh-bili-faship/api/jobs` `{ action:"publish-go", dir, confirm:true }` | 同上；`confirm` 缺失 → 400，`allowGo` 关 → 403，review 未过 → 409 |

真发默认关着：`autoPublish.allowGo` 默认 `false`，`publish --go` 在 CLI 里也没有默认开启的写法。

### 直接函数调用

```js
import { publishVideo } from './tools/video/publish.mjs'

const r = await publishVideo({ dir, mode: 'dry' }) // 或 'go'
// dry → { ok: true, mode: 'dry', package, message }
// go  → { ok: true, mode: 'go', bvid, aid, publishedAt, title, publishFile, indexFile, message }
```

参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `dir` | string | 视频工作目录（必填） |
| `mode` | `'dry' \| 'go'` | 默认 `'dry'`。真发必须显式传 `'go'` |
| `config` | object \| null | video 配置覆盖（测试注入用）；不传则读 `videoConfig()` |
| `json` | boolean | true = 只输出最终 JSON（CLI `--json`） |
| `transport` | Function \| null | fetch 兼容函数（测试 mock）；不传用 `traffic.mjs` 的 `guardedFetch` |

失败一律抛 `PublishError`，带 `err.code`（见下表）。**没有任何静默降级 / 自动重试。**

## 前置条件

`<dir>` 里必须有这 5 个文件（缺一个就拒绝）：

| 文件 | 谁写 | 本模块怎么用 |
| --- | --- | --- |
| `storyboard.json` | `plan` / 手改 | 取 `slug`、`publish.titleForPost / description / tags / aiLabel` |
| `meta.json` | `render` | 取 `durationSec` / 标题兜底（字段宽松，不重复审 schema） |
| `video.mp4` | `render` | 上传的视频（>0 字节） |
| `cover.jpg` | `render` | 上传的封面（>0 字节，JPEG） |
| `review.json` | `review` | **必须 `pass === true`**，否则拒绝 |

## 权限 / 登录态

真发（`--go`）需要登录态：

- 凭据从 `tools/lib/cred.mjs` 的 `loadCred()` 读：`~/.bili-ai/credentials.json`
  （Windows：`%USERPROFILE%\.bili-ai\credentials.json`）
- 需要 **SESSDATA + bili_jct + buvid3** 三个字段；缺哪个会直接报「缺少写操作凭据：…」，
  不会拿 `undefined` 去发请求（去设置页「凭据」分区重新粘贴一次 cookie 即可）
- `bili_jct` 同时是 `csrf`：封面 / add/v3 都要带；缺失会回 `code=-111`
- `dry` 模式**不读凭据**（完全可以离线跑）

cookie 只放在请求头里：不出现在 `publish.json`、不出现在 `index.json`、不出现在报错和日志。
设置页写 cookie 时**只写不读回**。

## dry / go 的区别

| | `--dry`（默认） | `--go` |
| --- | --- | --- |
| 网络 | **完全不发**（测试里断言 0 请求） | 走完整 B 站 web 投稿流程 |
| 凭据 | 不需要 | 必须有效（SESSDATA/bili_jct/buvid3） |
| 产出 | `<dir>/publish.json` 投稿包（含预计请求体） | `<dir>/publish.json` 发布记录 + `<videoRoot()>/index.json` 记账 |
| 风控 | 不涉及 | 412/429/601 立即停，不重试 |
| 副作用 | 只写本地文件 | 真实稿件 + 至少一次 120s 写冷却 + 2 次写额度 |

**dry 也会跑全部硬闸门**：自审、媒体、字段、红线、频率、发布开关。
所以 `--dry` 报错 = 现在 `--go` 也发不了，先修；不是「预览随便过」。

## 硬闸门（任一失败 → 拒绝，错误码见括号）

| # | 条件 | 行为 |
| --- | --- | --- |
| 1 | `review.json.pass !== true` 或文件缺失（`REVIEW_NOT_PASSED`） | 拒绝；自审是发布前置条件 |
| 2 | `video.mp4` / `cover.jpg` 不存在、不是文件、0 字节（`MISSING_MEDIA`） | 拒绝 |
| 3 | 标题空 / 超 80 字（`INVALID_TITLE`） | 拒绝 |
| 4 | 简介空 / 超 2000 字（`INVALID_DESC`） | 拒绝 |
| 5 | 标签空 / 超 10 个 / 单个超 20 字（`INVALID_TAGS`） | 拒绝 |
| 6 | 简介没有「AI 生成」标注（`REDLINE_AI_LABEL`，受 `video.redlines.requireAiLabel` 控制，默认 true） | 拒绝；匹配忽略空格（`AI 生成` / `AI生成` 都算） |
| 7 | 简介命中 `video.redlines.bannedWords` 任一（`REDLINE_BANNED`） | 拒绝；报错里点出是哪个词 |
| 8 | 距 `index.json.lastPublishedAt` 不足 `video.cadenceDays` 天（`CADENCE`） | 拒绝，并给出「下次可发」时间 |
| 9 | 同一 `slug` 已发布过（`DUPLICATE_SLUG`） | 拒绝，换 slug（发布记录在 `index.json.videos`） |
| 10 | `index.json` 读不出来 / 不是合法 JSON / 结构不对（`INDEX_CORRUPT`） | **拒绝发布**（不静默当没有记录，否则频率闸会漏算） |
| 11 | `video.publish.enabled === false`（`PUBLISH_DISABLED`） | 拒绝（工具命令仍在，只是发布开关关了） |
| 12 | go 模式缺凭据（`AUTH_MISSING`） | 拒绝，网络请求数为 0 |

附加防御：`video.cadenceDays` / `video.publish.tid` 不合法 → `CONFIG_INVALID`（不猜默认值）。

插件层还有这几道（**只在宿主入口生效**，CLI 不强制）：

| # | 条件 | 行为 |
| --- | --- | --- |
| A | 调用方没传 `confirm: true`（`POST /jobs` 400） | 拒绝；工具 / HTTP 双层都要显式确认 |
| B | `video.autoPublish.allowGo !== true`（`POST /jobs` 403） | 拒绝；设置页「允许真发」默认关 |
| C | `video.publish.enabled === false`（403） | 拒绝；投稿总开关关着 |
| D | `review.json.pass !== true`（409） | 拒绝；工具层再复核一次自审 |
| E | `video.autoPublish.dryRun !== false`（409） | 拒绝；当前策略只做 dry 投稿包 |

## 记账文件

### `<dir>/publish.json`

- dry：投稿包，核心字段
  `{ version, mode:"dry", generatedAt, slug, title, desc, tags, tid, partitionName,
     copyright:1, copyrightLabel:"自制", no_reprint:1, aiLabel, aiLabelInDesc,
     video, videoBytes, cover, coverBytes, durationSec, uploadProfile, review,
     request:{ method, url, body }, steps:[...], network:false }`
  `request.body` 就是 dry 能看到的「预计 add/v3 请求体」（`videos[].filename` / `cid` 用占位符，
  因为要等 preupload 返回才知道；`csrf` 写 `<bili_jct>` 占位）。
- go 成功：
  `{ version, mode:"go", slug, title, desc, tags, tid, copyright, no_reprint, aiLabel,
     bvid, aid, publishedAt, coverUrl, video, cover, review }`
- dry 覆盖一个已经真发过的 `publish.json` 时，旧 `{bvid,aid,publishedAt}` 会保留在 `previous` 里，
  不会因为再跑一次 dry 把发布记录冲掉（真正的权威在 `index.json`）。

### `<videoRoot()>/index.json`（频率闸的唯一依据）

```jsonc
{
  "version": 1,
  "videos": [
    { "slug": "day0-full-authority", "title": "…", "bvid": "BV…", "aid": 123, "publishedAt": "2026-11-06T23:00:00+08:00" }
  ],
  "lastPublishedAt": "2026-11-06T23:00:00+08:00"
}
```

- 只有 `add/v3` 返回 `code=0` 且带 `bvid` 才算成功 → 写 `publish.json` + append `index.json`（temp + rename 原子写）。
- 频率闸以 `lastPublishedAt` 为准（缺失时取 `videos[]` 里最晚的 `publishedAt`）；无记录 = 立刻到期。
- 同一 slug 不重复发。
- 文件损坏 → 拒绝发布（见硬闸门 #10）。
- `status` / `faship_status` 读的就是这份文件（`indexState: "missing"` = 从没发过，`due=true`）。

## 真实投稿流程（`--go`）

所有请求都带浏览器 UA + `referer: https://member.bilibili.com/platform/upload/video/frame`；
`member.bilibili.com` 的请求走 `traffic.mjs` 的 `guardedFetch`（跨进程间隔 / 写冷却 / 写预算 / 412 熔断）。

1. **预上传**（读）
   `GET https://member.bilibili.com/preupload?name=<video.mp4>&size=<字节>&r=upos&profile=ugcfx/bup&ssl=0&version=2.14.0&build=2140000&webVersion=2.14.0`
   → `{ OK:1, auth, biz_id, chunk_size, endpoint, upos_uri, … }`
   （`auth` 有效期 5 天；`upos_uri` 形如 `upos://ugcfx2lf/n2407….mp4`）
2. **初始化分片上传**（upos，POST）
   `POST https:${endpoint}/${upos_uri去 upos://}?uploads=&output=json&profile=ugcfx/bup&filesize=<字节>&partsize=<chunk_size>&biz_id=<biz_id>`
   请求头 `X-Upos-Auth: <auth>` → `{ OK:1, upload_id }`
3. **逐片上传**（upos，PUT，`application/octet-stream`，顺序、不并发）
   `PUT 同地址?partNumber=<1起>&uploadId=<id>&chunk=<0起>&chunks=<总数>&size=<本片字节>&start=<起点>&end=<终点>&total=<总字节>`
   请求头 `X-Upos-Auth`；每片响应纯文本 `MULTIPART_PUT_SUCCESS`
4. **结束上传**（upos，POST）
   `POST 同地址?output=json&name=<video.mp4>&profile=ugcfx/bup&uploadId=<id>&biz_id=<biz_id>`
   body `{ "parts": [ { "partNumber": 1, "eTag": "etag" }, … ] }` → `{ OK:1, location, bucket, key }`
5. **上传封面**（member，POST，`application/x-www-form-urlencoded`）
   `POST https://member.bilibili.com/x/vu/web/cover/up?ts=<ms>`
   body `csrf=<bili_jct>&cover=data:image/jpeg;base64,<cover.jpg 的 base64>` → `{ code:0, data:{ url } }`
6. **提交稿件**（member，POST JSON）
   `POST https://member.bilibili.com/x/vu/web/add/v3?t=<ms>&csrf=<bili_jct>`
   body（要点）：
   ```jsonc
   {
     "videos": [{ "filename": "<upos 文件名（去目录去扩展名）>", "title": "<标题>", "desc": "", "cid": <biz_id> }],
     "cover": "<第 5 步的 url>",
     "title": "<标题>", "desc": "<简介>", "tag": "标签1,标签2",
     "tid": 138, "copyright": 1, "no_reprint": 1,
     "desc_format_id": 9999, "recreate": -1, "dynamic": "",
     "interactive": 0, "act_reserve_create": 0, "no_disturbance": 0,
     "subtitle": { "open": 0, "lan": "" }, "open_subtitle": true,
     "dolby": 0, "lossless_music": 0,
     "up_selection_reply": false, "up_close_reply": false, "up_close_danmu": false,
     "web_os": 3, "csrf": "<bili_jct>"
   }
   ```
   → `{ code:0, data:{ aid, bvid } }`

7. 成功才记账；任何一步失败 → 抛错，**不写发布记录**。

## 失败与风控行为

| 情况 | 行为 |
| --- | --- |
| HTTP **412 / 429**、body `code` 属于 `-412/-352/-799/-509/-10403/601/10031`（`RISK_BLOCKED`） | **立即停止、绝不重试**；报错带「平台原文」与 `HTTP/code`。`guardedFetch` 同时会为整个账号记一段熔断（半小时起，指数退避），期间其它写操作也会被挡 |
| 非 0 `code`（`API_ERROR`） | 立即停止；报错带 `explainCode` 人话 + 平台原文 |
| HTTP 其它非 2xx（`HTTP_ERROR`） | 立即停止；带状态码 + 平台原文 |
| 网络异常（`NETWORK_ERROR`） | 立即停止，不重试 |
| `guardedFetch` 挡下（写冷却 / 写预算 / 412 暂停 / 需人工验证）（`TRAFFIC_BLOCKED`） | 立即停止，错误里说明原因；等冷却再试 |
| 写请求结果不确定（连接断了，可能已发出去）（`WRITE_UNCERTAIN`） | 停止且**禁止自动重发**（`traffic.mjs` 的判重会记住这次操作）；去创作中心人工核对，不要重复提交 |
| 封面上传被平台拒绝 / 返回缺 `data.url`（`COVER_FAILED`） | 停止，不提交稿件（不猜封面地址） |
| 上传初始化 / 分片 / 结束的返回结构不对（`UPLOAD_FAILED`） | 停止，不提交稿件（宁可不发，也不发半截） |
| add/v3 返回 code=0 但没 bvid（`SUBMIT_UNCONFIRMED`） | 停止；提示去创作中心核对，别重复提交 |
| 稿件已发成功但本地 `publish.json`/`index.json` 写失败（`PUBLISH_RECORD_FAILED` / `INDEX_WRITE_FAILED`） | 报错里直接给出 bvid，提示人工把记录补进 `index.json`（否则频率闸会漏算） |

一次 `--go` 的本地请求保护成本（默认 `risk` 配置）：
预上传 = 1 次读；封面 + 提交 = 2 次写（`writeGapSec` 默认 120s → 两步之间至少隔 ~2 分钟）。
upos 分片上传域（`*.bilivideo.com` 等）不在 `traffic.mjs` 的 bilibili.com 白名单里，
不占写额度、不参与判重；但也意味着**分片阶段没有那层保护**，所以本模块：
顺序上传、不并发、失败即停、不重传。

> 首版没有单独的 `traffic status` CLI；保护层的拦截原因会写进任务日志与报错文本
> （`<DSH_HOME>/bili-faship/jobs/<jobId>.log`，或 `faship_job` 返回的日志尾部）。

## AI 标注 / 自制声明（红线）

- `copyright` 固定写 **1（自制）**：AI 生成内容不能标成转载；配置里不开放改这个值（防止手滑）。
- 简介必须含「AI 生成」字样（`AI 生成` / `AI生成` 均可），由 storyboard 的
  `publish.description` 负责写，本模块只做最后校验（缺失 = 拒绝，不自动补）。
- `no_reprint`：默认 1（禁止转载）；配置 `video.publish.noReprint=false` 才写 0。
- 简介里的红线词（`video.redlines.bannedWords`）一票否决；不冒充真人、不刷量、不搬未标注片段由
  `review.mjs` 的自审和本模块的红线词共同守。
- 视频画面上的「本视频含 AI 生成内容」由 renderer 烧进画面；本模块只管简介 + 投稿字段。

## 已知限制 / 未实测（重要）

1. **接口随时可能变**：`preupload` / upos 分片 / `cover/up` / `add/v3` 都是 B 站 web 端接口，
   没有公开承诺。本模块对「返回缺字段 / 形状不对」一律**报错停下**（不猜、不降级）；
   报错里带平台原文，方便对着改。
2. **upos 分片字段未在真实账号实测**：协议按 2026-01 存档的 B 站创作中心文档 + 公开实现整理：
   **PUT + `application/octet-stream` + query 里的 `partNumber/uploadId/chunk/chunks/size/start/end/total`**。
   构造部分有单测锁定，发送部分（真实网络）**未实测**（首次真发只走到预上传就被 601 拦下）。
3. **封面上传格式未实测**：按公开文档用 `x-www-form-urlencoded` 的 `csrf` + `cover=data:image/jpeg;base64,…`。
   如果真发时封面报错，先查这里（报错会停，不会发半截）。
4. **分区 tid**：默认 138（生活·日常）；B 站分区 id 会变，配置 `video.publish.tid` 可改。
   `add/v3` 只认「客户端预测的类型」时可能被平台改分区，属于已知风险。
5. **首次 `--go` 请主人盯着**：第一次真发时人要在创作中心看结果（是否进审核、封面/标题/简介是否正确）。
   之后可以按「自审 pass + 间隔到 + 绿灯」自主发。
6. **不做定时/批量/多账号**：一次一条，频率闸 + 写冷却 + 412 熔断都是保守值，不要并发调用。
7. **分片顺序上传**：大视频会慢（10MB/片、顺序 PUT）；但比并发触发风控更值。
8. `open_subtitle` 与 `subtitle:{open:0}` 同时传（前者按合同要求，后者按文档必填项）；冗余字段由 B 站容错，
   若线上因字段报 -400，优先删 `open_subtitle`。
9. `uploadProfile` 默认 `ugcfx/bup`（合同 + 文档）；若平台改成只收 `ugcupos/bup`（简化档），
   可临时用配置 `video.publish.profile` 覆盖——这条未实测。

## 测试

```bash
# 只跑投稿模块
node --test tests/video-publish.test.mjs

# 全量（在插件根目录跑；自动发现 tests/*.test.mjs）
node --test
```

测试覆盖（全部不联网、假凭据、临时目录、mock transport）：

- review 未过 / review 缺失 → 拒绝
- 视频 / 封面缺失或 0 字节 → 拒绝
- 简介缺「AI 生成」→ 拒绝；命中红线词 → 拒绝
- 标题 / 简介 / 标签字段闸门
- 频率未到 3 天 → 拒绝且给出下次可发时间；到 4 天 → 放行
- 同一 slug 重复发 → 拒绝；`index.json` 损坏 → 拒绝
- `publish.enabled=false` → 拒绝
- dry：**0 网络请求**、`publish.json` 字段齐全（含预计请求体）、不泄漏凭据、不动 index.json
- go：mock transport 走完 preupload → 3 片 → 结束 → 封面 → add/v3，校验请求顺序/query/头/body，
  落盘 `publish.json` + `index.json`
- 提交阶段 412 → 抛 `RISK_BLOCKED`、**不重试**、不写发布记录
- 非 0 code → 抛 `API_ERROR`、不写发布记录
- go 缺凭据 → `AUTH_MISSING` 且 0 网络请求

## 排错速查

| 报错 | 先看什么 |
| --- | --- |
| `REVIEW_NOT_PASSED` | `node tools/bili-faship.mjs review --dir <dir>`，看 `review.json.checks` |
| `MISSING_MEDIA` | render 是否真的成功（`video.mp4` / `cover.jpg` 是否 0 字节） |
| `REDLINE_AI_LABEL` | `storyboard.publish.description` 里补「本视频含 AI 生成内容」 |
| `CADENCE` | 报错里的「下次可发」时间；`status` 看同一份 `index.json` |
| `INDEX_CORRUPT` | 打开 `<videoRoot()>/index.json` 修 JSON（别删，删了频率闸会当成没发过） |
| `TRAFFIC_BLOCKED` | 等写冷却 / 熔断结束；看任务日志尾部，不要连点 |
| `RISK_BLOCKED` | 平台风控：等（半小时起步），别换接口硬顶；先人工在浏览器确认账号状态 |
| `AUTH_MISSING` | 设置页重新粘贴 cookie（SESSDATA + bili_jct + buvid3） |
| `UPLOAD_FAILED` / `COVER_FAILED` | 平台返回原文在报错里；接口可能变了，先别重试，人工确认 |

## 首次真实投稿记录（2026-10-26 00:14）

用 10-25 日记渲染了 42.5 秒的 Day 1（review pass=100，dry 投稿包正常），首次 `--go` 在**预上传**这一步被平台拦下：

```
HTTP 406 · code=601 · 您上传视频过快，请您稍作休息后再继续
detail: {"v_voucher":"voucher_..."}
```

- 已按设计**立即停止、不重试**；没有上传任何分片、没有提交稿件、没有写 `publish.json`/`index.json`（账号上没有产生稿件）
- 判断：601 + `v_voucher` 是平台风险验证（不是参数错误；换上传 profile、补 buvid4/b_nut 后仍返回 601）
- 处理建议：在浏览器打开 `https://member.bilibili.com/platform/upload/video/frame` 用该账号完成一次验证
  （或等风控冷却），然后重新跑 `publish --dir <目录> --go`；**不要自动重试 / 不要绕过验证码**
- 媒体与投稿包已就绪，不需要重新渲染
- 本插件因此默认 `autoPublish.allowGo = false`，并在宿主入口加了 `confirm` 二次闸门
