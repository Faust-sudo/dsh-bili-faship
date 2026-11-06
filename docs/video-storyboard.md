# 视频脚本（storyboard）schema 与最小可渲染示例

> 视频工坊的输入格式。能力合同见仓库根目录 [`VIDEO-CAPABILITY.md`](../VIDEO-CAPABILITY.md)（storyboard version 4）。
> 一条视频一个目录：`<视频根>/<slug>/storyboard.json`；`render` 产出 `video.mp4 / cover.jpg / subtitles.srt / timing.json / meta.json`，
> `review` 写 `review.json`，`publish` 写 `publish.json`。
>
> 视频根 = 配置 `video.outDir`，留空默认 `<DSH_HOME>/bili-faship/videos`（`DSH_HOME` 默认 `~/.dsh`）。

## 快速开始

```bash
# 1) 生成模板（不会覆盖已存在的 storyboard.json）
node tools/bili-faship.mjs plan --dir "D:/videos/day0-hello" --topic "这个号，从今天起全归我"

# 2) 改 scenes 里的 narration / card 之后渲染（分钟级）
node tools/bili-faship.mjs render --dir "D:/videos/day0-hello"

# 3) 自审（硬闸门全过才 pass；exit 0=pass，1=fail）
node tools/bili-faship.mjs review --dir "D:/videos/day0-hello"

# 4) 投稿包（不联网）+ 状态
node tools/bili-faship.mjs publish --dir "D:/videos/day0-hello" --dry
node tools/bili-faship.mjs status --json
```

`plan` 省略 `--dir` 时，会按 `--topic` 生成 slug 并落到 `<视频根>/<slug>`。
`plan` 还支持 `--width/--height/--fps`，只影响**新模板**（端到端冒烟用 320×180，正式片默认 1920×1080）。

### 一条命令跑通端到端（320×180 冒烟，TTS 需要联网）

```bash
node tools/bili-faship.mjs plan --dir "$env:USERPROFILE\.dsh\bili-faship\videos\demo320" --topic "这个号，从今天起全归我" --width 320 --height 180 --fps 15
node tools/bili-faship.mjs render --dir "$env:USERPROFILE\.dsh\bili-faship\videos\demo320"
node tools/bili-faship.mjs review --dir "$env:USERPROFILE\.dsh\bili-faship\videos\demo320"
```

> 冒烟片能验证 TTS → 渲染 → 混音 → 自审整条链路，但**不加速**：逐帧渲染仍按 1080p 设计分辨率绘制，
> 最后由 ffmpeg 缩放成 320×180。

## 顶层字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `version` | int | ✓ | 固定 `4` |
| `slug` | str | ✓ | 目录名/发布登记用；不能含 `\ / : * ? " < > \|` 或空格 |
| `title` | str | ✓ | 视频标题（封面/投稿默认用它） |
| `date` | str |  | `YYYY-MM-DD`，缺省=今天 |
| `width` / `height` | int（偶数，64–3840） |  | 成片分辨率，默认 `1920×1080`。**小尺寸只用于快速端到端验证** |
| `fps` | int 1–60 |  | 默认 30 |
| `voice` | object |  | `{voice, rate, pitch}`；缺省用配置 `video.voice`。`voice` 形如 `zh-CN-XiaoyiNeural`，`rate` 形如 `+8%`，`pitch` 形如 `+8Hz` |
| `topbar` | object |  | 顶栏 `{badge, label, right}`。**`right` 是「AI 生成」标注的主要位置** |
| `scenes` | array | ✓ | 场次（≥1），见下 |
| `audio` | object |  | `{bgm: "soft-groove", bgmVolume: 0.72}`；BGM 来自 `tools/video/assets/bgm/`（CC0） |
| `publish` | object |  | 投稿信息 `{titleForPost, description, tags[], aiLabel}`；`description` 里写「AI 生成」也算标注 |
| `citations` | array |  | 引用他人视频片段：`[{bv, up, title, clipSec}]`，没有就 `[]`（详见「红线」） |
| `coverTitle` / `coverSub` | str |  | 封面大字/小字（缺省用 `title`） |
| `footer` | str |  | 画面左下角小字（缺省「<角色名> · <badge>」） |
| `_hints` | object |  | plan 模板自带的填写提示，渲染/自审会忽略 |

## 场次（scenes[]）

```jsonc
{
  "id": "s1",                 // 必填，场内唯一
  "narration": "旁白文本",     // 会被 TTS 念出来；空字符串 = 这场不出声
  "mascot": "happy",          // 表情（见下表），默认 happy
  "card": { "kind": "big", "text": "...", "sub": "..." },  // UI 面板，默认 {kind:"none"}
  "stamp": { "text": "重点", "pos": "right", "angle": -8 },  // 印章（可 null）
  "shout": { "text": "冲！", "pos": "top", "color": "yellow", "angle": -4 }, // 呐喊字（可 null）
  "subtitleEmph": ["结论"],   // 字幕里要高亮的词（第一个黄、第二个起青色）
  "minDuration": 2.6          // 这一场最短秒数（有旁白时实际 = 0.4 + TTS 时长 + 0.35）
}
```

- `mascot`：`happy / surprised / idea / lazy / fish / hop / brave / heal / arrow / dian / special`（对应她的表情包）。
- `stamp.pos`：`left / center / right`；`shout.pos`：`left / top / right`；`shout.color`：`yellow / pink / cyan`。
- 字幕由 `narration` 自动切句（按标点，每句约 ≤15 个非标点字符），**不需要手写时间轴**。
- 量感：一场 2–3 秒、一个信息点；约 12 场 ≈ 35–45 秒。旁白和大字**不要重复同一句话**。

### 卡片种类（card.kind）

| kind | 主要字段 | 用途 |
| --- | --- | --- |
| `big` | `text, sub` | 大字标题（开场） |
| `profile` | `title, rows[{label,value}], icon` | 账号/资料面板 |
| `stats` | `title, rows[{label,value}]` | 数据面板（2 列） |
| `note` | `title, lines[]` | 手写便签（纸质胶带风） |
| `dm` | `title, messages[{from,text}]` | 私信对话（`from: "主人"` 靠右展示主人） |
| `list` | `title, items[{text,sub}], highlight, dimTail, icon` | 列表/要点 |
| `videos` | `title, items[{bv,up,title,note}]` | 引用视频卡（封面从 `<dir>/covers/<BV>.jpg` 读，没有就画占位） |
| `bubble` | `text, speaker, tone` | 对话气泡（`tone:"owner"` 用橙色） |
| `alert` | `title, text` | 警示/提醒卡 |
| `cta` | `title, items[]` | 结尾三连引导 |
| `ending` | `title, sub` | 片尾字幕 |
| `none` | — | 不放面板 |

## 红线（review.mjs 硬闸门）

1. **AI 生成如实标注**：`topbar.right` 或 `publish.description`（或 `publish.aiLabel`）里必须有「AI 生成」。
2. **不冒充真人**：她的文本里不能出现「我是真人」「我不是AI」等短语。
3. **不搬运未标注片段**：`citations` 每条都必须有 `up`（UP 名）、`title`（原标题）、`bv`（BV 号），
   且 `clipSec ≤ video.selfReview.maxClipSec`（默认 3 秒）。
4. **不刷量不群发**：CLI/发布模块层面强制；storyboard 里出现配置的 `video.redlines.bannedWords` 也会 FAIL。
5. 其它自审硬闸门：schema 合法 / 时长在 `[minDurationSec, maxDurationSec]` / 响度在 `loudnessRange` /
   有旁白场次的字幕覆盖率 ≥ `minSubtitleCoverage`（默认 0.9）。

> 注意：`citations` 目前是**元数据 + 标注 + 引用卡**，不会真把别人的片段剪进成片。

`review.json` 形如：

```json
{
  "pass": true,
  "score": 100,
  "checks": [
    { "id": "schema", "hard": true, "ok": true, "detail": "storyboard version 4 · 3 场" },
    { "id": "duration", "hard": true, "ok": true, "detail": "成片 42.3s ∈ [15, 180]s" }
  ],
  "reviewedAt": "2026-11-06T23:00:00.000Z"
}
```

`score` 0–100（硬闸门按权重计分，软检查小扣分）；`pass` **只看硬闸门**，`selfReview.passScore` 只是附加线。

## 最小可渲染示例（320×180，约 8 秒）

保存为 `<dir>/storyboard.json`，再 `node tools/bili-faship.mjs render --dir <dir>`。
小尺寸只用于快速验证管线（TTS → 渲染 → 混音），正式成片请把 `width/height` 改回 `1920×1080`。

```json
{
  "version": 4,
  "slug": "smoke-320",
  "title": "测试一下，深海里的鱼",
  "date": "2026-11-06",
  "width": 320,
  "height": 180,
  "fps": 15,
  "voice": { "voice": "zh-CN-XiaoyiNeural", "rate": "+8%", "pitch": "+8Hz" },
  "topbar": {
    "badge": "Day 0",
    "label": "AI 接管中 · 大肥鱼的运营日志",
    "right": "本视频含 AI 生成内容"
  },
  "scenes": [
    {
      "id": "s1",
      "narration": "今天想聊一件小事：这个号，从今天起全归我。",
      "mascot": "happy",
      "card": { "kind": "big", "text": "这个号归我了", "sub": "Day 0 · 运营日志" }
    },
    {
      "id": "s2",
      "narration": "先说结论：值得做，但别急着全信。",
      "mascot": "idea",
      "card": {
        "kind": "list",
        "title": "我看到的",
        "items": [
          { "text": "她能自己选题", "sub": "从日记和热评里捞" },
          { "text": "她能自己审片", "sub": "硬闸门不过就不发" }
        ]
      }
    }
  ],
  "audio": { "bgm": "soft-groove", "bgmVolume": 0.72 },
  "publish": {
    "titleForPost": "这个号，从今天起全归我",
    "description": "AI 生成的运营日志。\n\n本视频含 AI 生成内容。",
    "tags": ["AI", "运营日志"],
    "aiLabel": "本视频含 AI 生成内容"
  },
  "citations": []
}
```

> TTS 用 Edge（免费、无需 key，但要联网）；断网时渲染会失败，不会静默出无声片。

## 运行时依赖与可覆盖项

| 依赖 | 默认 | 覆盖方式 |
| --- | --- | --- |
| Python + Pillow + numpy | `python` | 配置 `video.paths.python` → 环境变量 `WHALE_PYTHON` → `python` |
| ffmpeg | `tools/lib/ffmpeg.mjs` 的查找链 | 配置 `video.paths.ffmpeg` → `FFMPEG` → PATH → 插件 `bin/` → `~/.dsh/bili-whale/bin` → 剪映自带 |
| 她的表情包 | 配置 → `WHALE_STICKER_DIR` → `<DSH_HOME>/bili-whale/stickers/packs/大肥鱼` → `<DSH_HOME>/bili-faship/stickers` | 设置页「渲染与路径」 |
| 渲染缓存（表情解帧/背景） | 配置 `video.paths.cache` → `WHALE_VIDEO_CACHE` → `<DSH_HOME>/bili-faship/cache` | 同上（删了下次重建，几十秒） |
| 引用视频封面 | `<dir>/covers/<BV>.jpg`（其次 `tools/video/assets/covers`） | 环境变量 `WHALE_VIDEO_COVERS` |
| 字体 | `C:/Windows/Fonts/msyhbd.ttc`、`STKAITI.TTF`、`FZSTK.TTF` | `WHALE_FONT_BOLD / WHALE_FONT_REG / WHALE_FONT_SONG / WHALE_FONT_SONG_BOLD`（找不到退回 Pillow 默认字体，不崩） |

## 相关文件

- `tools/video/storyboard.mjs`：schema 校验 / normalize / plan 模板
- `tools/video/render.mjs`：TTS→时间轴/字幕→渲染→混音（原子落盘）
- `tools/video/review.mjs`：自审硬闸门 + 评分
- `tools/video/tts.mjs`：纯 Node Edge TTS（零依赖）
- `tools/video/renderer/`：Python 逐帧渲染（Pillow）
- `tools/video/assets/`：BGM/SFX（CC0，附 `LICENSE.txt`）
