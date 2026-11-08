/**
 * host-api.test.mjs —— 宿主 HTTP API 的离线单测（假 req/res + 假 ctx，不联网）。
 *
 * 覆盖：信任栅栏（fail-closed / 宿主栅栏权威 / IPv6 回环识别 / 栅栏拒绝码透传）、设置读写、
 *       status/videos/deps/report、jobs 的参数闸门（不允许真发跑出去）、
 *       cookie 校验、/media 路径限制（含 junction 逃逸）。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'faship-host-api-'))
const DSH = path.join(HOME, '.dsh')
const VIDEO_ROOT = path.join(HOME, 'videos')
fs.mkdirSync(DSH, { recursive: true })
fs.mkdirSync(VIDEO_ROOT, { recursive: true })
const CFG = path.join(DSH, 'bili-faship.config.json')
fs.writeFileSync(CFG, JSON.stringify({ version: 1, video: { outDir: VIDEO_ROOT } }, null, 2))
process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.env.DSH_HOME = DSH
process.env.BILI_FASHIP_CONFIG = CFG
process.env.BILI_WHALE_CONFIG = path.join(DSH, 'no-such-whale-config.json')
delete process.env.WHALE_VIDEO_CACHE
delete process.env.WHALE_STICKER_DIR

after(() => fs.rmSync(HOME, { recursive: true, force: true }))

const api = await import('../lib/api.mjs')
const cfgMod = await import('../lib/config.mjs')

const API = api.API_PREFIX
const allowConn = { requestRejection: () => undefined }

function makeCtx({ connection = allowConn, sessionController = undefined } = {}) {
  return {
    get(k) {
      if (k === 'connection') return connection
      if (k === 'sessionController') return sessionController
      return undefined
    },
    tools: {},
    webServer: {},
  }
}
function makeReq({ method = 'GET', url = API, host = '127.0.0.1:57276', body = null, headers = {} } = {}) {
  const req = new Readable({ read() { /* noop */ } })
  req.method = method
  req.url = url
  req.headers = { host, ...headers }
  if (body !== null) req.push(Buffer.from(JSON.stringify(body)))
  req.push(null)
  return req
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    ended: false,
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); return this },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      this.ended = true
      return this
    },
    on() { /* 忽略 */ },
    destroy() { /* 忽略 */ },
  }
}

const jsonOf = (res) => {
  const text = Buffer.concat(res.chunks).toString('utf8')
  try { return text ? JSON.parse(text) : null } catch { return { __raw: text } }
}

async function call({ method = 'GET', path: p = '/settings', body = null, ctx = makeCtx(), host = '127.0.0.1:57276' } = {}) {
  const req = makeReq({ method, url: API + p, body, host })
  const res = makeRes()
  await api.handleApi(ctx, req, res)
  return { status: res.statusCode, body: jsonOf(res), res }
}

const writeCfg = (videoPatch) => {
  fs.writeFileSync(CFG, JSON.stringify({ version: 1, video: { outDir: VIDEO_ROOT, ...videoPatch } }, null, 2))
  cfgMod.resetVideoConfig()
}

// ---------------------------------------------------------------------------
// 信任栅栏
// ---------------------------------------------------------------------------

test('api: 回环判定不再自己 403 —— 非回环 Host 交给宿主栅栏（IPv6/trustedHosts 修复）', async () => {
  // v0.2.0 用 host.split(':')[0] 判回环：`[::1]:65026` 被判成 `[` → 自己 403，
  // 也把宿主 trustedHosts / 远程访问部署一律 403。现在权威边界是宿主 requestRejection。
  // ① 宿主栅栏放行（默认 stub）→ 非回环也允许（远程访问靠这个）
  let r = await call({ host: '192.168.1.5:57276' })
  assert.equal(r.status, 200)
  // ② 宿主栅栏拒绝 → 原样透传（真实 DSH 对不可信 Host 会 403）
  r = await call({ host: '192.168.1.5:57276', ctx: makeCtx({ connection: { requestRejection: () => 403 } }) })
  assert.equal(r.status, 403)
  // ③ IPv6 回环必须被认出（旧实现这里是 false）
  assert.equal(api.isLoopbackReq({ headers: { host: '[::1]:65026' } }), true)
  assert.equal(api.isLoopbackReq({ headers: { host: '[::1]' } }), true)
  assert.equal(api.isLoopbackReq({ headers: { host: '127.0.0.1:1' } }), true)
  assert.equal(api.isLoopbackReq({ headers: { host: 'localhost:65026' } }), true)
  assert.equal(api.isLoopbackReq({ headers: { host: 'evil.com' } }), false)
  assert.equal(api.isLoopbackReq({ headers: {} }), false)
})

test('api: 信任栅栏拒绝码原样透传', async () => {
  const r = await call({ ctx: makeCtx({ connection: { requestRejection: () => 401 } }) })
  assert.equal(r.status, 401)
})

test('api: 栅栏服务缺失 → fail-closed 503（不放行）', async () => {
  // 注意：传 null 覆盖默认；传 undefined 会触发解构默认值（= 放行），那是测试写错
  const r = await call({ ctx: makeCtx({ connection: null }) })
  assert.equal(r.status, 503)
  assert.match(r.body.error, /fail-closed/)
})

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

test('api: GET /settings 返回合并配置与路径信息', async () => {
  writeCfg({})
  const r = await call({ path: '/settings' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.config.cadenceDays, 3)
  assert.equal(r.body.config.autoPublish.allowGo, false)
  assert.ok(r.body.configPath.endsWith('bili-faship.config.json'))
  assert.equal(r.body.videoRoot, path.resolve(VIDEO_ROOT))
})

test('api: POST /settings 接受 {config} 并生效', async () => {
  writeCfg({})
  const r = await call({ method: 'POST', path: '/settings', body: { config: { cadenceDays: 7 } } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.ok, true)
  assert.equal(r.body.config.cadenceDays, 7)
  const saved = JSON.parse(fs.readFileSync(CFG, 'utf8'))
  assert.equal(saved.video.cadenceDays, 7)
})

test('api: POST /settings 非法值 → 400 + errors 数组', async () => {
  writeCfg({})
  const r = await call({ method: 'POST', path: '/settings', body: { config: { cadenceDays: 0 } } })
  assert.equal(r.status, 400)
  assert.equal(r.body.ok, false)
  assert.ok(Array.isArray(r.body.errors) && r.body.errors.length > 0)
})

// ---------------------------------------------------------------------------
// 状态 / 列表 / 体检 / 汇报
// ---------------------------------------------------------------------------

test('api: GET /status 有完整形状（没有 index 也 due=true）', async () => {
  writeCfg({})
  try { fs.rmSync(path.join(VIDEO_ROOT, 'index.json'), { force: true }) } catch {}
  const r = await call({ path: '/status' })
  assert.equal(r.status, 200)
  assert.equal(r.body.due, true)
  assert.equal(r.body.indexState, 'missing')
  assert.ok(r.body.schedule)
  assert.ok(Array.isArray(r.body.jobs))
  assert.ok(r.body.configPath)
})

test('api: GET /videos 返回列表结构', async () => {
  const dir = path.join(VIDEO_ROOT, 'demo')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'storyboard.json'), JSON.stringify({ version: 4, slug: 'demo', title: '样例', scenes: [] }))
  const r = await call({ path: '/videos' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.ok(r.body.videos.some((v) => v.slug === 'demo'))
})

test('api: GET /deps 返回 items（硬依赖失败也只是 ok:false，不 500）', async () => {
  const r = await call({ path: '/deps' })
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.body.items) && r.body.items.length >= 5)
  assert.ok(r.body.items.some((i) => i.name.includes('node')))
  assert.ok(r.body.items.some((i) => i.name.includes('ffmpeg')))
  assert.ok(r.body.items.some((i) => i.name.includes('Python')))
})

test('api: GET /report 空文件也返回 ok:true', async () => {
  const r = await call({ path: '/report' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(typeof r.body.text, 'string')
})

// ---------------------------------------------------------------------------
// 任务闸门（关键：任何情况下都不能让真发跑出去）
// ---------------------------------------------------------------------------

test('api: POST /jobs 未知动作 → 400', async () => {
  const r = await call({ method: 'POST', path: '/jobs', body: { action: 'rm-rf' } })
  assert.equal(r.status, 400)
})

test('api: POST /jobs render 缺 dir → 400', async () => {
  const r = await call({ method: 'POST', path: '/jobs', body: { action: 'render' } })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /目录/)
})

test('api: publish-go 没有 confirm → 400', async () => {
  const r = await call({ method: 'POST', path: '/jobs', body: { action: 'publish-go', dir: VIDEO_ROOT } })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /确认/)
})

test('api: publish-go 没打开 allowGo → 403（即使 confirm）', async () => {
  writeCfg({})
  const r = await call({ method: 'POST', path: '/jobs', body: { action: 'publish-go', dir: VIDEO_ROOT, confirm: true } })
  assert.equal(r.status, 403)
  assert.match(r.body.error, /allowGo/)
})

test('api: publish-go 没 review pass → 409', async () => {
  writeCfg({ autoPublish: { allowGo: true, dryRun: false } })
  const r = await call({ method: 'POST', path: '/jobs', body: { action: 'publish-go', dir: VIDEO_ROOT, confirm: true } })
  assert.equal(r.status, 409)
  assert.match(r.body.error, /review/)
})

test('api: publish-go review pass 但 dryRun 还开着 → 409（不会真发）', async () => {
  writeCfg({ autoPublish: { allowGo: true, dryRun: true } })
  fs.writeFileSync(path.join(VIDEO_ROOT, 'review.json'), JSON.stringify({ pass: true, score: 100 }))
  const r = await call({ method: 'POST', path: '/jobs', body: { action: 'publish-go', dir: VIDEO_ROOT, confirm: true } })
  assert.equal(r.status, 409)
  assert.match(r.body.error, /dryRun/)
  fs.rmSync(path.join(VIDEO_ROOT, 'review.json'), { force: true })
  writeCfg({})
})

// ---------------------------------------------------------------------------
// cookie / media / 未知路由 / 手动叫醒
// ---------------------------------------------------------------------------

test('api: POST /cookie 空值 → 400（并把该怎么复制说清楚）', async () => {
  const r = await call({ method: 'POST', path: '/cookie', body: {} })
  assert.equal(r.status, 400)
  assert.equal(r.body.ok, false)
  assert.match(r.body.error, /SESSDATA/)
})

test('api: POST /cookie jct 格式不对 → 400，且不写文件', async () => {
  const credFile = path.join(HOME, '.bili-ai', 'credentials.json')
  fs.rmSync(credFile, { force: true })
  const r = await call({ method: 'POST', path: '/cookie', body: { sessdata: 'x'.repeat(30), bili_jct: 'not-hex' } })
  assert.equal(r.status, 400)
  assert.equal(fs.existsSync(credFile), false)
})

test('api: /media 只允许白名单文件，越界/未知 → 403', async () => {
  let r = await call({ path: '/media?dir=demo&file=../../../secret.txt' })
  assert.equal(r.status, 403)
  r = await call({ path: '/media?dir=demo&file=evil.exe' })
  assert.equal(r.status, 403)
})

test('api: /media 白名单内但不存在 → 404', async () => {
  const r = await call({ path: '/media?dir=demo&file=video.mp4' })
  assert.equal(r.status, 404)
})

test('api: 未知接口 → 404', async () => {
  const r = await call({ path: '/nope' })
  assert.equal(r.status, 404)
})

test('api: POST /wake 在拿不到 sessionController 时回 503（不假装成功）', async () => {
  const r = await call({ method: 'POST', path: '/wake' })
  assert.equal(r.status, 503)
  assert.equal(r.body.ok, false)
  assert.match(r.body.reason, /session-controller/)
})

test('api: POST /wake 有 sessionController 时建 manual 工单并派工（v0.2）', async () => {
  writeCfg({})
  fs.rmSync(path.join(DSH, 'bili-faship', 'tickets.json'), { force: true })
  const prompts = []
  const sessionController = {
    async create() { return { sessionId: 'x' } },
    async prompt(req) { prompts.push(req); return { ok: true } },
  }
  const r = await call({ method: 'POST', path: '/wake', body: { reason: '测试' }, ctx: makeCtx({ sessionController }) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.ok, true)
  assert.ok(r.body.ticket?.id)
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].content[0].text, /工单/)

  const tickets = await call({ path: '/tickets' })
  assert.equal(tickets.status, 200)
  assert.ok(Array.isArray(tickets.body.attention))
  assert.ok(tickets.body.tickets.some((t) => t.id === r.body.ticket.id))
  assert.ok(tickets.body.admission)

  // ack 一个工单动作
  const ack = await call({ method: 'POST', path: '/tickets', body: { id: r.body.ticket.id, action: 'ack' } })
  assert.equal(ack.status, 200, JSON.stringify(ack.body))
  assert.equal(ack.body.ok, true)
  // stop 结案
  const stop = await call({ method: 'POST', path: '/tickets', body: { id: r.body.ticket.id, action: 'stop' } })
  assert.equal(stop.status, 200, JSON.stringify(stop.body))
  assert.equal(stop.body.ticket.outcome.kind, 'stopped')
  // 未知动作
  const bad = await call({ method: 'POST', path: '/tickets', body: { id: r.body.ticket.id, action: 'boom' } })
  assert.equal(bad.status, 400)
  fs.rmSync(path.join(DSH, 'bili-faship', 'tickets.json'), { force: true })
})

test('api: GET /status 带 needsAttention / tickets / admission（v0.2）', async () => {
  writeCfg({})
  const r = await call({ path: '/status' })
  assert.equal(r.status, 200)
  assert.equal(typeof r.body.needsAttention, 'number')
  assert.ok(r.body.tickets && typeof r.body.tickets.open === 'number')
  assert.ok(r.body.admission === null || typeof r.body.admission === 'object')
})

test('api: 根路径返回 API 摘要', async () => {
  const r = await call({ path: '/' })
  assert.equal(r.status, 200)
  assert.equal(r.body.api, API)
})

// ---------------------------------------------------------------------------
// v0.2.1 修复回归：配置损坏备份 / 相对 outDir / Range / junction / 请求体
// ---------------------------------------------------------------------------

/** 直接构造 req（可带 raw body / 自定义 headers），用于测 readBody 与 Range */
async function callRaw({ method = 'GET', path: p = '/settings', host = '127.0.0.1:57276', rawBody = null, headers = {}, ctx = makeCtx() } = {}) {
  const req = new Readable({ read() { /* noop */ } })
  req.method = method
  req.url = API + p
  req.headers = { host, ...headers }
  if (rawBody !== null) req.push(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody)))
  req.push(null)
  const res = makeRes()
  await api.handleApi(ctx, req, res)
  return { status: res.statusCode, body: jsonOf(res), res }
}

test('config: 损坏的配置文件 → GET /settings 带 warning；保存时备份原件再覆盖', async () => {
  const corrupt = '{ this is not json '
  fs.writeFileSync(CFG, corrupt)
  cfgMod.resetVideoConfig()
  let r = await call({ path: '/settings' })
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.body.warnings) && r.body.warnings.some((w) => w.includes('不是合法 JSON')), JSON.stringify(r.body.warnings))

  r = await call({ method: 'POST', path: '/settings', body: { config: { cadenceDays: 4 } } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const baks = fs.readdirSync(DSH).filter((f) => /\.corrupt-\d+\.bak$/.test(f))
  assert.equal(baks.length, 1, '损坏文件应被备份：' + baks.join(','))
  assert.equal(fs.readFileSync(path.join(DSH, baks[0]), 'utf8'), corrupt, '备份内容应是原损坏内容')
  assert.ok(r.body.warnings.some((w) => w.includes('已备份')))
  writeCfg({})
})

test('config: 拒绝相对 outDir / 非字符串红线词 / 非法语速音高', async () => {
  let r = await call({ method: 'POST', path: '/settings', body: { config: { outDir: 'relative/dir' } } })
  assert.equal(r.status, 400)
  assert.ok(r.body.errors.some((e) => e.includes('outDir')), JSON.stringify(r.body.errors))

  r = await call({ method: 'POST', path: '/settings', body: { config: { redlines: { bannedWords: ['ok', 1] } } } })
  assert.equal(r.status, 400)
  assert.ok(r.body.errors.some((e) => e.includes('bannedWords')))

  r = await call({ method: 'POST', path: '/settings', body: { config: { voice: { rate: 'abc' } } } })
  assert.equal(r.status, 400)
  assert.ok(r.body.errors.some((e) => e.includes('voice.rate')))

  r = await call({ method: 'POST', path: '/settings', body: { config: { voice: { rate: '+8%', pitch: '+8Hz' } } } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
})

test('api: 坏 JSON 请求体 → 400 且错误信息不回显 body（cookie 片段不落日志/响应）', async () => {
  const r = await callRaw({ method: 'POST', path: '/cookie', rawBody: 'SESSDATA=SECRET_VALUE_123' })
  assert.equal(r.status, 400)
  assert.equal(r.body.error, '请求体不是合法 JSON')
  assert.equal(JSON.stringify(r.body).includes('SECRET_VALUE_123'), false)
})

/** 真 Writable 假 res：/media 的管道（pipe）需要真实流接口 */
function makeStreamRes() {
  const chunks = []
  const res = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb() } })
  res.statusCode = 200
  res.headers = {}
  res.chunks = chunks
  res.writeHead = (code, headers) => { res.statusCode = code; Object.assign(res.headers, headers || {}); return res }
  return res
}
async function callStream({ method = 'GET', path: p = '/', headers = {}, ctx = makeCtx() } = {}) {
  const req = new Readable({ read() { /* noop */ } })
  req.method = method
  req.url = API + p
  req.headers = { host: '127.0.0.1:57276', ...headers }
  req.push(null)
  const res = makeStreamRes()
  await api.handleApi(ctx, req, res)
  if (!res.writableFinished) await new Promise((resolve) => { res.once('finish', resolve); setTimeout(resolve, 2000).unref?.() })
  return { status: res.statusCode, headers: res.headers, chunks: res.chunks }
}

test('api: /media 支持 Range（206 + Content-Range），视频可拖动/续播', async () => {
  const demo = path.join(VIDEO_ROOT, 'range-demo')
  fs.mkdirSync(demo, { recursive: true })
  fs.writeFileSync(path.join(demo, 'video.mp4'), Buffer.from('0123456789'))
  const p = '/media?dir=range-demo&file=video.mp4'
  let r = await callStream({ path: p, headers: { range: 'bytes=2-5' } })
  assert.equal(r.status, 206)
  assert.equal(r.headers['Content-Range'], 'bytes 2-5/10')
  assert.equal(Buffer.concat(r.chunks).toString('utf8'), '2345')
  assert.equal(r.headers['Accept-Ranges'], 'bytes')
  r = await callStream({ path: p, headers: { range: 'bytes=99-' } })
  assert.equal(r.status, 416)
  assert.equal(r.headers['Content-Range'], 'bytes */10')
})

test('api: /media 不能通过 junction 逃出 videoRoot（v0.2.0 实测逃逸）', async () => {
  const outside = path.join(HOME, 'outside-root')
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'review.json'), JSON.stringify({ secret: 'outside-root' }))
  const link = path.join(VIDEO_ROOT, 'junction-link')
  try { fs.rmSync(link, { recursive: true, force: true }) } catch { /* 忽略 */ }
  try {
    fs.symlinkSync(outside, link, 'junction')
  } catch {
    return // 当前环境不允许建链接：跳过（不算失败）
  }
  const r = await call({ path: '/media?dir=junction-link&file=review.json' })
  assert.equal(r.status, 403, JSON.stringify(r.body))
})

test('api: 只读路由不接受 POST（405）', async () => {
  for (const p of ['/status', '/videos', '/deps', '/report']) {
    const r = await call({ method: 'POST', path: p })
    assert.equal(r.status, 405, p + ' -> ' + r.status)
  }
})
