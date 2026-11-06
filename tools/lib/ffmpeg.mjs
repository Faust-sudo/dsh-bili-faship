// ffmpeg 定位（DESIGN §3 的解析链；插件版 + 独立 CLI 共用）
//
// 为什么要有这个文件：旧代码把 ffmpeg 路径写死成作者本机剪映自带的那份。
// 别人机器上没有剪映、或者版本号不同 → 抽帧/渲染直接报错 ✗
//
// 查找顺序（找到即用，越靠前越"用户显式指定"）：
//   ① 配置 video.paths.ffmpeg —— 设置页里填的路径（最高优先级，DESIGN §3）
//   ② 环境变量 FFMPEG         —— 临时指定/CI
//   ③ PATH 里的 ffmpeg(.exe)  —— winget / scoop / brew 装完就是这样
//   ④ <插件根>/bin/ffmpeg(.exe) —— 发布时随包放的静态构建（⚠️ 只放 LGPL 变体，附 LICENSE）
//   ⑤ <DSH_HOME>/bili-whale/bin/ —— 复用本机已装的 dsh-bili-whale 那份
//   ⑥ 本机常见位置（剪映自带）—— ⚠️ 仅"本机便利"，剪映那份**不可再分发**（第三方发行版）
//
// 用 @ffmpegPath() 取路径（可能 null）；@requireFfmpeg() 取路径并在缺时抛友好错误。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from './capture.mjs'
import { dshPath } from './paths.mjs'
import { ffmpegPathHint } from './video-config.mjs'

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 插件根目录（tools/lib/../..），插件自带二进制放在 <插件根>/bin/。 */
const PLUGIN_ROOT = path.resolve(HERE, '..', '..')
const BUNDLED = path.join(PLUGIN_ROOT, 'bin', EXE)

const exists = (f) => {
  if (!f) return false
  try { return fs.statSync(f).isFile() } catch { return false }
}

function onPath() {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue
    const f = path.join(d, EXE)
    if (exists(f)) return f
  }
  return null
}

// 本机便利：剪映自带的 ffmpeg（版本号在路径里，要扫目录）
function jianyingCopies() {
  if (process.platform !== 'win32') return []
  const base = path.join(process.env.LOCALAPPDATA || '', 'JianyingPro', 'Apps')
  try {
    return fs.readdirSync(base)
      .map((v) => path.join(base, v, 'ffmpeg.exe'))
      .filter(exists)
  } catch { return [] }
}

export function ffmpegPath() {
  // 配置读取失败（比如配置文件损坏）时不要让整个渲染挂掉：退回环境变量/PATH 链
  let configured = null
  try { configured = ffmpegPathHint() } catch { configured = null }
  const cands = [
    configured,
    process.env.FFMPEG,
    onPath(),
    BUNDLED,
    dshPath('bili-whale', 'bin', EXE),
    ...jianyingCopies(),
  ]
  return cands.find(exists) ?? null
}

export function requireFfmpeg() {
  const p = ffmpegPath()
  if (p) return p
  throw new Error([
    '找不到 ffmpeg（抽帧/渲染/测响度都要它）。任选一种解决：',
    '  ① 装一个：winget install ffmpeg   （或 scoop install ffmpeg / brew install ffmpeg）',
    '  ② 用环境变量指定：set FFMPEG=D:\\path\\to\\ffmpeg.exe',
    '  ③ 在设置页「视频工坊 → 渲染与路径」里填 video.paths.ffmpeg',
    `  ④ 把它放到 ${BUNDLED} 或 ${dshPath('bili-whale', 'bin', EXE)}`,
  ].join('\n'))
}

// 给人/给 agent 看的"依赖体检"结果
export function ffmpegInfo() {
  const p = ffmpegPath()
  if (!p) return { ok: false, path: null, version: null }
  try {
    const out = execFileSync(p, ['-hide_banner', '-version'], { encoding: 'utf8' })
    return { ok: true, path: p, version: (out.split('\n')[0] || '').trim() }
  } catch (e) {
    return { ok: false, path: p, version: null, error: String(e.message).slice(0, 120) }
  }
}
