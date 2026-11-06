/**
 * 端到端验证（宿主层）：真走 HTTP API 的路径，把 320×180 冒烟片重新渲染一遍。
 * 只用于开发期复核，不属于测试套件（会真跑 TTS/ffmpeg/Python，约 1 分钟）。
 *
 * 用法：node scripts/e2e-host.mjs <原冒烟目录>
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')
const srcDir = process.argv[2]
if (!srcDir || !fs.existsSync(path.join(srcDir, 'storyboard.json'))) {
  console.error('需要传入包含 storyboard.json 的冒烟目录')
  process.exit(2)
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'faship-e2e-'))
const DSH = path.join(HOME, '.dsh')
const VIDEO_ROOT = path.join(HOME, 'videos')
const WORK = path.join(VIDEO_ROOT, 'e2e-320')
fs.mkdirSync(DSH, { recursive: true })
fs.mkdirSync(WORK, { recursive: true })
const CFG = path.join(DSH, 'bili-faship.config.json')
fs.writeFileSync(CFG, JSON.stringify({
  version: 1,
  video: {
    outDir: VIDEO_ROOT,
    // 冒烟片只有 14.46s，默认 15s 下限会卡住自审（正式片不用改）
    minDurationSec: 8,
    paths: {
      cache: path.join(HOME, 'cache'),
      // 隔离的 DSH_HOME 里没有 ~/.dsh/bili-whale/bin 与表情包 → 显式指向本机真实路径
      ffmpeg: process.env.REAL_FFMPEG || 'C:/Users/zcr/.dsh/bili-whale/bin/ffmpeg.exe',
      stickers: process.env.REAL_STICKERS || 'C:/Users/zcr/.dsh/bili-whale/stickers/packs/大肥鱼',
    },
    publish: { tags: ['AI', '端到端'], titlePrefix: '【E2E】' },
  },
}, null, 2))
process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.env.DSH_HOME = DSH
process.env.BILI_FASHIP_CONFIG = CFG

// 只复制 storyboard（重渲染 → 验证整条链路），不复制成片/审查结果
fs.copyFileSync(path.join(srcDir, 'storyboard.json'), path.join(WORK, 'storyboard.json'))

const api = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'api.mjs')).href)
const API = api.API_PREFIX

const ctx = {
  get(k) { if (k === 'connection') return { requestRejection: () => undefined }; return undefined },
  tools: {},
  webServer: {},
}
function makeReq({ method = 'GET', url = API, body = null } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:57276' }
  if (body !== null) req.push(Buffer.from(JSON.stringify(body)))
  req.push(null)
  return req
}
function makeRes() {
  return {
    statusCode: 200, headers: {}, chunks: [], ended: false,
    writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); return this },
    end(chunk) { if (chunk !== undefined) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); this.ended = true; return this },
    on() {}, destroy() {},
  }
}
async function call({ method = 'GET', p = '/', body = null } = {}) {
  const res = makeRes()
  await api.handleApi(ctx, makeReq({ method, url: API + p, body }), res)
  const text = Buffer.concat(res.chunks).toString('utf8')
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = { __raw: text.slice(0, 500) } }
  return { status: res.statusCode, body: json, headers: res.headers }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('== 1) 起后台渲染任务 ==')
const started = await call({ method: 'POST', p: '/jobs', body: { action: 'render', dir: WORK } })
console.log('status', started.status, JSON.stringify(started.body).slice(0, 400))
if (!started.body?.job) { process.exit(1) }
const id = started.body.job.id

const t0 = Date.now()
let final = null
while (Date.now() - t0 < 240_000) {
  await sleep(2000)
  const r = await call({ p: `/jobs?id=${encodeURIComponent(id)}` })
  const job = r.body?.job
  if (!job) { console.error('查询失败', r.status, JSON.stringify(r.body).slice(0, 300)); break }
  process.stdout.write(`  [${Math.round((Date.now() - t0) / 1000)}s] ${job.status}\n`)
  if (job.status !== 'running') { final = job; break }
}
console.log('任务结论：', JSON.stringify(final && { status: final.status, exitCode: final.exitCode, note: final.note }))
if (final?.log) console.log('日志尾部：\n' + final.log.slice(-1200))

console.log('\n== 2) 视频列表 ==')
const vids = await call({ p: '/videos' })
const item = (vids.body?.videos || []).find((v) => v.dir === WORK)
console.log('status', vids.status, 'item=', JSON.stringify(item))

console.log('\n== 3) 状态 ==')
const st = await call({ p: '/status' })
console.log('status', st.status, 'due=', st.body?.due, 'indexState=', st.body?.indexState, 'reason=', st.body?.schedule?.reason, 'videos=', st.body?.videos)

console.log('\n== 4) /media HEAD（cover.jpg） ==')
const media = await call({ method: 'HEAD', p: `/media?dir=${encodeURIComponent(WORK)}&file=cover.jpg` })
console.log('status', media.status, 'content-type=', media.headers['Content-Type'], 'len=', media.headers['Content-Length'])

console.log('\n== 5) 自审（同步） ==')
const review = await call({ method: 'POST', p: '/jobs', body: { action: 'review', dir: WORK } })
console.log('status', review.status, 'ok=', review.body?.ok, 'pass=', review.body?.result?.pass, 'score=', review.body?.result?.score)

console.log('\n== 6) dry 投稿包（同步） ==')
const dry = await call({ method: 'POST', p: '/jobs', body: { action: 'publish-dry', dir: WORK } })
console.log('status', dry.status, 'ok=', dry.body?.ok, 'dryRun=', dry.body?.result?.dryRun ?? dry.body?.result?.dry, 'title=', dry.body?.result?.title ?? dry.body?.result?.pkg?.title)
console.log('publish.json 存在=', fs.existsSync(path.join(WORK, 'publish.json')))

console.log('\n== 7) 证据目录 ==')
console.log(HOME)
fs.writeFileSync(path.join(HOME, 'summary.json'), JSON.stringify({ id, final: final && { status: final.status, exitCode: final.exitCode }, videos: vids.body, status: st.body, media: { status: media.status, headers: media.headers }, review: review.body, dry: dry.body }, null, 2))
