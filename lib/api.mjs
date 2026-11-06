/**
 * lib/api.mjs —— 宿主 HTTP API 的**业务实现** + 路由分发。
 *
 * 所有路由都在 /dsh-bili-faship/api/* 下：
 *   GET  /settings         读配置（合并默认值）
 *   POST /settings         存配置（白名单 + 范围校验）
 *   GET  /status           创作/发布/生物钟/任务状态
 *   GET  /videos           视频列表（含 review / publish / 封面）
 *   GET  /deps             依赖体检
 *   POST /cookie           写 B 站凭据（只写不读回）
 *   POST /jobs             起任务（plan / render / review / publish-dry / publish-go）
 *   GET  /jobs             任务列表；?id= 取单个（带日志尾部）
 *   POST /wake             立刻叫醒一次（"现在做一条"）
 *   GET  /report           最后一次汇报
 *   GET  /media?dir=&file= 读成片/封面/字幕/审查报告（只读 videoRoot 内）
 *
 * 安全（dsh-bili-whale 的教训，一条都不能省）：
 *   · 每个请求先过 DSH 信任栅栏（connection.requestRejection，fail-closed）
 *   · Host 必须是本机回环（服务万一绑到 0.0.0.0 也不放行）
 *   · 写操作只接受本机；凭据不回显、不落日志
 *   · 任务参数只走白名单动作 + videoRoot 内目录
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOME } from '../tools/lib/paths.mjs'
import {
  CONFIG_FILE, mergedConfig, saveConfig, videoRoot, videoDir,
} from './config.mjs'
import { runDeps, stickerDir } from './deps.mjs'
import { initJobs, listJobs, getJob, startJob, runSync, resolveDir, activeJob, ACTIONS } from './jobs.mjs'
import { getStatus, listVideos, readReport } from './status.mjs'
import { deliverWake } from './scheduler.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const API_PREFIX = '/dsh-bili-faship/api'
const PLUGIN_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0' } catch { return '0.0.0' }
})()

/** 媒体文件白名单（只读这些；不许任意路径） */
const MEDIA_TYPES = {
  'video.mp4': 'video/mp4',
  'cover.jpg': 'image/jpeg',
  'subtitles.srt': 'text/plain; charset=utf-8',
  'review.json': 'application/json; charset=utf-8',
  'storyboard.json': 'application/json; charset=utf-8',
  'meta.json': 'application/json; charset=utf-8',
  'timing.json': 'application/json; charset=utf-8',
  'publish.json': 'application/json; charset=utf-8',
}

function log(...args) {
  try { console.log('[bili-faship api]', ...args) } catch { /* 忽略 */ }
}

function sendJson(res, code, obj) {
  try {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(obj))
  } catch (e) { log('响应失败：' + e.message) }
}

function readBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); try { req.destroy() } catch {} return }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) { resolve({}); return }
      try { resolve(JSON.parse(text)) } catch (e) { reject(new Error('JSON 解析失败：' + e.message)) }
    })
    req.on('error', reject)
  })
}

/* ───────────────────────── 安全栅栏 ───────────────────────── */

function isLoopbackReq(req) {
  const host = String(req.headers?.host ?? '').toLowerCase()
  const h = host.split(':')[0]
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
}

/**
 * DSH 信任栅栏（fail-closed）：栅栏拿不到 → 拒绝，而不是放行。
 * @returns {boolean} true = 已拒绝（响应已写）
 */
export function rejected(ctx, req, res) {
  if (!isLoopbackReq(req)) {
    sendJson(res, 403, { ok: false, error: '只接受本机回环访问' })
    return true
  }
  try {
    const conn = (typeof ctx?.get === 'function' ? ctx.get('connection') : null) || ctx?.connection
    if (!conn || typeof conn.requestRejection !== 'function') {
      if (!rejected.warned) {
        rejected.warned = true
        log('信任栅栏不可用（connection 服务缺失）—— 按 fail-closed 拒绝所有 API 请求')
      }
      sendJson(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问（fail-closed）' })
      return true
    }
    let code
    try { code = conn.requestRejection(req) } catch {
      // 契约入参是 { headers }（ConnectionTrustRequest）；两种形状都试一遍
      code = conn.requestRejection({ headers: req.headers })
    }
    if (code === undefined || code === null || code === false) return false
    res.statusCode = typeof code === 'number' ? code : 403
    try { res.end() } catch { /* 忽略 */ }
    return true
  } catch (e) {
    sendJson(res, 503, { ok: false, error: `信任栅栏异常，拒绝访问（fail-closed）：${String(e?.message ?? e).slice(0, 160)}` })
    return true
  }
}

/* ───────────────────────── 业务操作 ───────────────────────── */

export function getSettings() {
  return {
    ok: true,
    config: mergedConfig(),
    configPath: CONFIG_FILE,
    videoRoot: videoRoot(),
    pluginRoot: ROOT,
    home: path.dirname(CONFIG_FILE),
    version: PLUGIN_VERSION,
    stickerDir: stickerDir(),
  }
}

export function postSettings(body) {
  return saveConfig(body)
}

export async function getStatusFull() {
  initOnce()
  const st = await getStatus()
  st.home = path.dirname(CONFIG_FILE)
  st.configPath = CONFIG_FILE
  return st
}

export function getVideos() {
  const v = listVideos()
  return { ok: true, ...v }
}

export async function getDeps() {
  const d = await runDeps()
  return { ok: d.ok, ...d }
}

/** 写 cookie：清洗 + 逐字段体检 + （可选）nav 验证；只写不读回 */
export async function postCookie(body = {}) {
  const pick = (raw, key) => {
    let v = String(raw ?? '').trim()
    const m = v.match(new RegExp(`(?:^|;)\\s*${key}=([^;]+)`, 'i'))
    if (m) return m[1].trim()
    v = v.replace(new RegExp(`^${key}\\s*=`, 'i'), '')
    v = v.replace(/^["'\s]+|["';\s]+$/g, '')
    return v
  }
  const sessdata = pick(body.sessdata, 'SESSDATA')
  const bili_jct = pick(body.bili_jct, 'bili_jct')
  const buvid3 = pick(body.buvid3, 'buvid3')
  const problems = []
  if (!sessdata) problems.push('SESSDATA 空着（它是 HttpOnly，document.cookie 读不到；F12 → Application → Cookies 手动复制）')
  else if (sessdata.length < 20) problems.push(`SESSDATA 太短（长度 ${sessdata.length}）—— 大概只复制到一半`)
  if (!bili_jct) problems.push('bili_jct 空着')
  else if (!/^[0-9a-fA-F]{32}$/.test(bili_jct)) problems.push(`bili_jct 格式不对（长度 ${bili_jct.length}，B站 目前是 32 位十六进制）`)
  const buvid3LooksOdd = Boolean(buvid3 && !/^[0-9A-Za-z]{6,}-[0-9A-Za-z-]{18,}$/.test(buvid3))
  if (problems.length) {
    return { ok: false, status: 400, error: `凭据有问题，没写入：\n  · ${problems.join('\n  · ')}` }
  }
  const file = path.join(HOME, '.bili-ai', 'credentials.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ sessdata, bili_jct, buvid3 }, null, 2)}\n`)
  try { fs.chmodSync(file, 0o600) } catch { /* Windows 下无意义 */ }

  // 顺手问一次 nav（失败不影响写入，只是"确认不了"）
  let whoNow = null
  let navCode = null
  let navMsg = ''
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 10_000)
    t.unref?.()
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: {
        'user-agent': 'Mozilla/5.0',
        referer: 'https://www.bilibili.com/',
        cookie: `SESSDATA=${sessdata}; bili_jct=${bili_jct}; buvid3=${buvid3}`,
      },
      signal: ac.signal,
    })
    const j = await r.json().catch(() => ({}))
    navCode = j?.code ?? null
    navMsg = String(j?.message ?? '')
    if (j?.data?.isLogin && j.data.mid) whoNow = { mid: String(j.data.mid), name: String(j.data.uname ?? '') }
  } catch (e) {
    navMsg = String(e?.message ?? e).slice(0, 120)
  }
  return {
    ok: true,
    warn: buvid3LooksOdd ? 'buvid3 格式有点怪（不影响使用，想要的话重新复制一次）' : null,
    self: whoNow,
    detail: whoNow
      ? `已写入 ✓ 当前登录：${whoNow.name}（mid ${whoNow.mid}）`
      : `已写入，但 B站 不认这个 cookie${navCode != null ? `（nav code=${navCode} ${navMsg}）` : navMsg ? `（请求失败：${navMsg}）` : ''}`
        + ' —— 常见原因：SESSDATA 截断 / 复制自无痕窗口 / 已过期。重新复制一次 SESSDATA 和 bili_jct。',
  }
}

/**
 * 起一个动作（POST /jobs 与工具共用）。
 * @returns {Promise<object>}
 */
export async function runAction({ action, dir, topic, width, height, fps, confirm } = {}) {
  if (!ACTIONS.includes(action)) return { ok: false, status: 400, error: `未知动作：${action}` }
  const cfg = mergedConfig()
  try {
    if (action === 'plan') {
      const target = dir ? resolveDir(dir) : ''
      const r = await runSync('plan', { dir: target || undefined, topic, width, height, fps })
      if (!r.ok) return { ok: false, status: 200, error: `${r.stderr || r.stdout || 'plan 失败'}`.slice(0, 800) }
      return { ok: true, result: r.json }
    }
    const target = resolveDir(dir)
    if (action === 'review') {
      const r = await runSync('review', { dir: target })
      return { ok: r.ok, result: r.json, stdout: r.ok ? undefined : r.stdout.slice(-2000), error: r.ok ? undefined : (r.stderr || r.stdout || 'review 失败').slice(0, 1200) }
    }
    if (action === 'publish-dry') {
      const r = await runSync('publish-dry', { dir: target })
      return { ok: r.ok, result: r.json, stdout: r.ok ? undefined : r.stdout.slice(-2000), error: r.ok ? undefined : (r.stderr || r.stdout || '生成投稿包失败').slice(0, 1200) }
    }
    if (action === 'publish-go') {
      if (confirm !== true) return { ok: false, status: 400, error: '真发必须显式确认（confirm: true）' }
      if (cfg.autoPublish?.allowGo !== true) return { ok: false, status: 403, error: '设置里没有打开「允许真发」（autoPublish.allowGo）。先打开并确认。' }
      if (cfg.publish?.enabled === false) return { ok: false, status: 403, error: 'publish.enabled=false，投稿被关掉了' }
      let review = null
      try { review = JSON.parse(fs.readFileSync(path.join(target, 'review.json'), 'utf8')) } catch { /* 没有 */ }
      if (review?.pass !== true) return { ok: false, status: 409, error: 'review 还没有 pass —— 自审是发布前置硬闸门，不能跳过' }
      if (cfg.autoPublish?.dryRun !== false) return { ok: false, status: 409, error: 'autoPublish.dryRun=true：当前策略只做 dry 投稿包。要真发请先在设置里关掉 dryRun。' }
      const job = startJob('publish-go', { dir: target })
      return job.ok ? { ok: true, job: job.job } : { ok: false, status: 409, error: job.error, job: job.job }
    }
    // render
    const job = startJob('render', { dir: target })
    return job.ok ? { ok: true, job: job.job } : { ok: false, status: 409, error: job.error, job: job.job }
  } catch (e) {
    return { ok: false, status: 400, error: String(e?.message ?? e).slice(0, 600) }
  }
}

export async function wakeNow(ctx, { manual = true, reason = '手动' } = {}) {
  return deliverWake(ctx, { manual, reason, cliPath: path.join(ROOT, 'tools', 'bili-faship.mjs') })
}

/* ───────────────────────── 媒体 ───────────────────────── */

export function resolveMedia(dirParam, fileParam) {
  const file = String(fileParam ?? '')
  if (!MEDIA_TYPES[file]) throw Object.assign(new Error('不允许读取这个文件'), { status: 403 })
  const root = videoRoot()
  let dir
  if (dirParam) dir = resolveDir(dirParam)
  else dir = root
  const abs = path.join(dir, file)
  const rel = path.relative(root, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw Object.assign(new Error('路径越界'), { status: 403 })
  return { abs, type: MEDIA_TYPES[file] }
}

function serveMedia(req, res, url) {
  let target
  try {
    target = resolveMedia(url.searchParams.get('dir'), url.searchParams.get('file'))
  } catch (e) {
    sendJson(res, e.status || 400, { ok: false, error: e.message })
    return
  }
  let st
  try { st = fs.statSync(target.abs) } catch {
    sendJson(res, 404, { ok: false, error: '文件不存在（还没渲染/还没生成投稿包？）' })
    return
  }
  if (!st.isFile()) { sendJson(res, 404, { ok: false, error: '不是文件' }); return }
  res.writeHead(200, {
    'Content-Type': target.type,
    'Content-Length': st.size,
    'Cache-Control': 'no-store',
  })
  if (req.method === 'HEAD') { res.end(); return }
  const stream = fs.createReadStream(target.abs)
  stream.on('error', () => { try { res.destroy() } catch {} })
  stream.pipe(res)
}

/* ───────────────────────── 路由 ───────────────────────── */

let inited = false
function initOnce() {
  if (inited) return
  inited = true
  try { initJobs() } catch (e) { log('initJobs 失败：' + e.message) }
}

/**
 * 处理 /dsh-bili-faship/api 下的请求。
 * 路由注册见 index.js；这里只做分发。
 */
export async function handleApi(ctx, req, res) {
  initOnce()
  if (rejected(ctx, req, res)) return
  let url
  try { url = new URL(req.url, 'http://127.0.0.1') } catch { sendJson(res, 400, { ok: false, error: 'bad url' }); return }
  const sub = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'
  const method = String(req.method || 'GET').toUpperCase()
  try {
    if (sub === '/settings') {
      if (method === 'GET') { sendJson(res, 200, getSettings()); return }
      if (method === 'POST') {
        const body = await readBody(req)
        const r = postSettings(body)
        sendJson(res, r.ok ? 200 : 400, r)
        return
      }
      sendJson(res, 405, { ok: false, error: 'method not allowed' }); return
    }
    if (sub === '/status') { sendJson(res, 200, await getStatusFull()); return }
    if (sub === '/videos') { sendJson(res, 200, getVideos()); return }
    if (sub === '/deps') { sendJson(res, 200, await getDeps()); return }
    if (sub === '/cookie') {
      if (method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const body = await readBody(req)
      const r = await postCookie(body)
      sendJson(res, r.status || 200, r)
      return
    }
    if (sub === '/jobs') {
      if (method === 'GET') {
        const id = url.searchParams.get('id')
        if (id) {
          const j = getJob(id)
          if (!j) { sendJson(res, 404, { ok: false, error: '没有这个任务' }); return }
          sendJson(res, 200, { ok: true, job: j, log: j.log })
          return
        }
        sendJson(res, 200, { ok: true, jobs: listJobs(), active: activeJob() })
        return
      }
      if (method === 'POST') {
        const body = await readBody(req)
        const r = await runAction(body)
        sendJson(res, r.status || 200, r)
        return
      }
      sendJson(res, 405, { ok: false, error: 'method not allowed' }); return
    }
    if (sub === '/wake') {
      if (method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const r = await wakeNow(ctx, { manual: true, reason: '设置页/工具' })
      sendJson(res, r.ok ? 200 : 503, r)
      return
    }
    if (sub === '/report') { sendJson(res, 200, { ok: true, ...readReport() }); return }
    if (sub === '/media') {
      if (method !== 'GET' && method !== 'HEAD') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      serveMedia(req, res, url); return
    }
    if (sub === '/' || sub === '') { sendJson(res, 200, { ok: true, api: API_PREFIX, version: PLUGIN_VERSION }); return }
    sendJson(res, 404, { ok: false, error: `没有这个接口：${sub}` })
  } catch (e) {
    log(`处理 ${method} ${sub} 失败：${e?.message ?? e}`)
    sendJson(res, 500, { ok: false, error: String(e?.message ?? e).slice(0, 800) })
  }
}

export { videoDir, PLUGIN_VERSION }
