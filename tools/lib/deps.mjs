// 依赖体检（CLI 版）——dsh-bili-faship
//
// 为什么需要它：视频管线会调 ffmpeg / Python(Pillow) / 表情包 / 字体 / BGM 资源，
// 这些东西缺一个，agent 就会在渲染中途才报一个很难懂的错误。体检把"缺什么、怎么修"
// 提前用一行话说清楚（DESIGN §5 的 /deps 同构；宿主 lib/deps.mjs 会用同一套判定口径）。
//
// 判定口径（DESIGN §5）：
//   · 硬依赖：node / ffmpeg / Python+Pillow / BGM 资源 —— 任何一项不 ok，整体 ok=false；
//   · 软依赖：表情包 / 字体 / cookie / 日记 / 目录 —— 缺了只 warn（optional=true），不影响 ok。
// 每个子进程都真跑一遍（不是只看文件在不在），并且**绝不打印 cookie 内容**。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from './capture.mjs'
import { ffmpegInfo } from './ffmpeg.mjs'
import { videoConfig, videoRoot, cacheRoot, stickerDir, pythonPath } from './video-config.mjs'
import { configPath, credentialsPath, DSH_HOME } from './paths.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ASSETS = path.join(HERE, '..', 'video', 'assets')

/** 一条体检结果（DESIGN：items[{name, ok, detail, fix, optional}]）。 */
const item = (name, ok, detail, fix = null, optional = false) => ({ name, ok, detail, fix, optional })

/** 跑一个短命令拿 stdout 文本；失败返回 { ok:false }（不抛错，交给 items 记录）。 */
function runText(exe, args, timeout = 20000) {
  try {
    return { ok: true, text: String(execFileSync(exe, args, { encoding: 'utf8', timeout }) || '').trim() }
  } catch (e) {
    return { ok: false, error: e }
  }
}

/** 文件是否是可用的普通文件（>minBytes）。 */
function fileOk(file, minBytes = 1) {
  try {
    const st = fs.statSync(file)
    return st.isFile() && st.size >= minBytes
  } catch {
    return false
  }
}

/**
 * 目录可写检查：**不创建任何目录**（体检不该改用户磁盘）。
 * 从目标目录往上找到第一个已存在的祖先，看它是否可写 —— 足够了，因为渲染时由自己 mkdir -p。
 */
function dirWritable(dir) {
  let cur = path.resolve(dir)
  for (;;) {
    try {
      const st = fs.statSync(cur)
      if (st.isDirectory()) {
        try {
          fs.accessSync(cur, fs.constants.W_OK)
          return { ok: true, existing: cur }
        } catch {
          return { ok: false, existing: cur, reason: '不可写' }
        }
      }
    } catch {
      /* 继续往上一级找 */
    }
    const parent = path.dirname(cur)
    if (parent === cur) return { ok: false, existing: null, reason: '找不到可写祖先目录' }
    cur = parent
  }
}

/** 读凭据文件（只用于判断"有没有配好"，绝不回显内容、绝不落日志）。 */
function credState() {
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath, 'utf8').replace(/^\uFEFF/, ''))
    const sess = String(raw?.sessdata ?? '').trim()
    const jct = String(raw?.bili_jct ?? '').trim()
    const miss = []
    if (sess.length < 20) miss.push('SESSDATA')
    if (!/^[0-9a-fA-F]{32}$/.test(jct)) miss.push('bili_jct')
    if (miss.length) return { ok: false, detail: `凭据文件存在，但 ${miss.join(' / ')} 缺失或不合法` }
    return { ok: true, detail: '已配置（SESSDATA + bili_jct 都合法）' }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, detail: `没有凭据文件：${credentialsPath}` }
    return { ok: false, detail: '凭据文件不是合法 JSON（重新粘贴一次 cookie）' }
  }
}

/**
 * 跑一遍依赖体检。
 * @param {{config?:object}} [opts] 配置覆盖（测试/宿主注入用；默认读 videoConfig()）
 * @returns {{ok:boolean, items:Array<{name,ok,detail,fix,optional}>, node:object, ffmpeg:object, python:object, home:string, configPath:string, videoRoot:string}}
 */
export function collectDeps(opts = {}) {
  const cfg = opts.config || videoConfig()
  const items = []

  // ---- 硬依赖 ----
  items.push(item('node', true, process.version, null, false))

  const ff = ffmpegInfo()
  items.push(item(
    'ffmpeg',
    ff.ok,
    ff.ok ? `${ff.path}（${(ff.version || '').slice(0, 60)}）` : '没找到可用的 ffmpeg',
    ff.ok ? null : '安装 ffmpeg（winget install ffmpeg），或在设置页「渲染与路径」里填 video.paths.ffmpeg',
    false,
  ))

  // Python + Pillow 是一门"组合依赖"：python 在但 Pillow 不在，渲染照样挂 → 两条都必查
  const py = pythonPath(cfg)
  const pyVer = runText(py, ['-c', 'import sys;print(sys.version.split()[0])'])
  const pilVer = runText(py, ['-c', 'import PIL;print(PIL.__version__)'])
  items.push(item(
    'python',
    pyVer.ok,
    pyVer.ok ? `${py}（Python ${pyVer.text}）` : `跑不起 ${py}（${String(pyVer.error?.message || pyVer.error).slice(0, 120)}）`,
    pyVer.ok ? null : '安装 Python 3（或设置 video.paths.python / WHALE_PYTHON）',
    false,
  ))
  items.push(item(
    'Pillow',
    pilVer.ok,
    pilVer.ok ? `Pillow ${pilVer.text}` : `Python 里 import PIL 失败（${String(pilVer.error?.message || pilVer.error).slice(0, 120)}）`,
    pilVer.ok ? null : `安装依赖：${py} -m pip install pillow numpy`,
    false,
  ))

  const bgmFile = path.join(ASSETS, 'bgm', 'soft-groove.mp3')
  const sfxFiles = ['whoosh', 'pop', 'ding'].map((n) => path.join(ASSETS, 'sfx', `${n}.wav`))
  const bgmOkCount = sfxFiles.filter((f) => fileOk(f, 500)).length
  const bgmOk = fileOk(bgmFile, 10000) && bgmOkCount === sfxFiles.length
  items.push(item(
    'BGM 资源',
    bgmOk,
    bgmOk ? `soft-groove.mp3 + ${bgmOkCount} 个音效` : `缺少内置 BGM/音效（${ASSETS}）`,
    bgmOk ? null : '插件包不完整：重新安装 dsh-bili-faship（tools/video/assets 必须随包）',
    false,
  ))

  // ---- 软依赖（缺了只 warn） ----
  const fontCands = ['C:/Windows/Fonts/msyhbd.ttc', 'C:/Windows/Fonts/msyh.ttc', '/System/Library/Fonts/PingFang.ttc']
  const font = fontCands.find((f) => fileOk(f, 1000))
  items.push(item(
    '字体',
    !!font,
    font || '没找到中文粗体字体（会用 Pillow 默认字体，中文可能显示为方块）',
    font ? null : '装微软雅黑，或用 WHALE_FONT_BOLD 指定一个 .ttf/.ttc',
    true,
  ))

  const stickerPath = stickerDir(cfg)
  let gifCount = 0
  try { gifCount = fs.readdirSync(stickerPath).filter((n) => /\.gif$/i.test(n)).length } catch { gifCount = 0 }
  items.push(item(
    '表情包',
    gifCount > 0,
    gifCount > 0 ? `${gifCount} 个 GIF · ${stickerPath}` : `没有表情包目录/文件：${stickerPath}`,
    gifCount > 0 ? null : '把表情包放到上述目录，或在设置里改 video.paths.stickers（也认 WHALE_STICKER_DIR）',
    true,
  ))

  const cred = credState()
  items.push(item(
    'cookie',
    cred.ok,
    cred.detail,
    cred.ok ? null : '在设置页「视频工坊 → 凭据」粘贴 SESSDATA / bili_jct 后保存（只写不读回）',
    true,
  ))

  const diaries = Array.isArray(cfg.materials?.diary) ? cfg.materials.diary : []
  const diaryExisting = diaries.filter((f) => typeof f === 'string' && fileOk(f, 1))
  items.push(item(
    '日记素材',
    diaryExisting.length > 0,
    diaries.length
      ? `找到 ${diaryExisting.length}/${diaries.length} 个：${diaryExisting.join('、') || '（都不存在）'}`
      : '没有配置 materials.diary',
    diaryExisting.length ? null : '在设置页「人物与素材」里填日记文件路径（可选，没有也能做片）',
    true,
  ))

  const outRoot = videoRoot(cfg)
  const outW = dirWritable(outRoot)
  items.push(item(
    '成片目录',
    outW.ok,
    outW.ok ? `${outRoot}（可写）` : `${outRoot}（${outW.reason}）`,
    outW.ok ? null : '换一个可写的 video.outDir，或检查磁盘权限',
    true,
  ))
  const cacheRootDir = cacheRoot(cfg)
  const cacheW = dirWritable(cacheRootDir)
  items.push(item(
    '缓存目录',
    cacheW.ok,
    cacheW.ok ? `${cacheRootDir}（可写）` : `${cacheRootDir}（${cacheW.reason}）`,
    cacheW.ok ? null : '换一个可写的 video.paths.cache，或检查磁盘权限',
    true,
  ))

  // ok 只由必需项决定（DESIGN §5：表情包/cookie/日记缺失只 warn）
  const ok = items.every((it) => it.optional || it.ok)
  return {
    ok,
    items,
    node: { path: process.execPath, version: process.version },
    ffmpeg: { path: ff.path || null, version: ff.version || null },
    python: { path: py, version: pyVer.ok ? pyVer.text : '', pillow: pilVer.ok ? pilVer.text : '' },
    home: DSH_HOME,
    configPath,
    videoRoot: outRoot,
  }
}
