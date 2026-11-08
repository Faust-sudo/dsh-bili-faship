/**
 * review.mjs — 成片自审（代码闸门，不是提示词）。
 *
 * 自审是发布的前置条件（publish.mjs 只认 review.json.pass === true）。
 * 硬闸门（任一失败 → pass:false，exit 1）：
 *   1. schema            storyboard 结构合法
 *   2. duration          成片时长在 [minDurationSec, maxDurationSec]
 *   3. loudness          集成响度在 loudnessRange（ffmpeg ebur128 实测；可注入 deps.loudness）
 *   4. aiLabel           画面顶栏或投稿简介里有「AI 生成」标注
 *   5. citations         引用片段每条都有 up/标题/BV，且 clipSec ≤ maxClipSec
 *   6. redline           红线词 / 冒充真人短语不出现在她的内容里
 *   7. subtitleCoverage  有旁白的场次字幕覆盖率 ≥ minSubtitleCoverage
 *
 * 评分 0-100：硬闸门按权重计分（全过 = 100）；passScore 只是附加线，不决定 pass
 *（合同要求「硬闸门任一失败 = pass:false；passScore 只作为附加线」）。
 *
 * 输出 <dir>/review.json：{ pass, score, checks:[{id, ok, detail, hard}], reviewedAt }
 *
 * ⚠️ 自审是「尽力而为」的文本/数值检查，不替代人工判断：
 *    它抓不到反讽、抓不到画面里的文字（只查 storyboard 文本），也抓不到未入库的红线词。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { requireFfmpeg } from '../lib/ffmpeg.mjs'
import { videoConfig } from '../lib/video-config.mjs'
import { readStoryboard, readJson, storyboardPath } from './storyboard.mjs'

export const REVIEW_FILE = 'review.json'

/** 冒充真人短语（红线：不冒充真人）。按出现即失败处理。 */
export const IMPERSONATION_PHRASES = [
  '我是真人',
  '我是真实的人',
  '我是活人',
  '我是人类',
  '我是真人出镜',
  '真人在线',
  '我不是AI',
  '我不是 AI',
  '不是AI生成的',
  '不是 AI 生成的',
  '我是本人',
]

/** 自审硬闸门权重（合计 100）。 */
export const HARD_WEIGHTS = {
  schema: 20,
  duration: 12,
  loudness: 12,
  aiLabel: 16,
  citations: 12,
  redline: 16,
  subtitleCoverage: 12,
}

const AI_LABEL_RE = /AI\s*生成|AI\s*合成|人工智能生成/i
const BV_RE = /^BV[0-9A-Za-z]{8,12}$/

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0

function safeReadJson(file) {
  try {
    return readJson(file)
  } catch {
    return null
  }
}

/**
 * 收集「她自己说的/写的」文本（用于红线扫描）：
 * 只扫用户可见内容；**不扫** `_` 开头的内部提示、也不扫 citations 里别人的标题/UP 名
 *（引用必须如实标注原题，原题里有敏感词不该算她的锅；引用三要素另由 citations 闸门查）。
 * @returns {Array<{where:string, text:string}>}
 */
export function collectStoryText(story) {
  const out = []
  if (!isObj(story)) return out
  const push = (where, text) => {
    if (typeof text === 'string' && text.trim()) out.push({ where, text })
  }
  push('title', story.title)
  push('coverTitle', story.coverTitle)
  push('coverSub', story.coverSub)
  push('footer', story.footer)
  if (isObj(story.topbar)) {
    push('topbar.badge', story.topbar.badge)
    push('topbar.label', story.topbar.label)
    push('topbar.right', story.topbar.right)
  }
  if (isObj(story.publish)) {
    push('publish.titleForPost', story.publish.titleForPost)
    push('publish.description', story.publish.description)
    if (Array.isArray(story.publish.tags)) story.publish.tags.forEach((t, i) => push(`publish.tags[${i}]`, t))
  }
  const cardFields = ['text', 'sub', 'title', 'speaker', 'note']
  for (const [i, scene] of (Array.isArray(story.scenes) ? story.scenes : []).entries()) {
    const p = `scenes[${i}]`
    push(`${p}.narration`, scene?.narration)
    if (isObj(scene?.stamp)) push(`${p}.stamp.text`, scene.stamp.text)
    if (isObj(scene?.shout)) push(`${p}.shout.text`, scene.shout.text)
    if (Array.isArray(scene?.subtitleEmph)) scene.subtitleEmph.forEach((t, k) => push(`${p}.subtitleEmph[${k}]`, t))
    const card = scene?.card
    if (!isObj(card)) continue
    for (const f of cardFields) push(`${p}.card.${f}`, card[f])
    if (Array.isArray(card.lines)) card.lines.forEach((t, k) => push(`${p}.card.lines[${k}]`, t))
    if (Array.isArray(card.items)) {
      card.items.forEach((it, k) => {
        if (isObj(it)) {
          for (const f of ['text', 'sub', 'title', 'up', 'note']) push(`${p}.card.items[${k}].${f}`, it[f])
        } else push(`${p}.card.items[${k}]`, it)
      })
    }
    if (Array.isArray(card.rows)) {
      card.rows.forEach((r, k) => {
        if (isObj(r)) {
          push(`${p}.card.rows[${k}].label`, r.label)
          push(`${p}.card.rows[${k}].value`, r.value)
        } else push(`${p}.card.rows[${k}]`, r)
      })
    }
    if (Array.isArray(card.messages)) {
      card.messages.forEach((m, k) => {
        if (isObj(m)) {
          push(`${p}.card.messages[${k}].text`, m.text)
          push(`${p}.card.messages[${k}].from`, m.from)
        } else push(`${p}.card.messages[${k}]`, m)
      })
    }
  }
  return out
}

/** 红线扫描：bannedWords + 冒充真人短语。返回命中列表。 */
export function scanRedlines(textItems, { bannedWords = [], impersonation = IMPERSONATION_PHRASES } = {}) {
  const hits = []
  const banned = (bannedWords || []).filter((w) => typeof w === 'string' && w.trim())
  for (const { where, text } of textItems || []) {
    for (const word of banned) {
      if (text.includes(word)) hits.push({ where, matched: word, kind: 'banned' })
    }
    for (const phrase of impersonation) {
      if (text.includes(phrase)) hits.push({ where, matched: phrase, kind: 'impersonation' })
    }
  }
  return hits
}

/** 引用闸门：每条都必须有 up/标题/BV，且 clipSec 是正数、≤ maxClipSec。 */
export function checkCitations(citations, maxClipSec) {
  const list = Array.isArray(citations) ? citations : []
  const problems = []
  list.forEach((c, i) => {
    const p = `citations[${i}]`
    if (!isObj(c)) { problems.push(`${p} 不是对象`); return }
    for (const k of ['bv', 'up', 'title']) {
      if (!nonEmpty(c[k])) problems.push(`${p}.${k} 缺失`)
    }
    if (nonEmpty(c.bv) && !BV_RE.test(String(c.bv))) problems.push(`${p}.bv 格式不对：${c.bv}`)
    if (!(typeof c.clipSec === 'number' && Number.isFinite(c.clipSec) && c.clipSec > 0)) {
      problems.push(`${p}.clipSec 缺失或不是正数`)
    } else if (c.clipSec > maxClipSec) {
      problems.push(`${p}.clipSec=${c.clipSec}s 超过上限 ${maxClipSec}s`)
    }
  })
  return { ok: problems.length === 0, count: list.length, problems }
}

/** 字幕覆盖：有旁白的场次里，有多少场在 timing.cues 里至少有一条字幕。 */
export function computeSubtitleCoverage(story, timing) {
  const scenes = Array.isArray(story?.scenes) ? story.scenes : []
  const withNarration = scenes.map((s, i) => ({ i, has: nonEmpty(s?.narration) })).filter((x) => x.has)
  if (!withNarration.length) return { ratio: 1, total: 0, covered: 0, missing: [] }
  const cueScenes = new Set((Array.isArray(timing?.cues) ? timing.cues : []).map((c) => c.scene))
  const missing = withNarration.filter((x) => !cueScenes.has(x.i)).map((x) => `scenes[${x.i}]`)
  return { ratio: (withNarration.length - missing.length) / withNarration.length, total: withNarration.length, covered: withNarration.length - missing.length, missing }
}

/** 从 meta.json / timing.json 里取成片时长。 */
export function resolveDuration(meta, timing) {
  if (isObj(meta) && typeof meta.durationSec === 'number' && Number.isFinite(meta.durationSec) && meta.durationSec > 0) return meta.durationSec
  if (isObj(timing) && typeof timing.total === 'number' && Number.isFinite(timing.total) && timing.total > 0) return timing.total
  return null
}

/** 找「AI 生成」标注：**画面（topbar）与简介（publish）都必须有**（红线第一条）。
 *  v0.2.0 只要求"任意一处"，实测 topbar.right 为空、只有简介标注也能 pass 100 —— 画面无标注就发出去了。 */
export function findAiLabel(story) {
  const screen = []
  if (isObj(story?.topbar)) {
    if (nonEmpty(story.topbar.right)) screen.push(['topbar.right', story.topbar.right])
    if (nonEmpty(story.topbar.label)) screen.push(['topbar.label', story.topbar.label])
  }
  const description = []
  if (isObj(story?.publish)) {
    if (nonEmpty(story.publish.description)) description.push(['publish.description', story.publish.description])
    if (nonEmpty(story.publish.aiLabel)) description.push(['publish.aiLabel', story.publish.aiLabel])
  }
  const screenHit = screen.find(([, text]) => AI_LABEL_RE.test(text)) || null
  const descHit = description.find(([, text]) => AI_LABEL_RE.test(text)) || null
  return {
    ok: Boolean(screenHit && descHit),
    screenOk: Boolean(screenHit),
    descriptionOk: Boolean(descHit),
    screen: screenHit ? { where: screenHit[0], text: screenHit[1] } : null,
    description: descHit ? { where: descHit[0], text: descHit[1] } : null,
    where: (screenHit || descHit || [])[0] ?? null,
  }
}

const softPenalty = (ok) => (ok ? 0 : 4)

/**
 * 纯评估（不读盘、不跑 ffmpeg）：给 reviewVideo / 单测共用。
 * @param {{
 *   story: object|null, storyboardError?: string|null,
 *   meta: object|null, timing: object|null,
 *   loudness: number|null|undefined,
 *   config: object, now?: Date
 * }} input
 */
export function evaluateReview({ story, storyboardError = null, meta = null, timing = null, loudness = null, config = {}, now = new Date(), videoPresent = true, videoDurationSec = null } = {}) {
  const cfg = config || {}
  const sr = cfg.selfReview || {}
  const rl = cfg.redlines || {}
  const minDur = Number(cfg.minDurationSec ?? 15)
  const maxDur = Number(cfg.maxDurationSec ?? 180)
  const loudRange = Array.isArray(sr.loudnessRange) ? sr.loudnessRange : [-20, -12]
  const minCoverage = Number(sr.minSubtitleCoverage ?? 0.9)
  const maxClipSec = Number(sr.maxClipSec ?? 3)
  const passScore = Number(sr.passScore ?? 80)
  const checks = []

  const add = (id, hard, ok, detail) => checks.push({ id, hard, ok: !!ok, detail: String(detail) })

  // 1) schema
  if (storyboardError) add('schema', true, false, storyboardError)
  else if (!isObj(story)) add('schema', true, false, '没有读到合法 storyboard')
  else add('schema', true, true, `storyboard version ${story.version} · ${story.scenes?.length ?? 0} 场`)

  // 2) duration —— 优先用 video.mp4 的**实测**时长（v0.2.0 只信 meta.json：改大 meta.durationSec 就能让 2 秒片过时长闸）
  const realDur = typeof videoDurationSec === 'number' && Number.isFinite(videoDurationSec) && videoDurationSec > 0 ? videoDurationSec : null
  const durationSec = realDur ?? resolveDuration(meta, timing)
  const durSrc = realDur ? 'video.mp4 实测' : 'meta/timing（没测到视频）'
  if (!videoPresent) add('duration', true, false, '没有 video.mp4（先 video render）')
  else if (durationSec === null) add('duration', true, false, '缺 meta.json / timing.json，测不出成片时长（先 video render）')
  else if (durationSec < minDur) add('duration', true, false, `成片 ${durationSec.toFixed(1)}s（${durSrc}）< 下限 ${minDur}s`)
  else if (durationSec > maxDur) add('duration', true, false, `成片 ${durationSec.toFixed(1)}s（${durSrc}）> 上限 ${maxDur}s`)
  else add('duration', true, true, `成片 ${durationSec.toFixed(1)}s（${durSrc}）∈ [${minDur}, ${maxDur}]s`)

  // 3) loudness
  const [lo, hi] = loudRange
  if (typeof loudness !== 'number' || !Number.isFinite(loudness)) {
    add('loudness', true, false, '测不出集成响度（缺 video.mp4 / 音轨，或 ffmpeg ebur128 失败）')
  } else if (loudness < lo || loudness > hi) {
    add('loudness', true, false, `集成响度 ${loudness.toFixed(1)} LUFS 不在 [${lo}, ${hi}] LUFS`)
  } else {
    add('loudness', true, true, `集成响度 ${loudness.toFixed(1)} LUFS ∈ [${lo}, ${hi}] LUFS`)
  }

  // 4) AI 标注（红线：AI 生成如实标注；**不可通过配置关闭**）
  const ai = findAiLabel(story)
  if (ai.ok) add('aiLabel', true, true, `画面（${ai.screen.where}）与简介（${ai.description.where}）都已标注 AI 生成`)
  else {
    add('aiLabel', true, false,
      `AI 标注不完整（画面${ai.screenOk ? '✓' : '✗ 需要 topbar.right 写「AI 生成」'}；简介${ai.descriptionOk ? '✓' : '✗ 需要 publish.description 写「AI 生成」'}）` +
      ' —— 这是红线，配置不能关闭')
  }

  // 5) 引用
  const citations = checkCitations(story?.citations, maxClipSec)
  if (!citations.ok) add('citations', true, false, citations.problems.join('；'))
  else add('citations', true, true, citations.count ? `${citations.count} 条引用都带 UP/标题/BV 且 ≤ ${maxClipSec}s` : '无引用片段')

  // 6) 红线
  const redlineHits = scanRedlines(collectStoryText(story), {
    bannedWords: rl.bannedWords || [],
    impersonation: rl.forbidImpersonation === false ? [] : IMPERSONATION_PHRASES,
  })
  if (redlineHits.length) {
    add('redline', true, false, redlineHits.map((h) => `${h.where} 含「${h.matched}」`).join('；'))
  } else {
    add('redline', true, true, '未出现红线词 / 冒充真人短语')
  }

  // 7) 字幕覆盖
  const coverage = computeSubtitleCoverage(story, timing)
  if (coverage.ratio < minCoverage) {
    add('subtitleCoverage', true, false, `字幕覆盖 ${(coverage.ratio * 100).toFixed(0)}%（${coverage.covered}/${coverage.total}）< ${(minCoverage * 100).toFixed(0)}%；缺 ${coverage.missing.join(', ')}`)
  } else {
    add('subtitleCoverage', true, true, `字幕覆盖 ${(coverage.ratio * 100).toFixed(0)}%（${coverage.covered}/${coverage.total}）`)
  }

  // ---- 软检查（只影响分数，不决定 pass） ----
  const artifactsOk = isObj(meta) && isObj(meta.files)
  add('artifacts', false, artifactsOk, artifactsOk ? 'meta.json 记录了产物清单（video/cover/subtitles/timing）' : 'meta.json 缺产物清单（可能没 render 完）')
  const pub = story?.publish
  const publishOk = isObj(pub) && nonEmpty(pub.titleForPost) && nonEmpty(pub.description)
  add('publishMetadata', false, publishOk, publishOk ? '投稿标题/简介已填' : 'publish.titleForPost / publish.description 没填全（投稿包会缺内容）')

  // ---- 计分：硬闸门权重 + 软检查小扣分；pass 只看硬闸门 ----
  let score = 0
  for (const c of checks) {
    if (!c.hard) continue
    if (c.ok) score += HARD_WEIGHTS[c.id] ?? 0
  }
  for (const c of checks) if (!c.hard && !c.ok) score -= softPenalty(c.ok)
  score = Math.max(0, Math.min(100, Math.round(score)))
  const pass = checks.filter((c) => c.hard).every((c) => c.ok)
  const scoreLineOk = score >= passScore
  checks.push({
    id: 'scoreLine',
    hard: false,
    ok: scoreLineOk,
    detail: `评分 ${score} / 附加上线 ${passScore}${scoreLineOk ? '' : '（低于附加线，但不改变 pass；建议返工提质）'}`,
  })

  return {
    pass,
    score,
    checks,
    durationSec,
    loudnessLUFS: typeof loudness === 'number' && Number.isFinite(loudness) ? loudness : null,
    reviewedAt: now.toISOString(),
  }
}

/**
 * 用 ffmpeg ebur128 测集成响度（LUFS）。
 * 解析的是 ebur128 Summary 里的 `I: -16.2 LUFS`；失败返回 null（不抛错，交给闸门报"测不出"）。
 */
export function measureLoudness(videoPath, { ffmpeg } = {}) {
  if (!videoPath || !fs.existsSync(videoPath)) return null
  let exe = ffmpeg
  if (!exe) {
    try {
      exe = requireFfmpeg()
    } catch {
      return null
    }
  }
  const p = spawnSync(exe, ['-hide_banner', '-nostats', '-i', videoPath, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60 * 1000,
  })
  const text = `${(p && p.stderr) || ''}\n${(p && p.stdout) || ''}`
  const re = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g
  let m
  let last = null
  while ((m = re.exec(text))) last = m[1]
  if (last === null) return null
  const v = Number(last)
  return Number.isFinite(v) ? v : null
}

/** 用 ffmpeg 读 video.mp4 的真实时长（秒）；读不到返回 null（交给 meta 兜底）。 */
export function measureDuration(videoPath, { ffmpeg } = {}) {
  if (!videoPath || !fs.existsSync(videoPath)) return null
  let exe = ffmpeg
  if (!exe) {
    try { exe = requireFfmpeg() } catch { return null }
  }
  const p = spawnSync(exe, ['-hide_banner', '-i', videoPath], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  const text = `${(p && p.stderr) || ''}\n${(p && p.stdout) || ''}`
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
  if (!m) return null
  const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return Number.isFinite(sec) && sec > 0 ? sec : null
}

/**
 * 自审一条视频：读 <dir>/storyboard.json + meta.json + timing.json + video.mp4，
 * 跑硬闸门，写 <dir>/review.json。
 * @param {{dir:string, config?:object, deps?:{loudness?:Function, duration?:Function, ffmpeg?:string}}} opts
 * @returns {Promise<{pass:boolean, score:number, checks:Array, reviewedAt:string, dir:string, reviewPath:string}>}
 */
export async function reviewVideo({ dir, config, deps = {} } = {}) {
  if (!dir) throw new Error('reviewVideo 需要 dir（视频工作目录）')
  const absDir = path.resolve(dir)
  const cfg = config || videoConfig()
  const file = path.join(absDir, 'storyboard.json')
  if (!fs.existsSync(file)) throw new Error(`没有找到 ${file}（先跑 video render）`)

  let story = null
  let storyboardError = null
  try {
    const r = readStoryboard(absDir)
    story = r.story
  } catch (e) {
    storyboardError = e.message
  }
  const meta = safeReadJson(path.join(absDir, 'meta.json'))
  const timing = safeReadJson(path.join(absDir, 'timing.json'))
  const videoPath = path.join(absDir, 'video.mp4')
  const videoPresent = fs.existsSync(videoPath)

  let loudness = null
  try {
    if (typeof deps.loudness === 'function') loudness = await deps.loudness(videoPath, { dir: absDir })
    else loudness = measureLoudness(videoPath, { ffmpeg: deps.ffmpeg })
  } catch (e) {
    loudness = null
  }
  let videoDurationSec = null
  try {
    if (typeof deps.duration === 'function') videoDurationSec = await deps.duration(videoPath, { dir: absDir })
    else videoDurationSec = measureDuration(videoPath, { ffmpeg: deps.ffmpeg })
  } catch (e) {
    videoDurationSec = null
  }

  const result = evaluateReview({ story, storyboardError, meta, timing, loudness, config: cfg, videoPresent, videoDurationSec })
  // 记录"审的是哪一版视频/故事板"：render 换了视频、或 storyboard 改过之后，publish 能用它判 review 过期
  const mtimeOf = (f) => { try { return fs.statSync(path.join(absDir, f)).mtimeMs } catch { return null } }
  const evidence = {
    videoMtimeMs: mtimeOf('video.mp4'),
    storyboardMtimeMs: mtimeOf('storyboard.json'),
    metaMtimeMs: mtimeOf('meta.json'),
    videoDurationSec: videoDurationSec ?? null,
  }
  const reviewPath = path.join(absDir, REVIEW_FILE)
  const tmp = `${reviewPath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify({ ...result, dir: absDir, evidence }, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, reviewPath)
  return { ...result, dir: absDir, reviewPath, evidence }
}

/** 读已有的 review.json（status / publish 用）；不存在返回 null。 */
export function readReview(dir) {
  return safeReadJson(path.join(dir, REVIEW_FILE))
}
