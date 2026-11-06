// 视频投稿（B 部分）：dry-run 投稿包 + --go 真发 B 站 web 投稿流程。
//
// 分工（见插件根目录 VIDEO-CAPABILITY.md）：
//   · A 同事的 tools/video/review.mjs 产出 <dir>/review.json（pass:true 才算自审通过）
//   · 这里只负责「发布」这一段：硬闸门 → 组投稿包 →（--go）上传视频/封面 → add/v3 → 记账
//
// 主入口（被 A 的 tools/commands/video.mjs 调用）：
//   export async function publishVideo({ dir, mode = 'dry', config = null, json = false, transport = null })
//     mode: 'dry'（默认，不联网）| 'go'（真发）
//     transport: 可注入的 fetch 兼容函数（测试 mock 用）；默认用 traffic.mjs 的 guardedFetch
//
// 安全约定（硬性）：
//   · 任何闸门失败 → 抛 PublishError（带 code），绝不静默降级
//   · 412 / 429 / 风控码 → 立即停止、不重试，错误里带平台返回原文
//   · 不打印凭据；publish.json / 报错里也不落 cookie
//   · 只有 add/v3 返回 code=0 且带 bvid 才写发布记录 + 更新 index.json
//
// 协议来源（2026-10 核对，公开资料）：
//   · 上传流程：GET preupload → POST ?uploads（元数据）→ PUT 分片 → POST 结束上传
//     （B 站创作中心 web 端 upos 协议；archive 的 bilibili-API-collect 文档 + biliup 源码一致）
//   · 投稿：POST /x/vu/web/add/v3（JSON），封面：POST /x/vu/web/cover/up（x-www-form-urlencoded，cover 为 base64）
//   · 注意：合同初稿里写的「分片 POST multipart」「封面 multipart file」与公开协议不符，
//     已按公开协议实现（见 tools/docs/video-publish.md「协议细节」一节）；两处都未在真实账号实测。
import fs from 'node:fs'
import path from 'node:path'

import { VIDEO_DEFAULTS, mergeVideoConfig, videoConfig, videoRoot } from '../lib/video-config.mjs'
import { loadCred, missingForWrite, explainCode } from '../lib/cred.mjs'
import { guardedFetch, riskSettings } from '../lib/traffic.mjs'

// ── 常量 ────────────────────────────────────────────────────────────────────
const PREUPLOAD_URL = 'https://member.bilibili.com/preupload'
const COVER_UP_URL = 'https://member.bilibili.com/x/vu/web/cover/up'
const ADD_URL = 'https://member.bilibili.com/x/vu/web/add/v3'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REFERER = 'https://member.bilibili.com/platform/upload/video/frame'
const DEFAULT_PROFILE = 'ugcfx/bup'
const DEFAULT_TID = 138
const DEFAULT_AI_LABEL = '本视频含 AI 生成内容'
const INDEX_VERSION = 1
// 风控码：撞到就停（traffic.mjs 里也会记熔断，这里不再发任何后续请求）
const RISK_STATUS = new Set([412, 429])
const RISK_CODES = new Set([-412, -352, -799, -509, -10403, 601, 10031])
// 协议里 upos 上传域（*.bilivideo.com 等）不属于 traffic.mjs 的 bilibili.com 白名单，
// 分片 PUT 不会吃「写冷却 / 写预算」，也不参与判重。member.bilibili.com 的三次写才会过闸。

/** 发布拒绝 / 失败。code 供 CLI 与测试判定，message 给人看。 */
export class PublishError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'PublishError'
    this.code = code
    this.details = details
  }
}

const fail = (code, message, details) => { throw new PublishError(code, message, details) }
const str = (v) => (typeof v === 'string' ? v.trim() : '')
const charLen = (v) => Array.from(String(v ?? '')).length
const trunc = (v, n = 400) => { const s = String(v ?? ''); return s.length > n ? `${s.slice(0, n)}…` : s }
const humanBytes = (n) => {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`
}
/** 本地时区的 ISO 时间（带偏移，和 Lead 定的 index.json 格式一致）。 */
function isoLocal(input) {
  const d = input instanceof Date ? input : new Date(input)
  if (!Number.isFinite(d.getTime())) throw new Error(`无效时间：${input}`)
  const pad = (n) => String(n).padStart(2, '0')
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}
/** 人看的本地时间（拒绝频率闸时给「下次可发」）。 */
const humanTime = (v) => new Date(v).toLocaleString('zh-CN', { hour12: false })

// ── 配置 / 路径 ─────────────────────────────────────────────────────────────
function resolveConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return videoConfig()
  return mergeVideoConfig(VIDEO_DEFAULTS, config)
}
/** 合同接口是 mode；A 的 CLI 传的是 dry/go 布尔 —— 两种都认。 */
function normalizeMode(options) {
  if (options.mode === 'dry' || options.mode === 'go') return options.mode
  if (options.mode !== undefined && options.mode !== null && options.mode !== '') {
    fail('INVALID_MODE', `mode 只能是 'dry' 或 'go'（收到 ${JSON.stringify(options.mode)}）`)
  }
  if (options.go === true && options.dry !== true) return 'go'
  return 'dry'
}
function resolveRoot(cfg) {
  const out = String(cfg.outDir ?? '').trim()
  return out ? path.resolve(out) : videoRoot()
}

// ── JSON 文件读写（原子写：temp + rename；Windows 也走同一套） ────────────────
function readJsonRequired(file, label, code) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) {
    fail(code, `缺少 ${label}：${file}（${e.code === 'ENOENT' ? '文件不存在' : e.message}）`)
  }
  let data
  try { data = JSON.parse(String(raw).replace(/^\uFEFF/, '')) } catch (e) {
    fail(code, `${label} 不是合法 JSON：${file}\n  ${String(e.message).slice(0, 160)}`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(code, `${label} 顶层必须是对象：${file}`)
  return data
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch {}
    throw e
  }
}

// ── 发布索引 <videoRoot()>/index.json（格式由 Lead 定） ──────────────────────
// { version: 1, videos: [ {slug,title,bvid,aid,publishedAt} ], lastPublishedAt }
// 文件损坏 → 拒绝发布（不要静默当没有记录）
function readIndex(root) {
  const file = path.join(root, 'index.json')
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) {
    if (e.code === 'ENOENT') return { file, exists: false, videos: [], lastPublishedAt: null, lastAt: null }
    fail('INDEX_CORRUPT', `发布索引读不出来：${file}\n  ${e.message}；已拒绝发布（不静默当没有记录）`)
  }
  let data
  try { data = JSON.parse(String(raw).replace(/^\uFEFF/, '')) } catch (e) {
    fail('INDEX_CORRUPT', `发布索引损坏（不是合法 JSON）：${file}\n  ${String(e.message).slice(0, 160)}\n已拒绝发布（不静默当没有记录）`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    fail('INDEX_CORRUPT', `发布索引结构不对（顶层不是对象）：${file}\n已拒绝发布（不静默当没有记录）`)
  }
  const videos = data.videos ?? []
  if (!Array.isArray(videos)) fail('INDEX_CORRUPT', `发布索引 videos 不是数组：${file}\n已拒绝发布`)
  for (const item of videos) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fail('INDEX_CORRUPT', `发布索引 videos 里有非法条目：${file}\n已拒绝发布`)
    }
  }
  let lastAt = null
  if (data.lastPublishedAt !== undefined && data.lastPublishedAt !== null && data.lastPublishedAt !== '') {
    const t = Date.parse(String(data.lastPublishedAt))
    if (!Number.isFinite(t)) fail('INDEX_CORRUPT', `发布索引 lastPublishedAt 不是合法时间（${trunc(data.lastPublishedAt, 60)}）：${file}\n已拒绝发布`)
    lastAt = t
  } else {
    // 兼容：lastPublishedAt 缺失/为空时，用 videos 里最晚的一条（不猜，只取显式记录）
    for (const item of videos) {
      const t = Date.parse(String(item.publishedAt ?? ''))
      if (Number.isFinite(t)) lastAt = lastAt === null ? t : Math.max(lastAt, t)
    }
  }
  return {
    file,
    exists: true,
    videos,
    lastPublishedAt: lastAt === null ? null : isoLocal(new Date(lastAt)),
    lastAt,
  }
}
function appendIndex(index, record) {
  const videos = [...index.videos, record]
  const data = {
    version: INDEX_VERSION,
    videos,
    lastPublishedAt: index.lastAt !== null && Date.parse(String(record.publishedAt)) < index.lastAt
      ? index.lastPublishedAt
      : record.publishedAt,
  }
  writeJsonAtomic(index.file, data)
  return data
}

// ── 字段解析与硬闸门 ────────────────────────────────────────────────────────
/**
 * 组装投稿字段：storyboard 自己的内容优先，配置 video.publish.{tags,titlePrefix} 只做**补充**
 * （DESIGN §4 把这两个字段定义为"追加标签 / 可选标题前缀"）。
 *
 * 为什么在这里合并而不是在 storyboard 里改：
 *   · dry 与 go 共用同一份 fields（下面 publishVideo 只构建一次），合并放这里两条路径都自动生效；
 *   · 不改用户写的 storyboard.json —— 配置是"补充"，不是把内容改掉。
 *
 * 校验顺序不变：合并后的标题/标签仍走 validateFields 原有的 ≤80 字 / ≤10 个 / 单个 ≤20 字闸门。
 */
function resolveFields(storyboard, meta, config) {
  const pub = (storyboard.publish && typeof storyboard.publish === 'object' && !Array.isArray(storyboard.publish))
    ? storyboard.publish
    : {}
  const cfgPublish = (config && typeof config === 'object' && config.publish && typeof config.publish === 'object' && !Array.isArray(config.publish))
    ? config.publish
    : {}
  // 标题前缀：只加一次（storyboard 标题已经带同前缀时原样用，避免「【AI】【AI】…」）。
  // 标题为空时不拿前缀"造"一个标题出来：空标题仍然按 INVALID_TITLE 拒。
  let title = str(pub.titleForPost) || str(meta.title) || str(storyboard.title)
  const titlePrefix = str(cfgPublish.titlePrefix)
  if (titlePrefix && title && !title.startsWith(titlePrefix)) title = `${titlePrefix}${title}`
  const desc = typeof pub.description === 'string' ? pub.description : ''
  // 标签：storyboard 的标签优先且保留顺序，配置 tags 只追加不重复（trim + 空忽略）。
  const storyTags = Array.isArray(pub.tags)
    ? pub.tags.map((t) => String(t ?? '').trim()).filter(Boolean)
    : []
  const extraTags = Array.isArray(cfgPublish.tags)
    ? cfgPublish.tags.map((t) => String(t ?? '').trim()).filter(Boolean)
    : []
  const tags = []
  const seen = new Set()
  for (const tag of [...storyTags, ...extraTags]) {
    if (seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
  }
  const aiLabel = str(pub.aiLabel) || str(meta.aiLabel) || DEFAULT_AI_LABEL
  return { title, desc, tags, aiLabel }
}
const normalizeDesc = (v) => String(v ?? '').replace(/\s+/g, '')

function validateFields(fields) {
  const { title, desc, tags } = fields
  if (!title) fail('INVALID_TITLE', '标题为空：storyboard.publish.titleForPost（或 title）没给；拒绝投稿')
  if (charLen(title) > 80) fail('INVALID_TITLE', `标题超过 80 字（现在 ${charLen(title)} 字）：${trunc(title, 60)}；拒绝投稿`)
  if (!desc.trim()) fail('INVALID_DESC', '简介为空：storyboard.publish.description 没给；拒绝投稿')
  if (charLen(desc) > 2000) fail('INVALID_DESC', `简介超过 2000 字（现在 ${charLen(desc)} 字）；拒绝投稿`)
  if (!tags.length) fail('INVALID_TAGS', '标签为空：storyboard.publish.tags 没给；拒绝投稿')
  if (tags.length > 10) fail('INVALID_TAGS', `标签超过 10 个（现在 ${tags.length} 个）：${tags.slice(0, 12).join(' / ')}；拒绝投稿`)
  const tooLong = tags.find((t) => charLen(t) > 20)
  if (tooLong) fail('INVALID_TAGS', `标签单个超过 20 字：「${trunc(tooLong, 30)}」（${charLen(tooLong)} 字）；拒绝投稿`)
}
function validateRedlines(fields, cfg) {
  const redlines = cfg.redlines ?? {}
  const banned = Array.isArray(redlines.bannedWords) ? redlines.bannedWords.map((w) => str(w)).filter(Boolean) : []
  const hit = banned.find((w) => fields.desc.includes(w))
  if (hit) {
    fail('REDLINE_BANNED', `简介命中红线词「${hit}」：拒绝投稿（红线是代码闸门，不是提示词）\n  简介：${trunc(fields.desc, 200)}`)
  }
  if (redlines.requireAiLabel !== false && !normalizeDesc(fields.desc).includes('AI生成')) {
    fail('REDLINE_AI_LABEL', '简介里没有「AI 生成」标注：拒绝投稿（如实标注是红线第一条）\n  简介：' + trunc(fields.desc, 200))
  }
}
function validateCadence(index, cfg, slug, now) {
  const days = Number(cfg.cadenceDays)
  if (!Number.isFinite(days) || days < 0) {
    fail('CONFIG_INVALID', `video.cadenceDays 不是合法天数（${JSON.stringify(cfg.cadenceDays)}）；拒绝投稿（不猜）`)
  }
  if (index.videos.some((v) => str(v.slug) === slug)) {
    fail('DUPLICATE_SLUG', `slug「${slug}」已经发布过（见 ${index.file}）；同一 slug 不重复发，换个 slug 再来`)
  }
  if (index.lastAt !== null) {
    const nextAt = index.lastAt + days * 86400 * 1000
    if (now < nextAt) {
      fail('CADENCE', `距上次发布不足 ${days} 天（上次 ${humanTime(index.lastAt)}，上次记录 ${index.lastPublishedAt}）\n  下次可发：${humanTime(nextAt)}（${isoLocal(new Date(nextAt))}）`,
        { lastPublishedAt: index.lastPublishedAt, nextDueAt: isoLocal(new Date(nextAt)) })
    }
  }
}

// ── 投稿包 / 请求体构造（纯函数，单测锁定） ──────────────────────────────────
function buildAddBody(fields, { filename, cid, csrf, cover }) {
  // 字段依据 2026-01 存档的 B 站创作中心文档 + biliup 2026 源码；多传的字段 B 站 web 端本身也传，容错。
  return {
    videos: [{ filename, title: fields.title, desc: '', cid }],
    cover,
    cover43: '',
    title: fields.title,
    copyright: fields.copyright,
    tid: fields.tid,
    tag: fields.tags.join(','),
    desc_format_id: 9999,
    desc: fields.desc,
    recreate: -1,
    dynamic: '',
    interactive: 0,
    act_reserve_create: 0,
    no_disturbance: 0,
    no_reprint: fields.no_reprint,
    subtitle: { open: 0, lan: '' },
    open_subtitle: true, // 合同要求；与 subtitle.open=0 一起属于「允许投稿字幕」
    dolby: 0,
    lossless_music: 0,
    up_selection_reply: false,
    up_close_reply: false,
    up_close_danmu: false,
    web_os: 3,
    csrf,
  }
}
function buildPackage({ workDir, fields, cfg, media, review, meta, storyboard, previous }) {
  const publish = cfg.publish ?? {}
  const tid = Number(publish.tid ?? DEFAULT_TID)
  if (!Number.isInteger(tid) || tid <= 0) fail('CONFIG_INVALID', `video.publish.tid 不是合法分区 id（${JSON.stringify(publish.tid)}）；拒绝投稿`)
  // 自制：1。AI 生成内容必须如实标为自制（配置里只允许 1；写死避免误设成转载）
  const copyright = 1
  const no_reprint = publish.noReprint === false ? 0 : 1
  const slug = str(storyboard.slug) || str(meta.slug) || path.basename(workDir)
  const pkg = {
    version: 1,
    mode: 'dry',
    generatedAt: isoLocal(new Date()),
    slug,
    title: fields.title,
    desc: fields.desc,
    tags: fields.tags,
    tid,
    partitionName: str(publish.partitionName),
    copyright,
    copyrightLabel: '自制',
    no_reprint,
    aiLabel: fields.aiLabel,
    aiLabelInDesc: normalizeDesc(fields.desc).includes('AI生成'),
    video: media.video.file,
    videoBytes: media.video.bytes,
    cover: media.cover.file,
    coverBytes: media.cover.bytes,
    durationSec: Number.isFinite(Number(meta.durationSec)) ? Number(meta.durationSec) : null,
    uploadProfile: str(publish.profile) || DEFAULT_PROFILE,
    review: { pass: review.pass === true, score: Number.isFinite(Number(review.score)) ? Number(review.score) : null, reviewedAt: review.reviewedAt ?? null },
    // 预计请求（dry 用占位符；凭据字段永远只写占位）
    request: {
      method: 'POST',
      url: `${ADD_URL}?t=<ms>&csrf=<bili_jct>`,
      body: buildAddBody(
        { title: fields.title, desc: fields.desc, tags: fields.tags, tid, copyright, no_reprint },
        { filename: '<上传后 upos 文件名（无扩展名）>', cid: '<preupload.biz_id>', csrf: '<bili_jct>', cover: '<封面上传后返回的 url>' },
      ),
    },
    steps: [
      'GET  https://member.bilibili.com/preupload  （拿 endpoint / upos_uri / auth / chunk_size / biz_id）',
      'POST <endpoint>/<upos_uri>?uploads&output=json  （X-Upos-Auth；初始化分片上传）',
      'PUT  <endpoint>/<upos_uri>?partNumber/uploadId/chunk/chunks/size/start/end/total  （逐片，application/octet-stream）',
      'POST <endpoint>/<upos_uri>?output=json&name&profile&uploadId&biz_id  （X-Upos-Auth；结束上传，body.parts）',
      'POST https://member.bilibili.com/x/vu/web/cover/up  （csrf + cover=base64）→ data.url',
      'POST https://member.bilibili.com/x/vu/web/add/v3  （JSON；成功返回 bvid/aid）',
    ],
    network: false,
  }
  if (previous) pkg.previous = previous
  return pkg
}

// ── 通用请求层 ──────────────────────────────────────────────────────────────
// 所有真实请求都从 net 走；默认 net = guardedFetch（traffic.mjs：跨进程间隔 / 写冷却 / 写预算 / 412 熔断）。
// 任何 412 / 429 / 风控码 → 立即抛 RISK_BLOCKED，绝不重试；错误里带平台返回原文。
function riskText(label, status, raw, code) {
  const bits = [`⚠ ${label} 触发平台风控`]
  if (status) bits.push(`HTTP ${status}`)
  if (Number.isFinite(Number(code))) bits.push(`code=${code}`)
  bits.push('已立即停止、不重试（平台限制期间硬顶只会更糟）')
  if (Number(code) === 601) bits.push('601 = 平台要求验证/冷却：在浏览器打开创作中心投稿页完成一次验证，或等风控冷却后再试；不要自动重试')
  bits.push(`平台原文：${trunc(raw) || '(空响应)'}`)
  return bits.join('；')
}
async function httpCall(net, url, init, label) {
  let res
  try {
    res = await net(String(url), init)
  } catch (e) {
    if (e && e.code === 'BILI_TRAFFIC_PAUSED') {
      const msg = String(e.message)
      if (/结果不确定|禁止重复发送|相同操作/.test(msg)) {
        fail('WRITE_UNCERTAIN', `${label}：${msg}\n  已停止。这是「不确定有没有发出去」的保守处理：不要重试，先去创作中心/请求保护状态人工核查。`, { cause: e })
      }
      fail('TRAFFIC_BLOCKED', `${label}：本地请求保护挡住本次请求 —— ${msg}`, { cause: e })
    }
    fail('NETWORK_ERROR', `${label}：网络请求失败 —— ${e.message}（不重试，已停止）`, { cause: e })
  }
  const status = Number(res?.status ?? 0)
  let text = ''
  try { text = typeof res?.text === 'function' ? await res.text() : '' } catch { text = '' }
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON：保留原文 */ }
  const code = Number(json?.code)
  if (RISK_STATUS.has(status) || RISK_CODES.has(code)) {
    fail('RISK_BLOCKED', riskText(label, status, text, code), { http: status, code, raw: trunc(text) })
  }
  if (!res?.ok || status < 200 || status >= 300) {
    fail('HTTP_ERROR', `${label}：HTTP ${status || '(无)'}${status === 412 ? '' : ''}；平台原文：${trunc(text) || '(空响应)'}`, { http: status, raw: trunc(text) })
  }
  return { status, text, json }
}
/** B 站 member 接口：要求 code===0（风控码已在 httpCall 拦住）。 */
async function memberApi(net, url, init, label, failCode = 'API_ERROR') {
  const r = await httpCall(net, url, init, label)
  if (!r.json || typeof r.json !== 'object') {
    fail(failCode, `${label}：返回不是 JSON（HTTP ${r.status}）；平台原文：${trunc(r.text) || '(空响应)'}`, { http: r.status })
  }
  if (Number(r.json.code) !== 0) {
    fail(failCode, `${label}：${explainCode(r.json.code)}；平台原文：${trunc(r.text)}`, { http: r.status, code: r.json.code })
  }
  return r.json
}
/** upos 接口：没有 code 字段，用 OK===1 判成功（或调用方自定）。 */
async function uposApi(net, url, init, label) {
  const r = await httpCall(net, url, init, label)
  if (!r.json || typeof r.json !== 'object') {
    fail('UPLOAD_FAILED', `${label}：返回不是 JSON（HTTP ${r.status}）；平台原文：${trunc(r.text) || '(空响应)'}`, { http: r.status })
  }
  return r.json
}
function uposBaseUrl(pre) {
  const endpoint = str(pre.endpoint)
  const uri = str(pre.upos_uri)
  if (!uri) fail('UPLOAD_FAILED', '预上传返回缺少 upos_uri：B 站接口可能变了；已停止（不猜地址）')
  const absolute = (s) => (s.startsWith('http://') || s.startsWith('https://')) ? s : `https:${s.startsWith('//') ? s : `//${s}`}`
  const trimHost = (s) => s.replace(/\/+$/, '')
  if (uri.startsWith('upos://')) {
    if (!endpoint) fail('UPLOAD_FAILED', '预上传返回缺少 endpoint：没法拼上传地址；已停止（不猜）')
    return `${trimHost(absolute(endpoint))}/${uri.slice('upos://'.length).replace(/^\/+/, '')}`
  }
  if (uri.startsWith('//') || /^https?:/i.test(uri)) return trimHost(absolute(uri))
  if (!endpoint) fail('UPLOAD_FAILED', '预上传返回缺少 endpoint：没法拼上传地址；已停止（不猜）')
  return `${trimHost(absolute(endpoint))}/${uri.replace(/^\/+/, '')}`
}
/** add/v3 里 videos[].filename 用「上传对象的 key（去目录、去扩展名）」。 */
function objectKeyFilename(uposUri) {
  const clean = String(uposUri ?? '').split('?')[0]
  const base = clean.split('/').filter(Boolean).pop() ?? ''
  const dot = base.lastIndexOf('.')
  const name = dot > 0 ? base.slice(0, dot) : base
  if (!name) fail('UPLOAD_FAILED', `没法从 upos_uri 解析上传文件名（${trunc(uposUri, 120)}）；已停止（不猜）`)
  return name
}
function cookieHeader(cred) {
  const parts = []
  if (cred.sessdata) parts.push(`SESSDATA=${cred.sessdata}`)
  if (cred.bili_jct) parts.push(`bili_jct=${cred.bili_jct}`)
  if (cred.buvid3) parts.push(`buvid3=${cred.buvid3}`)
  return parts.join('; ')
}
function biliHeaders(cred, extra = {}) {
  return { cookie: cookieHeader(cred), 'user-agent': UA, referer: REFERER, ...extra }
}
function readChunk(fd, start, len) {
  const buf = Buffer.allocUnsafe(len)
  let read = 0
  while (read < len) {
    const n = fs.readSync(fd, buf, read, len - read, start + read)
    if (n <= 0) throw new Error(`读取视频分片失败（off=${start + read}）`)
    read += n
  }
  return buf
}

// ── go 模式：上传 + 封面 + 投稿 ─────────────────────────────────────────────
async function uploadVideo({ net, cred, pkg, say }) {
  const name = path.basename(pkg.video)
  const size = pkg.videoBytes
  const profile = pkg.uploadProfile || DEFAULT_PROFILE
  say(`[1/5] 申请上传：${name}（${humanBytes(size)}）`)

  const preUrl = new URL(PREUPLOAD_URL)
  for (const [k, v] of Object.entries({
    name, size: String(size), r: 'upos', profile, ssl: '0', version: '2.14.0', build: '2140000', webVersion: '2.14.0',
  })) preUrl.searchParams.set(k, v)
  // 注意：preupload 没有 code 字段（用 OK=1），所以不能走 memberApi 的 code===0 校验。
  const preRes = await httpCall(net, preUrl, { method: 'GET', headers: biliHeaders(cred) }, '预上传')
  const pre = preRes.json
  if (!pre || typeof pre !== 'object') {
    fail('UPLOAD_FAILED', `预上传返回不是 JSON（HTTP ${preRes.status}）；平台原文：${trunc(preRes.text) || '(空响应)'}；已停止`)
  }
  if (Number(pre.OK) !== 1) {
    fail('UPLOAD_FAILED', `预上传失败（OK=${pre.OK ?? '(缺失)'}）：${trunc(JSON.stringify(pre))}；已停止`)
  }
  const bucket = {
    auth: str(pre.auth),
    endpoint: str(pre.endpoint),
    upos_uri: str(pre.upos_uri),
    biz_id: Number(pre.biz_id),
    chunk_size: Number(pre.chunk_size),
  }
  if (!bucket.auth) fail('UPLOAD_FAILED', '预上传返回缺少 auth：B 站接口可能变了；已停止（不猜）')
  if (!Number.isFinite(bucket.biz_id) || bucket.biz_id <= 0) fail('UPLOAD_FAILED', `预上传返回的 biz_id 不合法（${trunc(pre.biz_id, 40)}）；已停止`)
  if (!Number.isFinite(bucket.chunk_size) || bucket.chunk_size <= 0) fail('UPLOAD_FAILED', `预上传返回的 chunk_size 不合法（${trunc(pre.chunk_size, 40)}）；已停止`)
  const base = uposBaseUrl(bucket)
  const authHeaders = { 'X-Upos-Auth': bucket.auth }
  const chunks = Math.max(1, Math.ceil(size / bucket.chunk_size))

  // ① 初始化分片上传（元数据）
  const initUrl = new URL(base)
  initUrl.searchParams.set('uploads', '')
  initUrl.searchParams.set('output', 'json')
  initUrl.searchParams.set('profile', profile)
  initUrl.searchParams.set('filesize', String(size))
  initUrl.searchParams.set('partsize', String(bucket.chunk_size))
  initUrl.searchParams.set('biz_id', String(bucket.biz_id))
  const init = await uposApi(net, initUrl, {
    method: 'POST',
    headers: biliHeaders(cred, { ...authHeaders, 'content-type': 'application/x-www-form-urlencoded' }),
  }, '初始化上传')
  const uploadId = str(init.upload_id)
  if (!uploadId) fail('UPLOAD_FAILED', `初始化上传返回缺少 upload_id：${trunc(JSON.stringify(init))}；已停止`)

  // ② 逐片 PUT（顺序上传，保守：不并发轰炸）
  const fd = fs.openSync(pkg.video, 'r')
  try {
    for (let i = 0; i < chunks; i += 1) {
      const start = i * bucket.chunk_size
      const len = Math.min(bucket.chunk_size, size - start)
      const buf = readChunk(fd, start, len)
      const url = new URL(base)
      url.searchParams.set('partNumber', String(i + 1))
      url.searchParams.set('uploadId', uploadId)
      url.searchParams.set('chunk', String(i))
      url.searchParams.set('chunks', String(chunks))
      url.searchParams.set('size', String(len))
      url.searchParams.set('start', String(start))
      url.searchParams.set('end', String(start + len))
      url.searchParams.set('total', String(size))
      await httpCall(net, url, {
        method: 'PUT',
        headers: biliHeaders(cred, { ...authHeaders, 'content-type': 'application/octet-stream' }),
        body: buf,
      }, `上传分片 ${i + 1}/${chunks}`)
      say(`[2/5] 分片 ${i + 1}/${chunks} 完成（${humanBytes(len)}）`)
    }
  } finally {
    fs.closeSync(fd)
  }

  // ③ 结束上传
  const endUrl = new URL(base)
  endUrl.searchParams.set('output', 'json')
  endUrl.searchParams.set('name', name)
  endUrl.searchParams.set('profile', profile)
  endUrl.searchParams.set('uploadId', uploadId)
  endUrl.searchParams.set('biz_id', String(bucket.biz_id))
  const parts = Array.from({ length: chunks }, (_, i) => ({ partNumber: i + 1, eTag: 'etag' }))
  const ended = await uposApi(net, endUrl, {
    method: 'POST',
    headers: biliHeaders(cred, { ...authHeaders, 'content-type': 'application/json; charset=utf-8' }),
    body: JSON.stringify({ parts }),
  }, '结束上传')
  if (Number(ended.OK) !== 1) {
    fail('UPLOAD_FAILED', `结束上传失败（OK=${ended.OK ?? '(缺失)'}）：${trunc(JSON.stringify(ended))}；已停止，未提交稿件`)
  }
  say('[3/5] 视频分片上传完成')
  return { filename: objectKeyFilename(bucket.upos_uri), cid: bucket.biz_id, uploadId, chunks, chunkSize: bucket.chunk_size }
}

async function uploadCover({ net, cred, pkg, say }) {
  say(`[4/5] 上传封面：${path.basename(pkg.cover)}（${humanBytes(pkg.coverBytes)}）`)
  const buf = fs.readFileSync(pkg.cover)
  const form = new URLSearchParams()
  form.set('csrf', cred.bili_jct)
  form.set('cover', `data:image/jpeg;base64,${buf.toString('base64')}`)
  const res = await memberApi(net, `${COVER_UP_URL}?ts=${Date.now()}`, {
    method: 'POST',
    headers: biliHeaders(cred, { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }),
    body: form,
  }, '上传封面', 'COVER_FAILED')
  const coverUrl = str(res?.data?.url)
  if (!coverUrl) fail('COVER_FAILED', `封面上传返回里没有 data.url：${trunc(JSON.stringify(res))}；已停止，未提交稿件（不猜封面地址）`)
  return coverUrl
}

async function submitVideo({ net, cred, pkg, upload, coverUrl, say }) {
  say('[5/5] 提交稿件（add/v3）')
  const fields = {
    title: pkg.title, desc: pkg.desc, tags: pkg.tags, tid: pkg.tid,
    copyright: pkg.copyright, no_reprint: pkg.no_reprint,
  }
  const body = buildAddBody(fields, { filename: upload.filename, cid: upload.cid, csrf: cred.bili_jct, cover: coverUrl })
  const url = `${ADD_URL}?t=${Date.now()}&csrf=${encodeURIComponent(cred.bili_jct)}`
  const res = await memberApi(net, url, {
    method: 'POST',
    headers: biliHeaders(cred, { origin: 'https://member.bilibili.com', 'content-type': 'application/json; charset=utf-8' }),
    body: JSON.stringify(body),
  }, '提交稿件')
  const bvid = str(res?.data?.bvid)
  const aid = Number(res?.data?.aid)
  if (!bvid) {
    fail('SUBMIT_UNCONFIRMED', `提交接口返回 code=0 但没有 bvid：${trunc(JSON.stringify(res))}\n已停止；请到创作中心核对，别重复提交`, { raw: trunc(JSON.stringify(res), 800) })
  }
  return { bvid, aid: Number.isFinite(aid) ? aid : null }
}

// ── 打印（--json 时只输出最终 JSON，保证 stdout 可解析） ─────────────────────
function printDrySummary(pkg, publishFile) {
  console.log('[dry] 投稿包已生成（未联网、未投稿）')
  console.log(`  文件：${publishFile}`)
  console.log(`  标题（${charLen(pkg.title)} 字）：${pkg.title}`)
  console.log(`  简介（${charLen(pkg.desc)} 字）：${pkg.desc.split('\n')[0].slice(0, 80)}${charLen(pkg.desc) > 80 ? '…' : ''}`)
  console.log(`  标签（${pkg.tags.length} 个）：${pkg.tags.join(' / ')}`)
  console.log(`  分区：tid=${pkg.tid}${pkg.partitionName ? `（${pkg.partitionName}）` : ''}  版权：copyright=${pkg.copyright} ${pkg.copyrightLabel}  禁止转载：${pkg.no_reprint ? '是' : '否'}`)
  console.log(`  AI 标注：${pkg.aiLabel}（简介中${pkg.aiLabelInDesc ? '已' : '未'}包含「AI 生成」）`)
  console.log(`  视频：${path.basename(pkg.video)}（${humanBytes(pkg.videoBytes)}）  封面：${path.basename(pkg.cover)}（${humanBytes(pkg.coverBytes)}）`)
  if (pkg.durationSec !== null) console.log(`  时长：${pkg.durationSec}s  自审：pass=${pkg.review.pass} score=${pkg.review.score ?? '-'}`)
  console.log(`  预计提交：POST ${ADD_URL}（体见 publish.json.request.body）`)
  console.log('  → 确认无误后加 --go 才真发；本项目不对 --go 做任何重试。')
}
function printGoSummary(result, publishFile, indexFile) {
  console.log('[go] ✅ 投稿成功')
  console.log(`  bvid=${result.bvid}${result.aid ? `  aid=${result.aid}` : ''}`)
  console.log(`  https://www.bilibili.com/video/${result.bvid}/`)
  console.log(`  发布记录：${publishFile}`)
  console.log(`  发布索引：${indexFile}`)
  console.log('  提示：稿件还要过 B 站审核才公开；首次真发请主人盯一下创作中心。')
}

// ── 主入口 ──────────────────────────────────────────────────────────────────
/**
 * 投稿（dry-run 或真发）。
 * @param {object} opts
 * @param {string} opts.dir 视频工作目录（含 storyboard.json / meta.json / video.mp4 / cover.jpg / review.json）
 * @param {'dry'|'go'} [opts.mode='dry'] 合同接口：显式模式
 * @param {object|null} [opts.config] video 配置覆盖（默认读 videoConfig()；测试注入用）
 * @param {boolean} [opts.json=false] true 时只打印 JSON（给 CLI --json）
 * @param {Function|null} [opts.transport] fetch 兼容函数；默认 guardedFetch（测试 mock 用）
 * @param {boolean} [opts.dry] / opts.go 兼容 A 的 CLI 调用形状（传 dry/go 布尔而不是 mode）
 * @param {boolean} [opts.quiet] 调用方自己打印时传 true（也可以传 dry/go 自动识别）
 * @returns {Promise<object>} dry: { ok:true, mode:'dry', package, message }；go: { ok:true, mode:'go', bvid, aid, publishedAt, title, publishFile, indexFile, message }
 */
export async function publishVideo(opts = {}) {
  const options = (opts && typeof opts === 'object') ? opts : {}
  const { dir, config = null, json = false, transport = null } = options
  const mode = normalizeMode(options)
  // A 的 commands/video.mjs 传的是 { dry, go } 布尔，并且它自己会打印结果（--json 也只由它输出一次）。
  // 识别到这种调用形状时本模块不再打印，避免 stdout 出现两份 JSON / 两段摘要。
  const callerPrints = options.quiet === true
    || Object.prototype.hasOwnProperty.call(options, 'dry')
    || Object.prototype.hasOwnProperty.call(options, 'go')
  const say = (json || callerPrints) ? () => {} : (...args) => console.log(...args)
  const rawDir = str(dir)
  if (!rawDir) fail('INVALID_DIR', '缺少视频目录：publishVideo({ dir })（CLI 上是 --dir <dir>）')
  const workDir = path.resolve(rawDir)
  const cfg = resolveConfig(config)
  const root = resolveRoot(cfg)

  // ① 必读文件：storyboard / meta / review（顺序与合同一致：先校验自审再碰媒体）
  const storyboard = readJsonRequired(path.join(workDir, 'storyboard.json'), 'storyboard.json', 'INVALID_STORYBOARD')
  const meta = readJsonRequired(path.join(workDir, 'meta.json'), 'meta.json', 'INVALID_META')
  const review = readJsonRequired(path.join(workDir, 'review.json'), '自审报告 review.json（先跑 video review）', 'REVIEW_NOT_PASSED')
  if (review.pass !== true) {
    fail('REVIEW_NOT_PASSED', `自审未通过（review.json.pass !== true）：拒绝投稿\n  自审是发布的前置条件；先让 video review 修到 pass，再看分数。`, { score: review.score ?? null })
  }

  // ② 媒体文件闸门
  const videoFile = path.join(workDir, 'video.mp4')
  const coverFile = path.join(workDir, 'cover.jpg')
  const media = { video: requireMedia(videoFile, '视频'), cover: requireMedia(coverFile, '封面') }

  // ③ 字段 / 红线闸门（字段构建时合并配置里的 tags / titlePrefix；dry 与 go 共用这一份）
  const fields = resolveFields(storyboard, meta, cfg)
  validateFields(fields)
  validateRedlines(fields, cfg)

  // ④ 频率 / 重复 / 配置闸门
  const slug = str(storyboard.slug) || str(meta.slug) || path.basename(workDir)
  const now = Date.now()
  const index = readIndex(root)
  validateCadence(index, cfg, slug, now)
  const publishCfg = cfg.publish ?? {}
  if (publishCfg.enabled === false) {
    fail('PUBLISH_DISABLED', 'video.publish.enabled=false：发布被配置关掉了；要发先在设置页/配置里打开')
  }

  const pkg = buildPackage({ workDir, fields, cfg, media, review, meta, storyboard, previous: readPreviousPublish(workDir) })
  const publishFile = path.join(workDir, 'publish.json')

  // ⑤ dry：只写投稿包 + 打印，不发任何网络
  if (mode === 'dry') {
    writeJsonAtomic(publishFile, pkg)
    const result = {
      ok: true,
      mode: 'dry',
      package: pkg,
      message: `[dry] 投稿包已生成：${publishFile}（未联网、未投稿；确认后加 --go 才真发）`,
    }
    if (callerPrints) { /* 调用方自己打印（A 的 CLI）*/ } else if (json) console.log(JSON.stringify(result, null, 2))
    else printDrySummary(pkg, publishFile)
    return result
  }

  // ⑥ go：先查凭据（缺什么说清楚，别拿 undefined 去发请求）
  let cred
  try { cred = loadCred() } catch (e) { fail('AUTH_MISSING', `读取凭据失败：${e.message}`) }
  const missing = missingForWrite(cred, { needBuvid3: true })
  if (missing.length) {
    fail('AUTH_MISSING', `缺少写操作凭据：${missing.join('、')}\n  去设置页粘贴一次 B 站 cookie（SESSDATA + bili_jct + buvid3）再试`)
  }
  const net = typeof transport === 'function' ? transport : guardedFetch
  // 只有真发（走请求保护层）才需要等写冷却；单测注入 transport 时不等待。
  const live = typeof transport !== 'function'
  say(`[go] 开始投稿：${pkg.title}（${humanBytes(pkg.videoBytes)} 视频 + ${humanBytes(pkg.coverBytes)} 封面）`)
  const upload = await uploadVideo({ net, cred, pkg, say })
  const coverUrl = await uploadCover({ net, cred, pkg, say })
  // 投稿是两次写操作：封面 + add/v3。traffic.mjs 对写操作有全局冷却（默认 120s），
  // 挨着发第二写一定会被本地保护层拒绝 —— 这里按闸门的真实冷却等够，而不是把闸门关掉。
  if (live) {
    const gapSec = Math.max(30, Number(riskSettings().writeGapSec ?? 120))
    say(`[wait] 封面已上传；按请求保护等待写冷却 ${gapSec + 5}s 再提交（不是卡住，是在躲风控）…`)
    await new Promise((resolve) => setTimeout(resolve, (gapSec + 5) * 1000))
  }
  const submitted = await submitVideo({ net, cred, pkg, upload, coverUrl, say })

  // ⑦ 记账：publish.json + index.json（原子写；index 是频率闸的唯一依据）
  const publishedAt = isoLocal(new Date())
  const record = {
    version: 1,
    mode: 'go',
    slug,
    title: pkg.title,
    desc: pkg.desc,
    tags: pkg.tags,
    tid: pkg.tid,
    copyright: pkg.copyright,
    no_reprint: pkg.no_reprint,
    aiLabel: pkg.aiLabel,
    bvid: submitted.bvid,
    aid: submitted.aid,
    publishedAt,
    coverUrl,
    video: pkg.video,
    cover: pkg.cover,
    review: pkg.review,
  }
  try { writeJsonAtomic(publishFile, record) } catch (e) {
    fail('PUBLISH_RECORD_FAILED', `稿件已提交成功（bvid=${submitted.bvid}），但本地发布记录写不进去：${publishFile}\n  ${e.message}\n请人工把 bvid/aid/publishedAt 补记到 ${index.file}（否则频率闸会漏算）`)
  }
  try {
    appendIndex(index, { slug, title: pkg.title, bvid: submitted.bvid, aid: submitted.aid, publishedAt })
  } catch (e) {
    fail('INDEX_WRITE_FAILED', `稿件已提交成功（bvid=${submitted.bvid}），但发布索引写不进去：${index.file}\n  ${e.message}\n请人工补记（否则下一轮频率闸会漏算）`, { bvid: submitted.bvid })
  }
  const result = {
    ok: true,
    mode: 'go',
    bvid: submitted.bvid,
    aid: submitted.aid,
    publishedAt,
    title: pkg.title,
    publishFile,
    indexFile: index.file,
    message: `[go] ✅ 投稿成功：bvid=${submitted.bvid}  https://www.bilibili.com/video/${submitted.bvid}/`,
  }
  if (callerPrints) { /* 调用方自己打印（A 的 CLI）*/ } else if (json) console.log(JSON.stringify(result, null, 2))
  else printGoSummary(result, publishFile, index.file)
  return result
}

function requireMedia(file, label) {
  let st
  try { st = fs.statSync(file) } catch { fail('MISSING_MEDIA', `${label}文件不存在：${file}\n  （渲染没跑完？video render 成功后会写 video.mp4 / cover.jpg）`) }
  if (!st.isFile()) fail('MISSING_MEDIA', `${label}不是普通文件：${file}`)
  if (st.size <= 0) fail('MISSING_MEDIA', `${label}是 0 字节：${file}\n  （渲染失败/被截断？不要拿空文件去投稿）`)
  return { file, bytes: st.size }
}
/** dry 覆盖 publish.json 前，把之前真发过的 bvid 存进 previous，别把记录弄丢（索引才是频率唯一依据）。 */
function readPreviousPublish(workDir) {
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(workDir, 'publish.json'), 'utf8'))
    if (prev && typeof prev === 'object' && prev.bvid) {
      return { bvid: prev.bvid, aid: prev.aid ?? null, publishedAt: prev.publishedAt ?? null }
    }
  } catch { /* 没有/损坏都不影响：索引才是权威 */ }
  return null
}

// 内部工具（单测用；不属于对外接口）
export const __test = {
  buildAddBody,
  buildPackage,
  readIndex,
  appendIndex,
  objectKeyFilename,
  uposBaseUrl,
  normalizeDesc,
  isoLocal,
  charLen,
}
