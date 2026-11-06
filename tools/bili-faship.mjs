#!/usr/bin/env node
/**
 * bili-faship —— dsh-bili-faship 插件「视频管线」的独立 CLI 入口。
 *
 *   node tools/bili-faship.mjs plan    --dir <dir> [--topic <主题>] [--json]
 *   node tools/bili-faship.mjs render  --dir <dir> [--json]
 *   node tools/bili-faship.mjs review  --dir <dir> [--json]
 *   node tools/bili-faship.mjs publish --dir <dir> [--dry|--go] [--json]
 *   node tools/bili-faship.mjs status  [--json]
 *   node tools/bili-faship.mjs deps    [--json]
 *
 * 为什么拆成两层：
 *   · 宿主（lib/jobs.mjs）与叫醒词都要有**一个稳定、可引用的绝对路径**来跑管线；
 *     入口文件名固定为 tools/bili-faship.mjs 后，宿主只拼这一个字符串，不再关心子命令文件；
 *   · 具体实现在 commands/video.mjs（可被单测直接 import），这里只负责转发 argv 和退出码。
 *
 * 配置/路径：全部来自 tools/lib/video-config.mjs（DESIGN §3/§4），可以用 BILI_FASHIP_CONFIG
 * 指向一份临时配置来跑冒烟，不会碰用户的真实配置。
 */
import { main } from './commands/video.mjs'

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((e) => {
    console.error(`✗ 未捕获错误：${e?.stack || e?.message || e}`)
    process.exitCode = 1
  })
