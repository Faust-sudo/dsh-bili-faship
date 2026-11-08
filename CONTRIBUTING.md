# 贡献指南

这是个人向的 DSH 插件（鲸鱼娘 / 大肥鱼 的视频流水线），欢迎 Issue 与 PR，但请先读这几条。

## 开发环境

- Node **≥ 20.12**（`import.meta.dirname`）；本机验证过 20.20 / 22.23 / 24.20。
- Python 3 + **Pillow + numpy**（渲染器）；ffmpeg 7+。
- 装法见 README「装」。改完代码需要重载插件（桌面版开 HMR 时设置页热更，宿主半端要重启一次）。

## 提交前必跑

```bash
node --test            # 全部单测（不联网、不真渲染、不真投稿）
node selfcheck.mjs     # 宿主 + 设置页两个半端的预检
node tools/bili-faship.mjs --help
```

改了渲染/投稿相关代码，再补一次 320×180 真链路（**不要**真发）：

```bash
node tools/bili-faship.mjs plan   --dir <临时目录> --topic 测试 --width 320 --height 180 --fps 15
node tools/bili-faship.mjs render --dir <临时目录>
node tools/bili-faship.mjs review --dir <临时目录>
node tools/bili-faship.mjs publish --dir <临时目录> --dry
```

## 约定

- 不要在测试/开发里真投稿（`publish --go`）；CI 也永远不跑真发。
- 不要打印 / 回显 cookie；凭据一律「只写不读回」。
- 红线（AI 标注 / 不冒充真人 / 不搬运 / 不刷量 / 风控不重试）是**代码闸门**，PR 不得把它们改成可配置或可跳过。
- 文档与实现不一致时，以「代码 + 测试」为准，并同步改文档。
- 提交信息用中文或英文均可，说清楚「为什么」。
