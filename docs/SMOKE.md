# 视频管线冒烟记录（320×180）

> 目的：验证**插件版**视频管线（`tools/bili-faship.mjs`）在真实 TTS / ffmpeg / Python+Pillow 下
> 跑得通 plan → render → review（→ publish dry），并记录耗时与结论。
>
> 结论：**通过**。320×180 成片 14.46 秒，`review.pass=true` / 评分 100；全过程 45 秒左右。
> 真投稿（`publish --go`）**没有运行**，也不应该在本仓库的开发/测试里运行（DESIGN §11）。

- 日期：2026-11-06
- 执行：视频管线负责人（pipeline）
- 机器：Windows（本机），Node v24.20.0
- 代码：`D:\Agent\skills\chajian\dsh-bili-faship`（本插件）

## 1. 环境

| 依赖 | 实际情况 |
|---|---|
| node | v24.20.0（`D:\APP\nodejs\node.exe`） |
| ffmpeg | 7.1-essentials_build（`C:\Users\zcr\.dsh\bili-whale\bin\ffmpeg.exe`，只读复用） |
| Python | 3.13.12（PATH 里的 `python`） |
| Pillow | 12.2.0 |
| 表情包 | `C:\Users\zcr\.dsh\bili-whale\stickers\packs\大肥鱼`（12 个 GIF，只读复用；渲染器按 11 组情绪键建帧缓存） |
| 字体 | `C:/Windows/Fonts/msyhbd.ttc` |
| BGM/SFX | 插件自带 `tools/video/assets/{bgm,sfx}` |
| TTS | Edge TTS（真实联网，`zh-CN-XiaoyiNeural`） |

## 2. 隔离方式（没碰用户真实数据）

冒烟**不是**在用户真实配置上跑的，全部落在系统临时目录：

```powershell
$tmp = "C:\Users\zcr\AppData\Local\Temp\faship-smoke-20261106-234530"
$env:DSH_HOME          = "$tmp\.dsh"                        # 缓存/日志落到临时目录
$env:BILI_FASHIP_CONFIG = "$tmp\bili-faship.config.json"    # 配置只读这一份
$env:WHALE_STICKER_DIR  = "C:\Users\zcr\.dsh\bili-whale\stickers\packs\大肥鱼"  # 只读复用表情包
# 成片根目录在配置里指向 $tmp\videos
```

- 没有修改 `C:\Users\zcr\.dsh` 下任何东西（冒烟后确认 `C:\Users\zcr\.dsh\bili-faship` 仍不存在）；
- 没有修改原项目 `D:\agent_train\bili-faship`；
- 没有执行 `publish --go`。

临时配置（对比 DESIGN §4 的默认值只改了 3 处，都是为了"小尺寸快跑"）：

```json
{
  "version": 1,
  "video": {
    "minDurationSec": 8,
    "maxDurationSec": 180,
    "outDir": "C:\\Users\\zcr\\AppData\\Local\\Temp\\faship-smoke-20261106-234530\\videos",
    "paths": {
      "ffmpeg": "C:\\Users\\zcr\\.dsh\\bili-whale\\bin\\ffmpeg.exe"
    }
  }
}
```

- `minDurationSec: 8`：默认 15 秒会让 3 场模板最少 15 秒；冒烟只是验证管线，缩短一点少渲染 1/3 的帧。
- `paths.ffmpeg`：因为把 `DSH_HOME` 指到了临时目录，ffmpeg 解析链里"`<DSH_HOME>/bili-whale/bin`"那一步
  自然落空（这是正确行为）。真实使用时 `DSH_HOME` 就是 `C:\Users\zcr\.dsh`，不需要填；
  填它同时也验证了「配置 `video.paths.ffmpeg` 最优先」这条链路。

## 3. 命令与耗时

工作目录 `D:\Agent\skills\chajian\dsh-bili-faship`：

```powershell
node tools/bili-faship.mjs plan   --dir $dir --topic "冒烟测试：320x180 能不能跑通" --width 320 --height 180 --fps 15 --json
node tools/bili-faship.mjs render --dir $dir --json
node tools/bili-faship.mjs review --dir $dir --json
node tools/bili-faship.mjs publish --dir $dir --dry --json
```

| 步骤 | 退出码 | 耗时 | 说明 |
|---|---|---|---|
| `plan` | 0 | 0.13 s | 生成 `storyboard.json`（v4，3 场，320×180@15fps） |
| `render` | 0 | **44.06 s** | 3 段真实 Edge TTS → 时间轴/字幕 → Pillow 逐帧 → ffmpeg 混音/编码 |
| `review` | 0 | 0.25 s | 硬闸门全过：`pass:true` / `score:100` |
| `publish --dry` | 0 | 0.12 s | 只生成投稿包，`network:false`，未联网 |

产物目录：`$tmp\videos\smoke-320x180`

| 文件 | 大小 | 说明 |
|---|---:|---|
| `video.mp4` | 852,986 B | H.264 High / yuv420p / **320×180** / 15 fps / 14.46 s；AAC-LC 48 kHz stereo |
| `cover.jpg` | 14,987 B | 按目标尺寸缩放的封面 |
| `subtitles.srt` | 342 B | 5 条 cue，覆盖 3 场 |
| `timing.json` | 3,213 B | 时间轴（renderer / review 共用） |
| `meta.json` | 1,380 B | 时长/分辨率/音色/BGM/产物清单 |
| `review.json` | 1,528 B | 自审结果（pass=true, score=100） |
| `publish.json` | 3,014 B | dry 投稿包（无凭据、无网络） |

- `video.mp4` sha256：`9F305EC4395ECD3182F94CBCE3A3DF073C3CAEFFAB36E51DDC8B65352B03E1CA`
- 渲染结束后 `<videoDir>` 里**没有** `.work-*` 残留（原子落盘逻辑生效）。

## 4. review 硬闸门结果（全绿）

| 闸门 | 结果 | 详情 |
|---|---|---|
| schema | ✓ | storyboard version 4 · 3 场 |
| duration | ✓ | 成片 14.5 s ∈ [8, 180] s |
| loudness | ✓ | 集成响度 **-16.3 LUFS** ∈ [-20, -12] LUFS（ffmpeg ebur128 实测） |
| aiLabel | ✓ | 画面 topbar.right「本视频含 AI 生成内容」 |
| citations | ✓ | 无引用片段 |
| redline | ✓ | 未出现红线词 / 冒充真人短语 |
| subtitleCoverage | ✓ | 字幕覆盖 **100%（3/3）** |
| artifacts | ✓（软） | meta.json 记录了产物清单 |
| publishMetadata | ✓（软） | 投稿标题/简介已填 |
| scoreLine | ✓（软） | 评分 100 ≥ 附加线 80 |

## 5. 过程中发现的问题 / 结论

1. **第一次 render 失败是预期行为，不是 bug**：在隔离 `DSH_HOME` 的配置里没填 `paths.ffmpeg` 时，
   报错是「找不到 ffmpeg…」并列出 4 条修复建议（配置 / 环境变量 / 安装 / 随包 bin）。
   真实使用（`DSH_HOME` 为默认 `~/.dsh`）时解析链里的 `~/.dsh/bili-whale/bin` 能命中，不需要额外配置。
2. **渲染耗时是"1080p 设计分辨率 + 输出缩放"**：`renderer/render.py` 固定按 1920×1080 绘制，
   320×180 只是 ffmpeg 输出缩放（版式不变）。本次 217 帧 ≈ 44 秒（约 0.2 s/帧），
   也就是说**正式 1080p 一条 60 秒片子要按分钟级预留时间**，宿主 `lib/jobs.mjs` 的异步任务/超时按这个量级设。
3. **TTS 联网成功**：3 段 Edge TTS 全部成功（无本地转写兜底），所以这次冒烟没有"网络失败"这一项。
4. **`publish --dry` 需要内容侧先填标签**：plan 模板的 `publish.tags` 默认是空数组，
   直接 dry 会被硬闸门拒绝（`INVALID_TAGS`，退出码 1）——这是**投稿内容闸门**，不是管线 bug；
   按模板提示填好 `tags` 后 dry 立即通过（0.12 s、零网络）。
5. **`publish.tags`（追加标签）/ `publish.titlePrefix`（标题前缀）已补上消费方**（同日跟进）：
   在 `publish.mjs` 的**字段组装层**（`resolveFields(storyboard, meta, config)`）合并 —— storyboard 标签优先、
   配置标签追加去重；标题前缀只加一次；合并结果仍走原有 ≤80 字 / ≤10 标签 / 单标签 ≤20 字闸门。
   dry 与 go 两条路径共用同一份 fields，上传协议/分片/签名一行未动；新增 3 个单测
   （管线测试 46 → 51）。第 3 节那次 dry 用的是旧行为（storyboard 自带标签），
   合并后的行为见第 7 节宿主端到端记录。

## 6. 宿主层端到端（2026-11-07 凌晨，Lead 复核）

管线本身通过之后，又验证了**宿主半端真的能把任务跑起来**（这条链路是 CLI 冒烟覆盖不到的）：

- 方式：`scripts/e2e-host.mjs` 用假 cordis ctx 直接调 `lib/api.mjs` 的 `handleApi`，
  走真实 HTTP 路由/信任栅栏/任务队列/媒体路由；子进程是真的 `tools/bili-faship.mjs`。
- 隔离：临时 `HOME/DSH_HOME/BILI_FASHIP_CONFIG`，成片落在临时 `videos/e2e-320`；
  `video.paths.ffmpeg` / `video.paths.stickers` 显式指向本机只读素材；`minDurationSec: 8`（冒烟片 14.46s）。
- 结果：

| 步骤 | 结论 |
|---|---|
| `POST /jobs {action:render}` | 后台任务启动（真 node 子进程 + 日志文件），**36 秒**后 `status:done / exitCode:0` |
| `GET /videos` | `hasVideo:true / hasCover:true`，slug/标题正确 |
| `GET /status` | `due:true / indexState:missing`，`schedule.reason:out-of-window`（00:00 不在 21:00–23:30） |
| `HEAD /media?dir=<绝对目录>&file=cover.jpg` | 200 / `image/jpeg` / 14,987 B（路径守卫与白名单生效） |
| `POST /jobs {action:review}` | 同步自审 **pass:true / score:100**（成片 14.46s ∈ [8,180]） |
| `POST /jobs {action:publish-dry}` | 0.1 s、`network:false`，生成 `publish.json`；标题 `【E2E】冒烟测试：320x180 能不能跑通`、标签 `AI / 日常 / 大肥鱼 / 端到端`（配置的 tags + titlePrefix 已合并）；简介含「AI 生成」 |

- 另外验证了 `POST /jobs {action:publish-go}` 的四道闸：`confirm` 缺失 → 400；`allowGo` 关 → 403；
  `review` 未 pass → 409；`dryRun` 仍开 → 409。**没有执行任何真投稿**。
- 失败也验证过：隔离 `DSH_HOME` 下没填 `video.paths.ffmpeg` 时，后台任务正确落成 `failed/exitCode:1`，
  日志尾部能直接看到「找不到 ffmpeg…」和修复建议（不是静默失败）。

## 7. 复现 & 清理

第 2 节的临时目录在复核完成后**已删除**（不影响任何线上数据）；第 6 节的宿主层验证用
`node scripts/e2e-host.mjs <含 storyboard.json 的目录>` 可随时重跑（脚本自己建临时目录、跑完打印证据目录）。
命令里没有 `--go`，不会真投稿。
