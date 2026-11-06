/**
 * storyboard.mjs — 视频脚本（storyboard）的 schema、校验、模板生成、读取。
 *
 * 合同见 VIDEO-CAPABILITY.md（version 4）；本文件只做「结构校验 + 模板 + 读写」，
 * 不碰 TTS/渲染/发布。render.mjs / review.mjs / commands/video.mjs 都从这里取 storyboard。
 *
 * 设计原则：
 *  · 校验只拦「会让渲染/自审出错」的结构问题；内容质量交给 review.mjs 的硬闸门；
 *  · 引用（citations）的三要素缺失**不在 schema 拦**（留给 review 以精确报错），
 *    这样 `video render` 可以先出片再自审/返工，而不是卡在 schema；
 *  · normalizeStoryboard() 只补默认值，不改用户写的内容。
 */
import fs from 'node:fs'
import path from 'node:path'
import { videoConfig } from '../lib/video-config.mjs'

export const STORYBOARD_VERSION = 4

/** 卡片种类（她的 12 种 UI 面板；none = 这场不放面板）。 */
export const CARD_KINDS = ['big', 'profile', 'stats', 'note', 'dm', 'list', 'videos', 'bubble', 'alert', 'cta', 'ending', 'none']

/** 表情包情绪键（对应 ~/.dsh/bili-whale/stickers/packs/大肥鱼 里的 GIF 前缀）。 */
export const MASCOT_KEYS = ['happy', 'surprised', 'idea', 'lazy', 'fish', 'hop', 'brave', 'heal', 'arrow', 'dian', 'special']

export const STAMP_POSITIONS = ['left', 'center', 'right']
export const SHOUT_POSITIONS = ['left', 'top', 'right']
export const SHOUT_COLORS = ['yellow', 'pink', 'cyan']

/** 一条视频的默认画布参数（storyboard 里可覆盖；小尺寸只用于快速端到端验证）。 */
export const DEFAULT_SIZE = { width: 1920, height: 1080, fps: 30 }

export const STORYBOARD_FILE = 'storyboard.json'

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v) => typeof v === 'string'
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const nonEmpty = (v) => isStr(v) && v.trim().length > 0

const BV_RE = /^BV[0-9A-Za-z]{8,12}$/
const VOICE_RE = /^[A-Za-z]{2,3}-[A-Za-z0-9-]+Neural$/
const RATE_RE = /^[+-]\d+%$/
const PITCH_RE = /^[+-]\d+Hz$/

function err(errors, p, message) {
  errors.push({ path: p, message })
}

/** 去掉 BOM 后解析 JSON（Windows 上手动编辑过的文件常带 BOM）。 */
export function readJson(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(text)
}

/** 目录里的 storyboard.json 路径。 */
export function storyboardPath(dir) {
  return path.join(dir, STORYBOARD_FILE)
}

/** 文本 → 文件名安全 slug（中文保留，空格/符号变 -）。 */
export function slugify(text, fallback = 'video') {
  const s = String(text ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  return s || fallback
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 本地日期 YYYY-MM-DD（用系统时区，和她的生物钟一致）。 */
export function today(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

/**
 * 补默认值（不校验、不抛错）：
 *  · 缺省尺寸/帧率/声音/顶栏/scenes 的杂项字段；
 *  · 给缺 id 的场次补 s1/s2…；给缺 card/mascot 的补 none/happy。
 * 返回新对象（深拷贝一层），不改入参。
 */
export function normalizeStoryboard(input) {
  const raw = isObj(input) ? input : {}
  const cfg = safeVideoConfig()
  const src = raw.scenes
  const scenes = (Array.isArray(src) ? src : []).map((scene, i) => {
    const s = isObj(scene) ? { ...scene } : {}
    if (!nonEmpty(s.id)) s.id = `s${i + 1}`
    if (!nonEmpty(s.narration)) s.narration = ''
    if (!nonEmpty(s.mascot)) s.mascot = 'happy'
    const card = isObj(s.card) ? { ...s.card } : {}
    if (!nonEmpty(card.kind)) card.kind = 'none'
    s.card = card
    if (s.stamp !== undefined && s.stamp !== null && !isObj(s.stamp)) s.stamp = null
    if (s.shout !== undefined && s.shout !== null && !isObj(s.shout)) s.shout = null
    if (!Array.isArray(s.subtitleEmph)) s.subtitleEmph = []
    if (s.minDuration !== undefined && !isNum(s.minDuration)) delete s.minDuration
    return s
  })
  const story = { ...raw, scenes }
  if (!isNum(story.version)) story.version = STORYBOARD_VERSION
  if (!isNum(story.width)) story.width = DEFAULT_SIZE.width
  if (!isNum(story.height)) story.height = DEFAULT_SIZE.height
  if (!isNum(story.fps)) story.fps = DEFAULT_SIZE.fps
  if (!isObj(story.topbar)) story.topbar = {}
  if (!isObj(story.voice)) story.voice = { ...(cfg.voice || {}) }
  if (!isObj(story.audio)) story.audio = {}
  if (!isObj(story.publish)) story.publish = {}
  if (!Array.isArray(story.citations)) story.citations = []
  if (!nonEmpty(story.date)) story.date = today()
  return story
}

function safeVideoConfig() {
  try {
    return videoConfig()
  } catch {
    return { voice: { voice: 'zh-CN-XiaoyiNeural', rate: '+8%', pitch: '+8Hz' } }
  }
}

/**
 * 校验 storyboard（不抛错）。
 * @returns {{ok:boolean, errors:Array<{path:string,message:string}>, warnings:Array<{path:string,message:string}>}}
 */
export function validateStoryboard(input) {
  const errors = []
  const warnings = []
  if (!isObj(input)) {
    return { ok: false, errors: [{ path: '$', message: 'storyboard 必须是 JSON 对象' }], warnings }
  }
  const story = input

  if (story.version !== STORYBOARD_VERSION) {
    err(errors, 'version', `version 必须是 ${STORYBOARD_VERSION}，当前是 ${JSON.stringify(story.version)}`)
  }
  if (!nonEmpty(story.slug)) err(errors, 'slug', 'slug 不能为空（用于目录名）')
  else if (!/^[^\\/:*?"<>|\s]+$/.test(story.slug)) warnings.push({ path: 'slug', message: 'slug 含空格或特殊字符，目录名会被自动替换' })
  if (!nonEmpty(story.title)) err(errors, 'title', 'title 不能为空（封面/投稿都要用）')
  if (story.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(story.date))) {
    err(errors, 'date', 'date 应是 YYYY-MM-DD')
  }

  for (const key of ['width', 'height']) {
    const v = story[key]
    if (!Number.isInteger(v) || v < 64 || v > 3840) {
      err(errors, key, `${key} 必须是 64–3840 的整数（当前 ${JSON.stringify(v)}）`)
    } else if (v % 2 !== 0) {
      err(errors, key, `${key} 必须是偶数（H.264 yuv420p 要求，当前 ${v}）`)
    }
  }
  if (!Number.isInteger(story.fps) || story.fps < 1 || story.fps > 60) {
    err(errors, 'fps', `fps 必须是 1–60 的整数（当前 ${JSON.stringify(story.fps)}）`)
  }

  const voice = story.voice
  if (!isObj(voice)) err(errors, 'voice', 'voice 必须是对象（可省略，省略时用配置默认音色）')
  else {
    if (voice.voice !== undefined && !(isStr(voice.voice) && VOICE_RE.test(voice.voice))) {
      err(errors, 'voice.voice', `音色格式不对（应形如 zh-CN-XiaoyiNeural）：${JSON.stringify(voice.voice)}`)
    }
    if (voice.rate !== undefined && !(isStr(voice.rate) && RATE_RE.test(voice.rate))) {
      err(errors, 'voice.rate', `语速格式不对（应形如 +8%）：${JSON.stringify(voice.rate)}`)
    }
    if (voice.pitch !== undefined && !(isStr(voice.pitch) && PITCH_RE.test(voice.pitch))) {
      err(errors, 'voice.pitch', `音调格式不对（应形如 +8Hz）：${JSON.stringify(voice.pitch)}`)
    }
  }

  if (!Array.isArray(story.scenes) || story.scenes.length === 0) {
    err(errors, 'scenes', 'scenes 必须是非空数组')
  } else {
    const ids = new Set()
    story.scenes.forEach((scene, i) => {
      const p = `scenes[${i}]`
      if (!isObj(scene)) { err(errors, p, '场景必须是对象'); return }
      if (!nonEmpty(scene.id)) err(errors, `${p}.id`, 'id 不能为空')
      else if (ids.has(scene.id)) err(errors, `${p}.id`, `id 重复：${scene.id}`)
      else ids.add(scene.id)
      if (scene.narration !== undefined && !isStr(scene.narration)) err(errors, `${p}.narration`, 'narration 必须是字符串')
      if (scene.mascot !== undefined && !MASCOT_KEYS.includes(scene.mascot)) {
        err(errors, `${p}.mascot`, `mascot 必须是 ${MASCOT_KEYS.join('/')} 之一（当前 ${JSON.stringify(scene.mascot)}）`)
      }
      const card = scene.card
      if (card !== undefined) {
        if (!isObj(card)) err(errors, `${p}.card`, 'card 必须是对象')
        else {
          const kind = card.kind
          if (!CARD_KINDS.includes(kind)) {
            err(errors, `${p}.card.kind`, `card.kind 必须是 ${CARD_KINDS.join('/')} 之一（当前 ${JSON.stringify(kind)}）`)
          } else {
            const need = CARD_REQUIRED[kind]
            if (need && !cardHasContent(need, card)) {
              warnings.push({ path: `${p}.card`, message: `kind=${kind} 缺少字段 ${need.join('/')}（渲染会画空面板，建议补上）` })
            }
          }
        }
      }
      checkOverlay(scene, 'stamp', i, errors)
      checkOverlay(scene, 'shout', i, errors)
      if (scene.subtitleEmph !== undefined && !Array.isArray(scene.subtitleEmph)) {
        err(errors, `${p}.subtitleEmph`, 'subtitleEmph 必须是字符串数组')
      }
      if (scene.minDuration !== undefined && !(isNum(scene.minDuration) && scene.minDuration >= 0 && scene.minDuration <= 60)) {
        err(errors, `${p}.minDuration`, 'minDuration 必须是 0–60 秒的数字')
      }
    })
  }

  const audio = story.audio
  if (audio !== undefined && !isObj(audio)) err(errors, 'audio', 'audio 必须是对象')
  else if (isObj(audio)) {
    if (audio.bgm !== undefined && !isStr(audio.bgm)) err(errors, 'audio.bgm', 'audio.bgm 必须是文件名（如 soft-groove）')
    if (audio.bgmVolume !== undefined && !(isNum(audio.bgmVolume) && audio.bgmVolume >= 0 && audio.bgmVolume <= 2)) {
      err(errors, 'audio.bgmVolume', 'audio.bgmVolume 必须是 0–2 之间的数字')
    }
  }

  const publish = story.publish
  if (publish !== undefined && !isObj(publish)) err(errors, 'publish', 'publish 必须是对象')
  else if (isObj(publish)) {
    if (publish.titleForPost !== undefined && !isStr(publish.titleForPost)) err(errors, 'publish.titleForPost', 'titleForPost 必须是字符串')
    if (publish.description !== undefined && !isStr(publish.description)) err(errors, 'publish.description', 'description 必须是字符串')
    if (publish.tags !== undefined && !Array.isArray(publish.tags)) err(errors, 'publish.tags', 'tags 必须是字符串数组')
  }

  const topbar = story.topbar
  if (topbar !== undefined && !isObj(topbar)) err(errors, 'topbar', 'topbar 必须是对象')
  else if (isObj(topbar)) {
    for (const k of ['badge', 'label', 'right']) {
      if (topbar[k] !== undefined && !isStr(topbar[k])) err(errors, `topbar.${k}`, `${k} 必须是字符串`)
    }
  }

  if (!Array.isArray(story.citations)) {
    err(errors, 'citations', 'citations 必须是数组（没有引用就写 []）')
  } else {
    story.citations.forEach((c, i) => {
      if (!isObj(c)) { err(errors, `citations[${i}]`, '引用必须是对象'); return }
      for (const k of ['bv', 'up', 'title']) {
        if (c[k] !== undefined && !isStr(c[k])) err(errors, `citations[${i}].${k}`, `${k} 必须是字符串`)
      }
      if (c.clipSec !== undefined && !(isNum(c.clipSec) && c.clipSec >= 0)) err(errors, `citations[${i}].clipSec`, 'clipSec 必须是非负数字')
    })
  }

  return { ok: errors.length === 0, errors, warnings }
}

const CARD_REQUIRED = {
  big: ['text'],
  profile: ['rows'],
  stats: ['rows'],
  note: ['lines'],
  dm: ['messages'],
  list: ['items'],
  videos: ['items'],
  bubble: ['text'],
  alert: ['text'],
  cta: [],
  ending: ['title'],
  none: [],
}

function cardHasContent(fields, card) {
  if (!fields.length) return true
  return fields.some((f) => {
    const v = card[f]
    return Array.isArray(v) ? v.length > 0 : isStr(v) ? v.trim().length > 0 : v !== undefined && v !== null
  })
}

function checkOverlay(scene, key, i, errors) {
  const v = scene[key]
  if (v === undefined || v === null) return
  const p = `scenes[${i}].${key}`
  if (!isObj(v)) { err(errors, p, `${key} 必须是对象或 null`); return }
  if (!nonEmpty(v.text)) err(errors, `${p}.text`, `${key}.text 不能为空`)
  if (key === 'stamp') {
    if (v.angle !== undefined && !isNum(v.angle)) err(errors, `${p}.angle`, 'angle 必须是数字')
    if (v.pos !== undefined && !STAMP_POSITIONS.includes(v.pos)) err(errors, `${p}.pos`, `pos 必须是 ${STAMP_POSITIONS.join('/')} 之一`)
  } else {
    if (v.angle !== undefined && !isNum(v.angle)) err(errors, `${p}.angle`, 'angle 必须是数字')
    if (v.pos !== undefined && !SHOUT_POSITIONS.includes(v.pos)) err(errors, `${p}.pos`, `pos 必须是 ${SHOUT_POSITIONS.join('/')} 之一`)
    if (v.color !== undefined && !SHOUT_COLORS.includes(v.color)) err(errors, `${p}.color`, `color 必须是 ${SHOUT_COLORS.join('/')} 之一`)
  }
}

function errorSummary(errors, warnings = []) {
  const lines = errors.map((e) => `  · ${e.path}: ${e.message}`)
  if (warnings.length) lines.push(...warnings.map((w) => `  ? ${w.path}: ${w.message}`))
  return lines.join('\n')
}

/** 校验并归一化；不合法时抛带可读清单的错误。 */
export function assertStoryboard(input) {
  const story = normalizeStoryboard(input)
  const result = validateStoryboard(story)
  if (!result.ok) {
    throw new Error(`storyboard 校验失败：\n${errorSummary(result.errors)}`)
  }
  story.__warnings = result.warnings
  return story
}

/**
 * 读 <dir>/storyboard.json → 归一化 + 校验。
 * 文件不存在/JSON 坏了/校验不过都会抛错（错误信息给人看）。
 * @returns {{story:object, path:string, warnings:Array}}
 */
export function readStoryboard(dir) {
  const file = storyboardPath(dir)
  let raw
  try {
    raw = readJson(file)
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new Error(`没有找到 ${file}（先跑 video plan --dir <dir> 生成模板）`)
    throw new Error(`读取 ${file} 失败：${e.message}`)
  }
  const story = normalizeStoryboard(raw)
  const result = validateStoryboard(story)
  if (!result.ok) throw new Error(`${file} 校验失败：\n${errorSummary(result.errors, result.warnings)}`)
  return { story, path: file, warnings: result.warnings }
}

/**
 * plan 模板：给一个「能直接渲染、改一改就能发」的骨架。
 * 已存在 storyboard.json 时只校验、不覆盖（见 writePlan）。
 *
 * @param {{topic?:string, persona?:string|object, slug?:string, date?:string, voice?:object,
 *   width?:number, height?:number, fps?:number}} opts
 */
export function planTemplate(opts = {}) {
  const cfg = safeVideoConfig()
  const topic = nonEmpty(opts.topic) ? String(opts.topic).trim() : '今天想聊点啥'
  const personaName = typeof opts.persona === 'string'
    ? opts.persona
    : (opts.persona && opts.persona.name) || '大肥鱼'
  const date = opts.date || today()
  const slug = opts.slug || slugify(topic, `video-${date}`)
  const voice = { ...(cfg.voice || {}), ...(isObj(opts.voice) ? opts.voice : {}) }
  const aiLabel = (cfg.redlines && cfg.redlines.requireAiLabel === false)
    ? ''
    : (cfg.publish && cfg.publish.aiLabel) || '本视频含 AI 生成内容'
  // 尺寸/帧率可覆盖（端到端验证用 320x180 小尺寸；正式片用默认 1920x1080）
  const width = Number.isInteger(opts.width) && opts.width > 0 ? opts.width : DEFAULT_SIZE.width
  const height = Number.isInteger(opts.height) && opts.height > 0 ? opts.height : DEFAULT_SIZE.height
  const fps = Number.isInteger(opts.fps) && opts.fps > 0 ? opts.fps : DEFAULT_SIZE.fps
  // 模板要「生成后不自审就挂」：按配置的最短时长给每场兜底，3 场也应 ≥ minDurationSec
  const minTotal = Number(cfg.minDurationSec ?? 15) || 15
  const perSceneMin = Math.max(2.6, Math.ceil((minTotal / 3) * 10) / 10)

  return {
    version: STORYBOARD_VERSION,
    slug,
    title: topic,
    date,
    width,
    height,
    fps,
    voice,
    topbar: {
      badge: 'Day 0',
      label: `AI 接管中 · ${personaName}的运营日志`,
      right: aiLabel,
    },
    scenes: [
      {
        id: 's1',
        narration: `今天想聊一件事：${topic}。`,
        mascot: 'happy',
        card: { kind: 'big', text: topic, sub: `${personaName} · ${date}` },
        stamp: null,
        shout: null,
        subtitleEmph: [],
        minDuration: perSceneMin,
      },
      {
        id: 's2',
        narration: '先说结论：这件事值得做，但别急着全信。',
        mascot: 'idea',
        card: {
          kind: 'list',
          title: '我看到的',
          items: [
            { text: '第一点（改这里）', sub: '一句解释' },
            { text: '第二点（改这里）', sub: '一句解释' },
          ],
          highlight: 0,
        },
        stamp: null,
        shout: null,
        subtitleEmph: ['结论'],
        minDuration: perSceneMin,
      },
      {
        id: 's3',
        narration: '今天就聊到这，评论区说说你怎么想。',
        mascot: 'happy',
        card: { kind: 'cta', title: '想聊什么，评论区写', items: ['关注', '点赞', '评论'] },
        stamp: null,
        shout: null,
        subtitleEmph: [],
        minDuration: perSceneMin,
      },
    ],
    audio: { bgm: 'soft-groove', bgmVolume: 0.72 },
    publish: {
      titleForPost: topic,
      description: `${topic}\n\n${aiLabel ? aiLabel + '\n' : ''}（这里是简介：写清观点来源和引用出处；引用他人片段必须带 UP/标题/BV，单段 ≤ 3 秒。）`,
      tags: [],
      aiLabel,
    },
    citations: [],
    _hints: {
      note: '这是 video plan 生成的骨架：改 scenes 里的 narration/card，再跑 video render/review。',
      persona: personaName,
      availableMascots: MASCOT_KEYS,
      cardKinds: CARD_KINDS,
      stampFields: '{ text, pos: left|center|right, angle }',
      shoutFields: '{ text, pos: left|top|right, color: yellow|pink|cyan, angle }',
      redlines: [
        'AI 生成要如实标注：topbar.right 或 publish.description 里必须有「AI 生成」',
        '不冒充真人：禁止「我是真人」「我不是AI」这类表述',
        '引用他人片段：citations 里每条都要有 up/title/bv，且 clipSec ≤ 配置的 maxClipSec（默认 3 秒）',
        '不刷量、不群发、不诱导互关',
      ],
      commands: [
        'node tools/bili-faship.mjs render --dir <dir>',
        'node tools/bili-faship.mjs review --dir <dir>',
        'node tools/bili-faship.mjs status',
      ],
    },
  }
}

/**
 * plan 落盘：<dir>/storyboard.json 不存在则写模板；已存在则只校验不覆盖。
 * @returns {{created:boolean, dir:string, file:string, story:object|null, result:{ok,errors,warnings}}}
 */
export function writePlan(dir, opts = {}) {
  const abs = path.resolve(dir)
  fs.mkdirSync(abs, { recursive: true })
  const file = storyboardPath(abs)
  if (fs.existsSync(file)) {
    let story = null
    let result
    try {
      story = normalizeStoryboard(readJson(file))
      result = validateStoryboard(story)
    } catch (e) {
      result = { ok: false, errors: [{ path: '$', message: e.message }], warnings: [] }
    }
    return { created: false, dir: abs, file, story, result }
  }
  const story = planTemplate(opts)
  const result = validateStoryboard(story)
  fs.writeFileSync(file, `${JSON.stringify(story, null, 2)}\n`, 'utf8')
  return { created: true, dir: abs, file, story, result }
}

/** 把校验错误/警告格式化成一行行中文，给 CLI 和控制台用。 */
export function formatProblemList(errors = [], warnings = []) {
  return errorSummary(errors, warnings)
}
