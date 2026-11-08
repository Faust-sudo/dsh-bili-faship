/**
 * lib/deps.mjs —— 依赖体检（设置页「依赖体检」按钮 & faship_deps 工具共用同一套口径）。
 *
 * 为什么要它（dsh-bili-whale 的经验）：装完插件不等于能用。node 可能不是真 node、
 * ffmpeg 可能不在 PATH、Python 可能没 Pillow、表情包目录可能被搬走。提前体检比拍完 1000 帧才报错强。
 *
 * 约定：items[] 每项 { name, ok, detail, fix, optional }；
 *   · 必需项：node / ffmpeg / Python+Pillow / BGM 与音效素材 / 数据目录可写
 *   · 可选项（缺了只警告）：表情包 / 字体 / cookie / 日记素材
 * 顶层 ok 只看必需项。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DSH_HOME, dshPath, HOME } from '../tools/lib/paths.mjs'
import {
  videoConfig, videoRoot, stickerDir as configStickerDir,
  pythonPath as configPythonPath, ffmpegPathHint,
} from '../tools/lib/video-config.mjs'
import { fashipHome, jobsDir } from './dirs.mjs'
import { tryNodeRuntime } from './node-runtime.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function existsFile(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}

/** 跑子进程并抓文本（失败不抛，返回 {ok,out,err,code}） */
function run(cmd, args, opts = {}) {
  try {
    const r = spawnSync(cmd, args, {
      timeout: opts.timeout ?? 20_000,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: !r.error && r.status === 0, code: r.status, out: String(r.stdout || ''), err: String(r.stderr || r.error?.message || '') }
  } catch (e) {
    return { ok: false, code: null, out: '', err: String(e?.message ?? e) }
  }
}

/** Python 解释器候选：配置 → env → python/python3（主解析走 video-config 的 pythonPath） */
function pythonCandidates() {
  const out = []
  const push = (v) => { if (v && !out.includes(v)) out.push(v) }
  push(configPythonPath())
  push(process.platform === 'win32' ? 'python' : 'python3')
  push('python3')
  push('python')
  return out
}

export function checkPython() {
  const tried = []
  for (const cmd of pythonCandidates()) {
    tried.push(cmd)
    // 渲染器 tools/video/renderer/lib.py 顶层 import numpy —— 只查 PIL 会"体检全绿、渲染崩"
    const r = run(cmd, ['-c', 'import sys,PIL,numpy;print(sys.version.split()[0]);print(PIL.__version__);print(numpy.__version__)'])
    if (!r.ok) continue
    const lines = r.out.trim().split(/\r?\n/)
    return { ok: true, path: cmd, version: lines[0] || '', pillow: lines[1] || '', numpy: lines[2] || '', tried }
  }
  return { ok: false, path: null, version: '', pillow: '', numpy: '', tried, error: '找不到能 import PIL+numpy 的 Python' }
}

/** 表情包目录（解析链由 video-config.stickerDir 定义，宿主不另写一份） */
export function stickerDir() {
  try { return configStickerDir() } catch { return fashipHome('stickers') }
}

/** 表情包统计：GIF/PNG 数量 */
export function stickerStats(dir = stickerDir()) {
  try {
    const files = fs.readdirSync(dir).filter((f) => /\.(gif|png|webp)$/i.test(f))
    return { dir, count: files.length }
  } catch {
    return { dir, count: 0 }
  }
}

/** 字体：Windows 自带；非 Windows 会退化（只警告） */
export function fontStats() {
  const windir = process.env.WINDIR || 'C:\\Windows'
  const cands = [
    path.join(windir, 'Fonts', 'msyhbd.ttc'),
    path.join(windir, 'Fonts', 'msyh.ttc'),
    path.join(windir, 'Fonts', 'STKAITI.TTF'),
    path.join(windir, 'Fonts', 'FZSTK.TTF'),
  ]
  const found = cands.filter(existsFile)
  return { ok: found.length >= 2, found, platform: process.platform }
}

/** 日记素材：配置里列出的路径存在几个 */
export function materialStats() {
  const cfg = videoConfig()
  const diary = Array.isArray(cfg.materials?.diary) ? cfg.materials.diary : []
  const present = diary.filter((p) => existsFile(p))
  return { total: diary.length, present: present.length, files: present }
}

/** cookie（只查字段是否齐，不读值） */
export function credState() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(HOME, '.bili-ai', 'credentials.json'), 'utf8'))
    return { present: true, hasSess: Boolean(c.sessdata), hasJct: Boolean(c.bili_jct), hasBuvid: Boolean(c.buvid3) }
  } catch {
    return { present: false, hasSess: false, hasJct: false, hasBuvid: false }
  }
}

/** 数据目录可写性（真的写一个临时文件再删） */
export function dirWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const f = path.join(dir, `.write-test-${process.pid}-${Date.now()}`)
    fs.writeFileSync(f, 'ok')
    fs.rmSync(f, { force: true })
    return true
  } catch { return false }
}

/** ffmpeg 体检（路径解析顺序抄 tools/lib/ffmpeg.mjs，但不 import 它以免循环） */
export function checkFfmpeg() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const cands = []
  const push = (p) => { if (p && !cands.includes(p)) cands.push(p) }
  push(ffmpegPathHint())
  for (const d of String(process.env.PATH || '').split(path.delimiter)) if (d) push(path.join(d, exe))
  push(path.join(ROOT, 'bin', exe))
  push(dshPath('bili-whale', 'bin', exe))
  const found = cands.find(existsFile) || null
  if (!found) return { ok: false, path: null, version: '', error: '找不到 ffmpeg' }
  const r = run(found, ['-hide_banner', '-version'])
  return { ok: r.ok, path: found, version: (r.out.split(/\r?\n/)[0] || '').trim(), error: r.ok ? '' : r.err.slice(0, 200) }
}

/** 随包素材（BGM/SFX 随包发布，缺了说明包不完整） */
export function audioAssets() {
  const dir = path.join(ROOT, 'tools', 'video', 'assets')
  const need = ['bgm/soft-groove.mp3', 'sfx/pop.wav', 'sfx/whoosh.wav', 'sfx/ding.wav']
  const missing = need.filter((f) => !existsFile(path.join(dir, f)))
  return { ok: missing.length === 0, dir, missing }
}

/**
 * 完整依赖体检。
 * @returns {Promise<{ok:boolean, items:Array, node:object, ffmpeg:object, python:object, home:string}>}
 */
export async function runDeps() {
  const items = []
  const add = (it) => items.push({ optional: false, fix: null, ...it })

  // node：必须是「真 node」（Electron 的 process.execPath 跑不了脚本）
  const rt = tryNodeRuntime(DSH_HOME)
  add({
    name: 'node（可执行脚本）',
    ok: rt.ok,
    detail: rt.ok ? `${rt.file} · v${process.versions.node}` : String(rt.error || ''),
    fix: rt.ok ? null : '设置环境变量 DSH_NODE 指向真实 node 的绝对路径',
  })

  const ff = checkFfmpeg()
  add({
    name: 'ffmpeg',
    ok: ff.ok,
    detail: ff.ok ? `${ff.path} · ${ff.version || ''}`.trim() : (ff.error || '找不到 ffmpeg'),
    fix: ff.ok ? null : '装 ffmpeg（winget install ffmpeg），或在设置里填绝对路径 / 设 FFMPEG 环境变量',
  })

  const py = checkPython()
  add({
    name: 'Python + Pillow + numpy',
    ok: py.ok,
    detail: py.ok ? `${py.path} · Python ${py.version} · Pillow ${py.pillow} · numpy ${py.numpy}` : `${py.error}（试过：${py.tried.join(', ')}）`,
    fix: py.ok ? null : '安装 Python 3 并 pip install Pillow numpy；或在设置里填 Python 绝对路径',
  })

  const au = audioAssets()
  add({
    name: 'BGM / 音效素材',
    ok: au.ok,
    detail: au.ok ? `OK（${au.dir}）` : `缺：${au.missing.join(', ')}`,
    fix: au.ok ? null : '插件包不完整，重装插件',
  })

  const okVideoDir = dirWritable(videoRoot())
  const okJobs = dirWritable(jobsDir())
  add({
    name: '数据目录可写',
    ok: okVideoDir && okJobs,
    detail: `视频根：${videoRoot()}；任务：${jobsDir()}`,
    fix: okVideoDir && okJobs ? null : '检查目录权限 / 磁盘空间',
  })

  const st = stickerStats()
  add({
    name: '表情包（可选）',
    ok: st.count > 0,
    optional: true,
    detail: st.count > 0 ? `${st.count} 张 · ${st.dir}` : `没找到 GIF（${st.dir || '未配置'}），渲染会缺角色表情`,
    fix: st.count > 0 ? null : '把表情包放到设置里的路径，默认复用 ~/.dsh/bili-whale/stickers/packs/大肥鱼',
  })

  const fo = fontStats()
  add({
    name: '中文字体（可选）',
    ok: fo.ok,
    optional: true,
    detail: fo.ok ? `找到 ${fo.found.length} 个` : `只找到 ${fo.found.length} 个（非 Windows 会用系统回退字体）`,
    fix: fo.ok ? null : '安装微软雅黑/华文楷体等中文字体，或接受字体退化',
  })

  const ck = credState()
  const ckOk = ck.present && ck.hasSess && ck.hasJct
  add({
    name: 'B 站 cookie（可选）',
    ok: ckOk,
    optional: true,
    detail: ck.present
      ? `已写入（SESSDATA=${ck.hasSess ? '有' : '无'}，bili_jct=${ck.hasJct ? '有' : '无'}，buvid3=${ck.hasBuvid ? '有' : '无'}）`
      : '还没写入',
    fix: ckOk ? null : '设置页「凭据」里写 SESSDATA + bili_jct（只在真投稿时需要）',
  })

  const mat = materialStats()
  add({
    name: '日记素材（可选）',
    ok: mat.present > 0,
    optional: true,
    detail: mat.total ? `配置了 ${mat.total} 个，存在 ${mat.present} 个` : '没有配置日记路径',
    fix: mat.present > 0 ? null : '在设置页「人物与素材」里填日记文件路径；agent 写 storyboard 时要用',
  })

  const required = items.filter((x) => !x.optional)
  return {
    ok: required.every((x) => x.ok),
    items,
    node: { path: rt.ok ? rt.file : '', version: process.versions.node },
    ffmpeg: { path: ff.path || '', version: ff.version || '' },
    python: { path: py.ok ? py.path : '', pillow: py.pillow || '', numpy: py.numpy || '' },
    home: fashipHome(),
  }
}
