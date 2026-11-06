# NOTICE · 第三方素材与设计参考

本项目（`dsh-bili-faship` / 鲸鱼娘视频工坊）自身代码以 **MIT** 许可发布，正文见 `LICENSE`。
本文件只说明**随包素材的来源**与**设计上参考过什么**，不构成额外限制。

## 随包素材

### 音频（BGM / 音效）

| 文件 | 来源 | 许可 |
|---|---|---|
| `tools/video/assets/bgm/soft-groove.mp3` | **CC0** · 程序合成（脚本 `generate-soft-groove.py`） | 公共领域，可自由使用 |
| `tools/video/assets/sfx/pop.wav`、`whoosh.wav`、`ding.wav` | **CC0** · 程序合成（脚本 `generate-sfx.py`） | 公共领域，可自由使用 |

三件套都由随包的 Python 脚本**合成生成**，不包含任何第三方录音或采样；各自的 `LICENSE.txt`
就在同目录下，生成脚本也一并保留，想自己重做一份改参数重跑即可。

### 不随包分发的东西

- **表情包 / 角色形象**：**不入包**。渲染时读用户自己机器上的素材目录
  （默认 `~/.dsh/bili-whale/stickers/packs/大肥鱼`，设置页可改）。本仓库不包含任何角色图片、
  不声明角色形象的权利；使用者需要自行确认自己对所用素材有使用权。
- **ffmpeg**：**不打包**。插件只负责**定位并调用**系统上的 ffmpeg（`tools/lib/ffmpeg.mjs`），
  ffmpeg 的许可（LGPL v2.1+ / GPL，取决于你装的构建）由你自行遵守。
- **字体**：**不打包**。渲染优先用 Windows 自带的微软雅黑 / 华文行楷 / 方正舒体（`C:/Windows/Fonts`），
  找不到就退回 Pillow 默认字体；别的系统上会退化，属已知限制。
- **B 站任何代码或数据**：只调用公开 web 接口，仓库里没有 B 站的内容。

## 设计参考（只借思路，代码独立实现）

| 项目 | 借了什么 | 说明 |
|---|---|---|
| `dsh-bili-whale`（本机 `~/.dsh/plugins/dsh-bili-whale`） | 设置页的数据驱动表单、生物钟「窗口 + 冷却」的调度思路、DSH 信任栅栏、依赖体检的字段形状、node 运行时探测（Electron 不能直接跑脚本） | 思路与教训参考；本插件**代码零依赖**它，只在默认素材路径上做了兼容（`~/.dsh/bili-whale/...`） |
| `dsh-bili-scroll`（本机桌面版 profile 的 node_modules 里） | `defineTool` 注册工具、从宿主树解析依赖的 `hostdeps.mjs` 兜底、`selfcheck.mjs` 预检、`package.json` / bundle patch 的打包规范 | 思路与规范参考；`faship_*` 工具与自检脚本为本项目自行实现 |
| 原独立项目 `D:/agent_train/bili-faship` | 整条视频管线（storyboard v4 / 逐帧渲染 / 自审 7 闸门 / 投稿协议）；`tools/**` 与部分 `docs/**` 由它移植而来 | 同一作者，已获准在此并回为插件；原项目保持只读 |

## 免责

- 本插件用**使用者自己的 B 站账号**做动作，**后果由使用者自负**。
- 它是非官方工具，与哔哩哔哩、DeepSeek 均无隶属关系；B 站接口随时可能变化，项目不做任何可用性承诺。
- 不要用于刷量、群发、搬运、冒充真人或任何违反平台规则的行为。撞到风控（412 / 429 / 601）
  就该停手 —— 插件内置的护栏只会**停下**，不会替你绕过验证。
