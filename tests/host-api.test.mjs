/**
 * host-api.test.mjs —— 宿主 HTTP API 的离线单测（假 req/res + 假 ctx，不联网）。
 *
 * 覆盖：信任栅栏（fail-closed / 非回环拒绝 / 栅栏拒绝码透传）、设置读写、
 *       status/videos/deps/report、jobs 的参数闸门（不允许真发跑出去）、
 *       cookie 校验、/media 路径限制。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

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

test('api: 非回环 Host 一律 403（防服务绑 0.0.0.0）', async () => {
  const r = await call({ host: '192.168.1.5:57276' })
  assert.equal(r.status, 403)
  assert.match(r.body.error, /本机回环/)
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

test('api: 根路径返回 API 摘要', async () => {
  const r = await call({ path: '/' })
  assert.equal(r.status, 200)
  assert.equal(r.body.api, API)
})
