/**
 * render.mjs — 把 <dir>/storyboard.json 变成成片。
 *
 * 流程（移植自 whale-video/assemble2.mjs 的已验证管线）：
 *   逐场 Edge TTS → 去尾部静音 → 时间轴/字幕 → 调 Python 逐帧渲染 → BGM/SFX 混音 → loudnorm → 合成
 *
 * 产物（全部落在 <dir>/）：
 *   video.mp4      成片（H.264 + AAC 192k，faststart）
 *   cover.jpg      封面
 *   subtitles.srt  字幕
 *   timing.json    时间轴（renderer 也吃它）
 *   meta.json      元信息（review / publish 用）
 *
 * 原子性：所有中间产物写在 <dir>/.work-<pid>-<ts>/，全部成功后才逐个 rename 到 <dir>；
 * 失败会抛错并删掉工作目录，**不会**留下半成品（旧的成片保持原样）。
 *
 * 测试提示：纯逻辑函数（buildTimeline / buildCues / srtFromCues / buildAudioArgs …）已导出；
 * renderVideo 支持 deps 注入（synthesize / exec / python），单测用假实现即可，不联网、不真渲染。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { requireFfmpeg } from '../lib/ffmpeg.mjs'
import { videoConfig, cacheRoot, stickerDir, pythonPath } from '../lib/video-config.mjs'
import { readStoryboard, storyboardPath } from './storyboard.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RENDERER = path.join(HERE, 'renderer', 'render.py')
const ASSETS = path.join(HERE, 'assets')
const BGM_DIR = path.join(ASSETS, 'bgm')
const SFX_DIR = path.join(ASSETS, 'sfx')

export const LEAD_SEC = 0.40
export const TAIL_SEC = 0.35
export const MIN_SCENE_SEC = 2.6
export const LOUDNORM = 'loudnorm=I=-16:TP=-2:LRA=11'
export const SFX_NAMES = ['whoosh', 'pop', 'ding']

const PUNCT = '，。！？；、,.!?;：'
const WHITE = [255, 255, 255, 255]
const YELLOW = [255, 210, 92, 255]
const CYAN = [127, 224, 255, 255]

// ---------------------------------------------------------------------------
// 纯逻辑（单测覆盖）
// ---------------------------------------------------------------------------

/** narration → 字幕分句（先按标点切，再合并到每句 ≤ maxLen 个非标点字符）。 */
export function splitNarration(text, maxLen = 15) {
  const pieces = []
  let cur = ''
  for (const ch of String(text ?? '')) {
    if (/\s/.test(ch)) { if (cur && !/\s$/.test(cur)) cur += ' '; continue }
    cur += ch
    if (PUNCT.includes(ch)) { pieces.push(cur); cur = '' }
  }
  if (cur.trim()) pieces.push(cur)
  const merged = []
  const bare = (s) => s.replace(/[\s\p{P}]/gu, '').length
  for (const raw of pieces) {
    const p = raw.replace(/\s+/g, ' ').trim()
    if (!p) continue
    if (merged.length && bare(merged[merged.length - 1]) + bare(p) <= maxLen) merged[merged.length - 1] += p
    else merged.push(p)
  }
  return merged
}

/** 估算一句话的「口播权重」（按它占整段 TTS 时长的比例分字幕时间）。 */
export function weightOf(s) {
  let w = 0
  for (const ch of String(s ?? '')) {
    if (/\s/.test(ch)) w += 0.2
    else if (PUNCT.includes(ch)) w += 0.8
    else w += 1
  }
  return Math.max(1, w)
}

/** 把 subtitleEmph 里的高亮词从文本切出来染色（第二个高亮改青色）。 */
export function spansFor(text, emph = []) {
  const marks = []
  for (const e of emph.filter(Boolean)) {
    let from = 0
    while (from <= text.length) {
      const idx = text.indexOf(e, from)
      if (idx < 0) break
      marks.push([idx, idx + e.length])
      from = idx + e.length
    }
  }
  marks.sort((a, b) => a[0] - b[0])
  const out = []
  let pos = 0
  for (const [a, b] of marks) {
    if (a < pos) continue
    if (a > pos) out.push([text.slice(pos, a), WHITE])
    out.push([text.slice(a, b), YELLOW])
    pos = b
  }
  if (pos < text.length) out.push([text.slice(pos), WHITE])
  if (out.filter((x) => x[1] === YELLOW).length > 1) {
    let first = true
    for (const x of out) {
      if (x[1] === YELLOW && !first) x[1] = CYAN
      if (x[1] === YELLOW || x[1] === CYAN) first = false
    }
  }
  return out.length ? out : [[text, WHITE]]
}

/**
 * 时间轴：每场 = max(minDuration, LEAD + TTS 时长 + TAIL)；无旁白的场次 = minDuration。
 * @param {Array} scenes 已归一化的 scenes
 * @param {{ttsDurById?:Record<string,number>, lead?:number, tail?:number, minScene?:number}} opts
 * @returns {Array<{i:number,scene:object,narration:string,ttsDur:number,dur:number,start:number,narrationStart:number}>}
 */
export function buildTimeline(scenes, opts = {}) {
  const lead = opts.lead ?? LEAD_SEC
  const tail = opts.tail ?? TAIL_SEC
  const minScene = opts.minScene ?? MIN_SCENE_SEC
  const ttsDurById = opts.ttsDurById || {}
  const rows = []
  for (const [i, scene] of (scenes || []).entries()) {
    const narration = String(scene.narration ?? '').trim()
    const minDur = Number(scene.minDuration ?? minScene)
    const ttsDur = narration ? Number(ttsDurById[scene.id] ?? 0) : 0
    if (narration && !(ttsDur > 0)) throw new Error(`场景 ${scene.id} 有旁白但没有 TTS 时长`)
    const dur = Math.max(minDur, narration ? lead + ttsDur + tail : minDur)
    rows.push({ i, scene, narration, ttsDur, dur, start: 0, narrationStart: 0 })
  }
  let acc = 0
  for (const row of rows) {
    row.start = acc
    row.narrationStart = acc + lead
    acc += row.dur
  }
  return rows
}

export function timelineTotal(timeline) {
  return (timeline || []).reduce((a, r) => a + r.dur, 0)
}

/**
 * 字幕 cue：按权重大致分配每句在 TTS 里的起止；不让 cue 越出场景尾、也不重叠。
 */
export function buildCues(timeline, opts = {}) {
  const tailGap = opts.tailGap ?? 0.12
  const cues = []
  for (const rec of timeline || []) {
    if (!rec.narration) continue
    const emph = (rec.scene.subtitleEmph || []).filter(Boolean)
    const chunks = splitNarration(rec.narration)
    const ws = chunks.map(weightOf)
    const totalW = ws.reduce((a, b) => a + b, 0)
    let cursor = 0
    const sceneEnd = rec.start + rec.dur - tailGap
    chunks.forEach((text, k) => {
      const start = rec.narrationStart + (cursor / totalW) * rec.ttsDur
      cursor += ws[k]
      const end = Math.min(rec.narrationStart + (cursor / totalW) * rec.ttsDur + 0.14, sceneEnd)
      if (end - start < 0.3) return
      cues.push({ key: `s${rec.i}c${k}`, start, end, scene: rec.i, spans: spansFor(text, emph) })
    })
  }
  cues.sort((a, b) => a.start - b.start)
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start - 0.02) cues[i].end = cues[i + 1].start - 0.02
  }
  return cues
}

export function cueText(cue) {
  return (cue.spans || []).map((x) => x[0]).join('')
}

/** 秒 → SRT 时间戳。 */
export function srtTimestamp(t) {
  const totalMs = Math.max(0, Math.round((Number(t) || 0) * 1000))
  const h = Math.floor(totalMs / 3600000)
  const m = Math.floor((totalMs % 3600000) / 60000)
  const s = Math.floor((totalMs % 60000) / 1000)
  const ms = totalMs % 1000
  const p2 = (n) => String(n).padStart(2, '0')
  return `${p2(h)}:${p2(m)}:${p2(s)},${String(ms).padStart(3, '0')}`
}

/** cues → SRT 文本（UTF-8 无 BOM，从 0 开始）。 */
export function srtFromCues(cues) {
  return (cues || [])
    .filter((c) => cueText(c).trim())
    .map((c, i) => `${i + 1}\n${srtTimestamp(c.start)} --> ${srtTimestamp(c.end)}\n${cueText(c).trim()}\n`)
    .join('\n')
}

/** 组装 timing.json 对象（renderer + review 共用）。 */
export function buildTiming({ story, timeline, cues }) {
  return {
    fps: story.fps,
    total: +timelineTotal(timeline).toFixed(3),
    width: story.width,
    height: story.height,
    scenes: timeline.map((r) => ({
      id: r.scene.id,
      i: r.i,
      start: +r.start.toFixed(3),
      dur: +r.dur.toFixed(3),
      mascot: r.scene.mascot || 'happy',
      card: r.scene.card || { kind: 'none' },
      stamp: r.scene.stamp || null,
      shout: r.scene.shout || null,
      narration: r.narration,
      subtitleEmph: r.scene.subtitleEmph || [],
    })),
    cues: cues.map((c) => ({ key: c.key, start: +c.start.toFixed(3), end: +c.end.toFixed(3), scene: c.scene, spans: c.spans })),
  }
}

/**
 * BGM/SFX 混音 ffmpeg 参数（纯函数，单测可直接断言）。
 * 结构照搬 assemble2：每条 TTS 用 adelay 对齐到 narrationStart；BGM 循环 + 淡入淡出；SFX 按事件点延迟；最后 amix + loudnorm。
 */
export function buildAudioArgs({ timeline, total, bgmPath, bgmVolume = 0.72, sfx = {}, outPath }) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error']
  const inputs = []
  const delays = []
  let idx = 0
  for (const rec of timeline || []) {
    if (!rec.tts) continue
    inputs.push('-i', rec.tts)
    delays.push({ idx: idx++, delay: Math.round(rec.narrationStart * 1000) })
  }
  let bgmIdx = -1
  if (bgmPath) {
    inputs.push('-stream_loop', '-1', '-i', bgmPath)
    bgmIdx = idx++
  }
  const sfxEvents = []
  const base = {}
  for (const name of SFX_NAMES) {
    const file = sfx[name]
    if (!file) continue
    inputs.push('-i', file)
    base[name] = idx++
  }
  const rows = timeline || []
  if (base.whoosh !== undefined) {
    rows.forEach((r, i) => { if (i > 0 && i % 3 === 0) sfxEvents.push({ idx: base.whoosh, delay: Math.round(r.start * 1000), vol: 0.22 }) })
  }
  if (base.pop !== undefined) {
    rows.forEach((r) => {
      if ((r.scene.card || {}).kind !== 'none') sfxEvents.push({ idx: base.pop, delay: Math.round((r.start + 0.03) * 1000), vol: 0.12 })
    })
  }
  if (base.ding !== undefined) {
    rows.forEach((r) => {
      const card = r.scene.card || {}
      if (r.scene.stamp || card.kind === 'big' || r.scene.shout) sfxEvents.push({ idx: base.ding, delay: Math.round((r.start + 0.4) * 1000), vol: 0.18 })
    })
  }

  const fc = []
  delays.forEach((d, k) => {
    fc.push(`[${d.idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${d.delay}|${d.delay},volume=1.0[nv${k}]`)
  })
  const mixLabels = delays.map((_, k) => `[nv${k}]`)
  if (bgmPath) {
    fc.push(`[${bgmIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${total.toFixed(3)},volume=${bgmVolume},afade=t=in:st=0:d=1.2,afade=t=out:st=${Math.max(0, total - 2.2).toFixed(3)}:d=2.2[bg]`)
    mixLabels.push('[bg]')
  }
  sfxEvents.forEach((e, k) => {
    fc.push(`[${e.idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${e.vol},adelay=${e.delay}|${e.delay}[sfx${k}]`)
    mixLabels.push(`[sfx${k}]`)
  })
  if (!mixLabels.length) {
    // 没有旁白、没有 BGM、没有 SFX：给一条静音底，保证 video.mp4 始终带音轨（自审响度才有东西可测）
    fc.push(`anullsrc=r=48000:cl=stereo,atrim=0:${total.toFixed(3)},${LOUDNORM},aresample=48000[aout]`)
  } else {
    fc.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:normalize=0,${LOUDNORM},aresample=48000[aout]`)
  }
  args.push(...inputs, '-filter_complex', fc.join(';'), '-map', '[aout]',
    '-t', total.toFixed(3), '-ar', '48000', '-ac', '2', outPath)
  return args
}

/** 从 ffmpeg stderr 里解析 Duration（测试也用它）。 */
export function parseDurationText(text) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(text || ''))
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/** BGM 名 → 实际文件（支持 'soft-groove' / 'soft-groove.mp3' / 绝对路径）。找不到返回 null。 */
export function resolveBgm(name) {
  const raw = String(name ?? '').trim() || 'soft-groove'
  const cands = []
  if (path.isAbsolute(raw)) cands.push(raw)
  else {
    cands.push(raw, path.join(BGM_DIR, raw), path.join(BGM_DIR, `${raw}.mp3`), path.join(BGM_DIR, `${raw}.wav`))
  }
  for (const c of cands) {
    try {
      if (fs.statSync(c).isFile()) return c
    } catch { /* 继续找下一个 */ }
  }
  return null
}

/** 现有 SFX 文件表（缺哪个就跳过哪个，不报错）。 */
export function resolveSfx() {
  const out = {}
  for (const name of SFX_NAMES) {
    const p = path.join(SFX_DIR, `${name}.wav`)
    try {
      if (fs.statSync(p).size > 500) out[name] = p
    } catch { /* ignore */ }
  }
  return out
}

/** 默认进程执行器（单测用 deps.exec 替换掉它）。 */
export function defaultExec(exe, args, opts = {}) {
  // config 由 renderVideo 透传进来；调用方不传时就按当前进程配置解析（CLI 直接跑也成立）。
  const { config, ...spawnOpts } = opts
  const env = {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: '1',
    // 别把 __pycache__ / 表情帧缓存写进插件包：env WHALE_VIDEO_CACHE 最优先，
    // 其次配置 video.paths.cache，最后 <DSH_HOME>/bili-faship/cache（DESIGN §3）
    WHALE_VIDEO_CACHE: cacheRoot(config),
  }
  // 表情包目录：配置优先于 env；解析结果显式传给 Python，避免 JS / Python 两边各自猜。
  // 解析失败（配置损坏）时什么都不塞，让 Python 走自己的兜底链。
  try {
    const dir = stickerDir(config)
    if (dir) env.WHALE_STICKER_DIR = dir
  } catch { /* ignore：Python lib.py 还有一层兜底 */ }
  return spawnSync(exe, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: spawnOpts.timeout ?? 30 * 60 * 1000,
    cwd: spawnOpts.cwd,
    env,
  })
}

function run(depsExec, exe, args, opts = {}) {
  const exec = depsExec.exec || defaultExec
  const p = exec(exe, args, opts)
  const stderr = String((p && p.stderr) || '')
  const stdout = String((p && p.stdout) || '')
  if (!p || p.error || p.status !== 0) {
    const reason = (p && p.error && p.error.message) || stderr.slice(-2000) || stdout.slice(-1000) || '未知错误'
    throw new Error(`${path.basename(exe)} 失败（exit ${p ? p.status : '?'}）：${reason}`)
  }
  return { stdout, stderr }
}

function probeDuration(depsExec, ffmpeg, file) {
  const exec = depsExec.exec || defaultExec
  const p = exec(ffmpeg, ['-hide_banner', '-nostdin', '-i', file], { timeout: 60000 })
  const text = `${(p && p.stderr) || ''}\n${(p && p.stdout) || ''}`
  const d = parseDurationText(text)
  if (!(d > 0)) throw new Error(`读不出音频时长：${file}`)
  return d
}

function trimTailSilence(depsExec, ffmpeg, mp3, wav) {
  const af = 'areverse,silenceremove=start_periods=1:start_duration=0.05:start_threshold=-45dB,areverse,aresample=48000'
  run(depsExec, ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', mp3, '-af', af, '-ac', '2', wav], { timeout: 120000 })
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 渲染一条视频。
 * @param {{
 *   dir: string,
 *   config?: object,
 *   deps?: {synthesize?:Function, exec?:Function, python?:string, renderer?:string, ffmpeg?:string}
 * }} opts
 * @returns {Promise<object>} { dir, video, cover, subtitles, meta, timing, durationSec, warnings }
 */
export async function renderVideo({ dir, config, deps = {} } = {}) {
  if (!dir) throw new Error('renderVideo 需要 dir（视频工作目录）')
  const absDir = path.resolve(dir)
  const cfg = config || videoConfig()
  const warnings = []
  // deps.exec 是测试注入口；没注入时把当前配置绑定进默认执行器（缓存/表情包 env 跟着走）
  const depsExec = deps.exec
    ? deps
    : { ...deps, exec: (exe, args, o = {}) => defaultExec(exe, args, { ...o, config: cfg }) }

  const { story, warnings: storyWarnings } = readStoryboard(absDir)
  warnings.push(...(storyWarnings || []).map((w) => `${w.path}: ${w.message}`))
  const ffmpeg = deps.ffmpeg || requireFfmpeg()
  const synthesize = deps.synthesize || (await import('./tts.mjs')).synthesize
  // Python：配置 video.paths.python → env WHALE_PYTHON → 'python'（DESIGN §3）
  const python = deps.python || pythonPath(cfg)
  const renderer = deps.renderer || RENDERER
  if (!fs.existsSync(renderer)) throw new Error(`找不到渲染器脚本：${renderer}`)

  const width = Number(story.width)
  const height = Number(story.height)
  const fps = Number(story.fps)
  if (width % 2 || height % 2) throw new Error(`画布宽高必须是偶数（当前 ${width}x${height}）`)

  const voice = {
    voice: story.voice?.voice || cfg.voice?.voice || 'zh-CN-XiaoyiNeural',
    rate: story.voice?.rate || cfg.voice?.rate || '+0%',
    pitch: story.voice?.pitch || cfg.voice?.pitch || '+0Hz',
  }

  fs.mkdirSync(absDir, { recursive: true })
  const work = path.join(absDir, `.work-${process.pid}-${Date.now()}`)
  fs.mkdirSync(work, { recursive: true })
  const ttsDir = path.join(work, 'tts')
  fs.mkdirSync(ttsDir, { recursive: true })

  try {
    // ---- 逐场 TTS ----
    const ttsDurById = {}
    const ttsRows = []
    for (const [i, scene] of story.scenes.entries()) {
      const narration = String(scene.narration || '').trim()
      if (!narration) continue
      const tag = `s${String(i).padStart(2, '0')}`
      const mp3 = path.join(ttsDir, `${tag}.mp3`)
      const wav = path.join(ttsDir, `${tag}.wav`)
      await synthesize({ text: narration, voice: voice.voice, rate: voice.rate, pitch: voice.pitch, outMp3: mp3 })
      if (!fs.existsSync(mp3) || fs.statSync(mp3).size < 800) throw new Error(`TTS 产物异常（场景 ${scene.id}）：${mp3}`)
      trimTailSilence(depsExec, ffmpeg, mp3, wav)
      const d = probeDuration(depsExec, ffmpeg, wav)
      ttsDurById[scene.id] = d
      ttsRows.push({ i, scene, narration, tts: wav, ttsDur: d })
    }

    // ---- 时间轴 / 字幕 ----
    const baseTimeline = buildTimeline(story.scenes, { ttsDurById })
    const byId = new Map(ttsRows.map((r) => [r.scene.id, r]))
    const timeline = baseTimeline.map((r) => ({ ...r, tts: byId.get(r.scene.id)?.tts || null }))
    const cues = buildCues(timeline)
    const timing = buildTiming({ story, timeline, cues })
    const total = timing.total
    if (!(total > 0)) throw new Error('时间轴总长为 0（storyboard.scenes 是不是空的？）')
    const timingPath = path.join(work, 'timing.json')
    const subtitlesPath = path.join(work, 'subtitles.srt')
    writeJson(timingPath, timing)
    fs.writeFileSync(subtitlesPath, srtFromCues(cues), 'utf8')

    // ---- 混音 ----
    const bgmPath = resolveBgm(story.audio?.bgm ?? 'soft-groove')
    if (!bgmPath) warnings.push(`没有找到 BGM「${story.audio?.bgm ?? 'soft-groove'}」，本条无背景音乐`)
    const sfx = resolveSfx()
    const bgmVolume = Number(story.audio?.bgmVolume ?? 0.72)
    const audioPath = path.join(work, 'audio.wav')
    const audioArgs = buildAudioArgs({ timeline, total, bgmPath, bgmVolume, sfx, outPath: audioPath })
    run(depsExec, ffmpeg, audioArgs, { timeout: 10 * 60 * 1000 })

    // ---- 逐帧渲染 + 合成 ----
    const silentPath = path.join(work, 'silent.mp4')
    const coverPath = path.join(work, 'cover.jpg')
    run(depsExec, python, [
      renderer, '--story', storyboardPath(absDir), '--timing', timingPath,
      '--out', silentPath, '--cover', coverPath,
      '--ffmpeg', ffmpeg, '--width', String(width), '--height', String(height),
      '--work-dir', absDir,
    ], { timeout: 60 * 60 * 1000 })

    const videoPath = path.join(work, 'video.mp4')
    run(depsExec, ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-i', silentPath, '-i', audioPath,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
      '-t', total.toFixed(3), videoPath,
    ], { timeout: 10 * 60 * 1000 })

    // ---- 元信息 ----
    const meta = {
      slug: story.slug,
      title: story.title,
      date: story.date,
      width,
      height,
      fps,
      durationSec: +total.toFixed(2),
      voice: { ...voice },
      bgm: bgmPath ? path.basename(bgmPath) : null,
      bgmVolume,
      scenes: timeline.map((r) => ({
        id: r.scene.id,
        start: +r.start.toFixed(2),
        dur: +r.dur.toFixed(2),
        mascot: r.scene.mascot,
        card: (r.scene.card || {}).kind,
        narration: r.narration,
        ttsDur: +r.ttsDur.toFixed(2),
        stamp: r.scene.stamp ? r.scene.stamp.text : null,
        shout: r.scene.shout ? r.scene.shout.text : null,
      })),
      aiLabel: (story.topbar && story.topbar.right) || story.publish?.aiLabel || '',
      files: { video: 'video.mp4', cover: 'cover.jpg', subtitles: 'subtitles.srt', timing: 'timing.json' },
      generatedAt: new Date().toISOString(),
      warnings,
    }
    const metaPath = path.join(work, 'meta.json')
    writeJson(metaPath, meta)

    // ---- 原子落盘：最后一步才把文件挪进 <dir> ----
    const outputs = [
      ['video.mp4', videoPath],
      ['cover.jpg', coverPath],
      ['subtitles.srt', subtitlesPath],
      ['timing.json', timingPath],
      ['meta.json', metaPath],
    ]
    for (const [name, src] of outputs) {
      const dest = path.join(absDir, name)
      try {
        fs.renameSync(src, dest)
      } catch (e) {
        // 跨盘/被占用时退回 copy+unlink（仍然只在全部成功后调用）
        fs.copyFileSync(src, dest)
        fs.rmSync(src, { force: true })
      }
    }

    return {
      dir: absDir,
      video: path.join(absDir, 'video.mp4'),
      cover: path.join(absDir, 'cover.jpg'),
      subtitles: path.join(absDir, 'subtitles.srt'),
      timing: path.join(absDir, 'timing.json'),
      meta: path.join(absDir, 'meta.json'),
      durationSec: meta.durationSec,
      story,
      warnings,
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}
