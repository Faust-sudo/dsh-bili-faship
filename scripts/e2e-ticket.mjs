/**
 * 端到端验证（v0.2 工单流）：模拟「叫醒 → agent 做片 → 报工单」整条链路。
 * 真跑 TTS/ffmpeg/Python（320×180 冒烟，约 1 分钟），不属于测试套件。
 *
 * 用法：node scripts/e2e-ticket.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')
const CLI = path.join(PLUGIN, 'tools', 'bili-faship.mjs')

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'faship-e2e-ticket-'))
const DSH = path.join(HOME, '.dsh')
const VIDEO_ROOT = path.join(HOME, 'videos')
fs.mkdirSync(DSH, { recursive: true })
fs.mkdirSync(VIDEO_ROOT, { recursive: true })
const CFG = path.join(DSH, 'bili-faship.config.json')
fs.writeFileSync(CFG, JSON.stringify({
  version: 1,
  video: {
    outDir: VIDEO_ROOT,
    minDurationSec: 8,
    paths: {
      cache: path.join(HOME, 'cache'),
      ffmpeg: process.env.REAL_FFMPEG || process.env.FFMPEG || '',
      stickers: process.env.REAL_STICKERS || '',
    },
    publish: { tags: ['AI', '工单E2E'], titlePrefix: '【E2E】' },
  },
  schedule: { enabled: false },
}, null, 2))
process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.env.DSH_HOME = DSH
process.env.BILI_FASHIP_CONFIG = CFG
process.env.BILI_WHALE_CONFIG = path.join(DSH, 'no-such-whale.json')

const api = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'api.mjs')).href)
const tk = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'tickets.mjs')).href)
const jobsMod = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'jobs.mjs')).href)
const API = api.API_PREFIX

// 复刻 index.js 的接线：任务事件 → 工单（e2e 不走插件 apply 流程）
jobsMod.initJobs()
jobsMod.setJobListener(tk.handleJobEvent)

// 假 sessionController：记录 prompt，不创建真会话（agent 由脚本自己模拟）
const prompts = []
const ctx = {
  get(k) {
    if (k === 'connection') return { requestRejection: () => undefined }
    if (k === 'sessionController') {
      return {
        async create() { return {} },
        async prompt(req, signal) {
          // 宿主契约：prompt(request, signal)；漏传 signal 会 TypeError
          signal.throwIfAborted()
          prompts.push(req)
          return { ok: true }
        },
      }
    }
    return undefined
  },
  tools: {}, webServer: {},
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
    statusCode: 200, headers: {}, chunks: [],
    writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); return this },
    end(chunk) { if (chunk !== undefined) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return this },
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
const out = {}
let failed = false
function check(name, cond, extra = '') {
  out[name] = Boolean(cond)
  console.log(`${cond ? 'OK ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failed = true
}

try {
  // 1) 手动叫醒 → 建 manual 工单 + 派工
  const wake = await call({ method: 'POST', p: '/wake', body: { reason: 'e2e' } })
  check('wake 200 + ticket', wake.status === 200 && Boolean(wake.body?.ticket?.id), JSON.stringify(wake.body).slice(0, 200))
  const ticketId = wake.body?.ticket?.id
  const ticketDir = wake.body?.ticket?.dir
  out.ticketId = ticketId
  check('prompt 已投递且带工单号', prompts.length === 1 && prompts[0].content[0].text.includes(ticketId))
  check('工单目录已建', fs.statSync(ticketDir).isDirectory())

  // 2) 模拟 agent：plan → render（后台任务）→ review → publish dry
  const plan = execFileSync(process.execPath, [CLI, 'plan', '--dir', ticketDir, '--topic', '工单冒烟：把一天过成流水线', '--json'], { encoding: 'utf8' })
  out.plan = JSON.parse(plan.slice(plan.indexOf('{')))
  // 把草稿压到 320×180、缩短一点，保证冒烟快
  const sbPath = path.join(ticketDir, 'storyboard.json')
  const sb = JSON.parse(fs.readFileSync(sbPath, 'utf8'))
  const story = sb.story || sb
  story.width = 320
  story.height = 180
  story.fps = 15
  if (Array.isArray(story.scenes) && story.scenes.length > 6) story.scenes = story.scenes.slice(0, 6)
  fs.writeFileSync(sbPath, JSON.stringify(sb, null, 2))
  check('storyboard 已写', fs.existsSync(sbPath))

  const renderStart = await call({ method: 'POST', p: '/jobs', body: { action: 'render', dir: ticketDir, width: 320, height: 180, fps: 15 } })
  check('render 任务已起', renderStart.body?.job?.status === 'running', JSON.stringify(renderStart.body).slice(0, 160))
  const jobId = renderStart.body?.job?.id
  const t0 = Date.now()
  let job = null
  while (Date.now() - t0 < 300_000) {
    await sleep(2000)
    const r = await call({ p: `/jobs?id=${encodeURIComponent(jobId)}` })
    job = r.body?.job
    if (job && job.status !== 'running') break
  }
  out.render = { status: job?.status, exitCode: job?.exitCode, seconds: Math.round((Date.now() - t0) / 1000), note: job?.note }
  check('render 成功', job?.status === 'done', JSON.stringify(out.render))
  check('成片存在', fs.existsSync(path.join(ticketDir, 'video.mp4')))

  // 工单应该记录 job-started / job-finished（ticketId 关联）
  const tAfterRender = tk.getTicketPublic(ticketId)
  check('任务关联到工单（事件里有 job-finished）', tAfterRender.events.some((e) => e.type === 'job-finished'), JSON.stringify(tAfterRender.events.map((e) => e.type)))

  const review = await call({ method: 'POST', p: '/jobs', body: { action: 'review', dir: ticketDir } })
  check('review 通过', review.body?.result?.pass === true, `score=${review.body?.result?.score}`)
  const dry = await call({ method: 'POST', p: '/jobs', body: { action: 'publish-dry', dir: ticketDir } })
  check('dry 投稿包生成', dry.status === 200 && fs.existsSync(path.join(ticketDir, 'publish.json')))

  // 3) agent 报工单 ready → 应该出现「成片就绪待决定」
  const report = api.reportToTicket({ ticket: ticketId, status: 'ready', note: '成片+自审+dry 包就绪' })
  check('reportToTicket ready', report.ok === true)
  const summary = await call({ p: '/tickets' })
  const pub = summary.body?.tickets?.find((t) => t.id === ticketId)
  out.stage = pub?.stage
  check('工单阶段 person/review', pub?.stage === 'person/review', pub?.stageLabel)
  const att = (summary.body?.attention || []).find((a) => a.ticketId === ticketId)
  check('attention 出现 ready-for-review', att?.kind === 'ready-for-review', JSON.stringify(att || null))
  check('成片可被 /media 读取', (await call({ method: 'HEAD', p: `/media?dir=${encodeURIComponent(ticketDir)}&file=cover.jpg` })).status === 200)

  // 4) ack → attention 消失；stop → 结案
  const ack = await call({ method: 'POST', p: '/tickets', body: { id: ticketId, action: 'ack' } })
  check('ack 200', ack.status === 200 && ack.body?.ok === true)
  const afterAck = await call({ p: '/tickets' })
  check('ack 后 attention 消失', !(afterAck.body?.attention || []).some((a) => a.ticketId === ticketId))
  const stop = await call({ method: 'POST', p: '/tickets', body: { id: ticketId, action: 'stop' } })
  check('stop 结案', stop.status === 200 && stop.body?.ticket?.outcome?.kind === 'stopped')
} catch (e) {
  failed = true
  out.error = String(e?.stack || e)
  console.error('E2E 异常：', e)
} finally {
  console.log('\n证据目录：', HOME)
  fs.writeFileSync(path.join(HOME, 'summary.json'), JSON.stringify({ ok: !failed, ...out }, null, 2))
  console.log('结果：', failed ? 'FAIL' : 'PASS')
  process.exit(failed ? 1 : 0)
}
