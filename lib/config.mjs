/**
 * lib/config.mjs —— 宿主半端的配置读写（唯一真相仍是 tools/lib/video-config.mjs）。
 *
 * 设计（抄 dsh-bili-whale 的「一份配置，两个半边共用」）：
 *   · 配置文件：$DSH_HOME/bili-faship.config.json（可用 BILI_FASHIP_CONFIG 覆盖）
 *   · 形状：{ version: 1, video: { ...VIDEO_DEFAULTS 的字段... } }
 *   · 设置页保存**整份配置**（load 回来只改几处），未显示的字段原样保留
 *   · 写之前做白名单过滤 + 范围校验；未知字段不落盘（回 ignored 列表）
 *   · 写完 resetVideoConfig()，让宿主和 CLI 的缓存都失效
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  CONFIG_FILE, VIDEO_DEFAULTS, videoConfig, videoRoot, videoDir,
  mergeVideoConfig, resetVideoConfig,
} from '../tools/lib/video-config.mjs'

/** 管线默认值里暂时还没有、但宿主设置页要用的字段（宿主侧补一层兜底，避免"存了但丢了"） */
const HOST_OVERLAY = {
  publish: { tags: [], titlePrefix: '' },
  persona: { name: '大肥鱼', ownerTitle: '主人', selfClaim: '我' },
  materials: {
    diary: [
      'D:/bilibili-scroll/bili_whale/whale-diary.md',
      'D:/bilibili-scroll/bili_whale/whale-diary-private.md',
    ],
    extraNotes: [],
  },
  paths: { stickers: '', cache: '', python: '', ffmpeg: '' },
  schedule: {
    enabled: true,
    window: { start: '21:00', end: '23:30' },
    minGapMinutes: 10,
    cooldownHours: 30,
  },
  autoPublish: { dryRun: true, allowGo: false },
  tickets: { maxPerDay: 2 },
  worker: {
    sessionMode: 'per-ticket',
    autoRetry: { enabled: true, maxAttempts: 2, backoffMinutes: 10 },
  },
  watchdog: { enabled: true, maxJobMinutes: 40, idleMinutes: 8 },
  admission: { observeOnly: false },
}

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v)
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

/** 把宿主兜底字段补进默认值（不动管线自己的默认值；**用户已有的值优先**） */
export function withHostOverlay(defaults) {
  const out = clone(defaults)
  for (const [k, v] of Object.entries(HOST_OVERLAY)) {
    // 以兜底值为 base、用户配置为 over：只补缺，不覆盖用户值
    out[k] = isPlain(out[k]) && isPlain(v) ? mergeVideoConfig(v, out[k]) : (out[k] ?? clone(v))
  }
  return out
}

/** 合并后的完整配置（给设置页 GET /settings 用） */
export function mergedConfig() {
  return withHostOverlay(videoConfig())
}

/** 读用户文件里的原始 video 段（不做默认值合并） */
function readRawSection() {
  let raw = {}
  try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch { return {} }
  if (isPlain(raw?.video)) return clone(raw.video)
  return isPlain(raw) ? clone(raw) : {}
}

/** 只保留默认值里认识的字段；未知字段记到 ignored */
export function filterKnown(base, incoming) {
  const out = {}
  const ignored = []
  for (const [k, v] of Object.entries(incoming || {})) {
    if (!(k in base)) { ignored.push(k); continue }
    if (isPlain(v) && isPlain(base[k])) {
      const sub = filterKnown(base[k], v)
      out[k] = sub.value
      for (const i of sub.ignored) ignored.push(`${k}.${i}`)
    } else if (Array.isArray(v) || typeof v !== 'object') {
      out[k] = clone(v)
    } else {
      ignored.push(k)
    }
  }
  return { value: out, ignored }
}

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/
const str = (v) => typeof v === 'string'
const num = (v) => typeof v === 'number' && Number.isFinite(v)

/** 校验合并后的完整配置；返回 { ok, errors, warnings } */
export function validateConfig(cfg) {
  const errors = []
  const warnings = []
  const bad = (msg) => errors.push(msg)
  const strMax = (v, max, name) => { if (!str(v)) bad(`${name} 必须是字符串`); else if (v.length > max) bad(`${name} 太长（上限 ${max} 字）`) }
  const intRange = (v, lo, hi, name) => { if (!num(v) || !Number.isInteger(v) || v < lo || v > hi) bad(`${name} 必须是 ${lo}–${hi} 的整数`) }
  const numRange = (v, lo, hi, name) => { if (!num(v) || v < lo || v > hi) bad(`${name} 必须在 ${lo}–${hi} 之间`) }

  if (typeof cfg.enabled !== 'boolean') bad('enabled 必须是布尔值')
  intRange(cfg.cadenceDays, 1, 30, 'cadenceDays（几天一条）')
  numRange(cfg.minDurationSec, 5, 600, 'minDurationSec')
  numRange(cfg.maxDurationSec, 5, 900, 'maxDurationSec')
  if (num(cfg.minDurationSec) && num(cfg.maxDurationSec) && cfg.maxDurationSec < cfg.minDurationSec) {
    bad('maxDurationSec 不能小于 minDurationSec')
  }

  const v = cfg.voice || {}
  strMax(v.voice, 80, 'voice.voice')
  strMax(v.rate, 20, 'voice.rate')
  strMax(v.pitch, 20, 'voice.pitch')

  const s = cfg.selfReview || {}
  if (typeof s.enabled !== 'boolean') bad('selfReview.enabled 必须是布尔值')
  intRange(s.passScore, 0, 100, 'selfReview.passScore')
  numRange(s.minSubtitleCoverage, 0, 1, 'selfReview.minSubtitleCoverage')
  if (!Array.isArray(s.loudnessRange) || s.loudnessRange.length !== 2 || !s.loudnessRange.every((x) => num(x))) {
    bad('selfReview.loudnessRange 必须是两个数字')
  } else {
    if (s.loudnessRange[0] >= s.loudnessRange[1]) bad('loudnessRange 必须升序（如 [-20,-12]）')
    if (s.loudnessRange[0] < -60 || s.loudnessRange[1] > 0) bad('loudnessRange 必须在 -60..0 之间')
  }
  numRange(s.maxClipSec, 0.5, 10, 'selfReview.maxClipSec')
  for (const k of ['requireAiLabel', 'requireRedlineCard']) if (typeof s[k] !== 'boolean') bad(`selfReview.${k} 必须是布尔值`)

  const p = cfg.publish || {}
  for (const k of ['enabled', 'dryRunByDefault', 'selfApprove', 'noReprint']) {
    if (typeof p[k] !== 'boolean') bad(`publish.${k} 必须是布尔值`)
  }
  strMax(p.profile, 80, 'publish.profile')
  intRange(p.tid, 1, 99999, 'publish.tid')
  strMax(p.partitionName, 40, 'publish.partitionName')
  if (![1, 2].includes(p.copyright)) bad('publish.copyright 必须是 1（自制）或 2（转载）')
  if (!Array.isArray(p.tags)) bad('publish.tags 必须是数组')
  else {
    if (p.tags.length > 10) bad('publish.tags 最多 10 个')
    if (p.tags.some((t) => !str(t) || t.length > 20)) bad('publish.tags 每项必须是 ≤20 字的字符串')
  }
  strMax(p.titlePrefix, 40, 'publish.titlePrefix')

  const red = cfg.redlines || {}
  for (const k of ['requireAiLabel', 'forbidImpersonation', 'forbidSpam', 'forbidUncreditedClips']) {
    if (typeof red[k] !== 'boolean') bad(`redlines.${k} 必须是布尔值`)
  }
  if (!Array.isArray(red.bannedWords)) bad('redlines.bannedWords 必须是数组')
  else if (red.bannedWords.length > 200) bad('redlines.bannedWords 最多 200 个')

  const per = cfg.persona || {}
  strMax(per.name, 40, 'persona.name')
  strMax(per.ownerTitle, 40, 'persona.ownerTitle')
  strMax(per.selfClaim, 40, 'persona.selfClaim')

  const mat = cfg.materials || {}
  for (const k of ['diary', 'extraNotes']) {
    if (!Array.isArray(mat[k])) bad(`materials.${k} 必须是数组`)
    else if (mat[k].some((x) => !str(x) || x.length > 500)) bad(`materials.${k} 每项必须是 ≤500 字的路径/文本`)
  }

  const paths = cfg.paths || {}
  for (const k of ['stickers', 'cache', 'python', 'ffmpeg']) strMax(paths[k], 500, `paths.${k}`)

  const sch = cfg.schedule || {}
  if (typeof sch.enabled !== 'boolean') bad('schedule.enabled 必须是布尔值')
  if (!HHMM.test(String(sch.window?.start ?? ''))) bad('schedule.window.start 必须是 HH:MM')
  if (!HHMM.test(String(sch.window?.end ?? ''))) bad('schedule.window.end 必须是 HH:MM')
  intRange(sch.minGapMinutes, 1, 240, 'schedule.minGapMinutes')
  intRange(sch.cooldownHours, 1, 240, 'schedule.cooldownHours')

  const ap = cfg.autoPublish || {}
  if (typeof ap.dryRun !== 'boolean') bad('autoPublish.dryRun 必须是布尔值')
  if (typeof ap.allowGo !== 'boolean') bad('autoPublish.allowGo 必须是布尔值')
  if (ap.allowGo === true) warnings.push('「允许真发」已打开：agent 在 review 通过后可以调用 publish --go（仍受 AI 标注与频率闸约束）')

  // v0.2：工单 / 准入 / worker / 看门狗（DESIGN §10.9）
  const tk = cfg.tickets || {}
  intRange(tk.maxPerDay, 1, 10, 'tickets.maxPerDay（每天最多工单数）')
  const wk = cfg.worker || {}
  if (!['per-ticket', 'persistent'].includes(wk.sessionMode)) bad('worker.sessionMode 只能是 per-ticket 或 persistent')
  const ar = wk.autoRetry || {}
  if (typeof ar.enabled !== 'boolean') bad('worker.autoRetry.enabled 必须是布尔值')
  intRange(ar.maxAttempts, 0, 5, 'worker.autoRetry.maxAttempts')
  intRange(ar.backoffMinutes, 1, 240, 'worker.autoRetry.backoffMinutes')
  const wd = cfg.watchdog || {}
  if (typeof wd.enabled !== 'boolean') bad('watchdog.enabled 必须是布尔值')
  intRange(wd.maxJobMinutes, 5, 240, 'watchdog.maxJobMinutes')
  intRange(wd.idleMinutes, 2, 120, 'watchdog.idleMinutes')
  const ad = cfg.admission || {}
  if (typeof ad.observeOnly !== 'boolean') bad('admission.observeOnly 必须是布尔值')
  if (ad.observeOnly === true) warnings.push('观察模式开着：会自动建工单、叫醒 agent，但只允许选题与 storyboard 草稿，不渲染、不投稿')
  if (wk.sessionMode === 'per-ticket') warnings.push('worker.sessionMode=per-ticket：每条片会用新会话（记忆靠日记/last-report/工单历史）')

  if (p.dryRunByDefault !== true && ap.dryRun === true) {
    warnings.push('publish.dryRunByDefault=false 但 autoPublish.dryRun=true：以 autoPublish.dryRun 为准（更保守）')
  }
  if (p.enabled === false) warnings.push('publish.enabled=false：不会生成投稿包')
  if (cfg.enabled === false) warnings.push('video.enabled=false：生物钟不会叫醒、也不自动渲染')
  return { ok: errors.length === 0, errors, warnings }
}

/**
 * 保存设置（白名单合并 + 校验 + 写盘 + 清缓存）。
 * @param {object} incoming 设置页提交的完整配置（或只含改动字段）
 * @returns {{ok:boolean, config?:object, errors?:string[], warnings?:string[], ignored?:string[]}}
 */
export function saveConfig(incoming) {
  const base = withHostOverlay(VIDEO_DEFAULTS)
  const raw = mergeVideoConfig(base, readRawSection())
  // 接受三种形状（DESIGN §5）：{ config:{...} } / { video:{...} } / 直接 {...}
  const src = isPlain(incoming?.config) ? incoming.config
    : (isPlain(incoming?.video) ? incoming.video : (isPlain(incoming) ? incoming : {}))
  const filtered = filterKnown(base, src)
  const next = mergeVideoConfig(base, mergeVideoConfig(raw, filtered.value))
  // 未知字段按 DESIGN §5 **忽略**（不回 400），只回 ignored 让设置页提示——防止旧版页面/第三方调用被卡死
  const check = validateConfig(next)
  const warnings = check.warnings.slice()
  if (filtered.ignored.length) warnings.push(`忽略了未知字段：${filtered.ignored.join(', ')}`)
  if (!check.ok) {
    return { ok: false, errors: check.errors, warnings, ignored: filtered.ignored }
  }
  const payload = { version: 1, video: next }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  const tmp = `${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`)
  fs.renameSync(tmp, CONFIG_FILE)
  resetVideoConfig()
  return { ok: true, config: mergedConfig(), warnings, errors: [], ignored: filtered.ignored }
}

/** 只读辅助：视频根目录 / 单条目录（给路由和任务用） */
export { CONFIG_FILE, videoConfig, videoRoot, videoDir, VIDEO_DEFAULTS, resetVideoConfig }
