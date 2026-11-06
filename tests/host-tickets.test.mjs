/**
 * host-tickets.test.mjs —— v0.2 工单模型单测（DESIGN §10）
 *
 * 覆盖：准入闸门 / 建工单 / 阶段推导 / 结构化报告 / attention（含 601 风控与自审失败）/
 *       ack / stop / 自动重试候选 / 收尾（已发布）/ 重启对账 / 面板汇总。
 * 全部在临时 HOME + DSH_HOME 里跑，不联网、不启动真实会话、不真渲染。
 */
import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'faship-tickets-'))
const DSH = path.join(HOME, '.dsh')
const VIDEO_ROOT = path.join(HOME, 'videos')
fs.mkdirSync(DSH, { recursive: true })
fs.mkdirSync(VIDEO_ROOT, { recursive: true })
const CFG = path.join(DSH, 'bili-faship.config.json')
fs.writeFileSync(CFG, JSON.stringify({ version: 1, video: { outDir: VIDEO_ROOT, cadenceDays: 3, minDurationSec: 8 } }, null, 2))
process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.env.DSH_HOME = DSH
process.env.BILI_FASHIP_CONFIG = CFG
process.env.BILI_WHALE_CONFIG = path.join(DSH, 'no-such-whale.json')
delete process.env.WHALE_VIDEO_CACHE

after(() => fs.rmSync(HOME, { recursive: true, force: true }))

/** 每个用例从干净账本开始（否则前面用例留的 open 工单会挡准入） */
beforeEach(() => {
  for (const f of ['tickets.json', 'jobs.json', 'schedule.json', 'last-report.md']) {
    try { fs.rmSync(path.join(DSH, 'bili-faship', f), { force: true }) } catch { /* 忽略 */ }
  }
  try { fs.rmSync(path.join(VIDEO_ROOT, 'index.json'), { force: true }) } catch { /* 忽略 */ }
  tk.resetTicketsCache()
})

const cfgMod = await import('../lib/config.mjs')
const tk = await import('../lib/tickets.mjs')
const api = await import('../lib/api.mjs')
const jobsMod = await import('../lib/jobs.mjs')
const schedMod = await import('../lib/scheduler.mjs')

const writeCfg = (video = {}) => {
  fs.writeFileSync(CFG, JSON.stringify({ version: 1, video: { outDir: VIDEO_ROOT, cadenceDays: 3, ...video } }, null, 2))
  cfgMod.resetVideoConfig()
  tk.resetTicketsCache()
}
const writeJson = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v, null, 2)) }
const ticketFile = () => path.join(DSH, 'bili-faship', 'tickets.json')
const readState = () => JSON.parse(fs.readFileSync(ticketFile(), 'utf8'))

/** 假 sessionController：记录 prompt，不创建真会话 */
function fakeCtx() {
  const prompts = []
  const controller = {
    async create() { return { sessionId: 'x' } },
    async prompt(req) { prompts.push(req); return { ok: true } },
  }
  return {
    prompts,
    get(k) { return k === 'sessionController' ? controller : undefined },
    tools: {}, webServer: {},
  }
}

// ---------------------------------------------------------------------------
// 准入
// ---------------------------------------------------------------------------

test('admission: 总开关 / 生物钟 / 到期 / 窗口 的拒绝原因', () => {
  writeCfg({});
  // 没有任何 index → 到期、默认窗口 21:00-23:30
  tk.recordAdmission({ kind: 'schedule', decision: 'reject', reason: 'not-due', checks: {} })
  writeCfg({ enabled: false })
  assert.equal(tk.admit({ kind: 'schedule' }).reason, 'disabled')

  writeCfg({ schedule: { enabled: false } })
  assert.equal(tk.admit({ kind: 'schedule' }).reason, 'schedule-off')

  writeCfg({})
  const atNoon = new Date(2026, 10, 7, 12, 0)
  const r1 = tk.admit({ kind: 'schedule', now: atNoon })
  assert.equal(r1.reason, 'out-of-window', '没到窗口')

  // 刚发过 → not-due
  writeJson(path.join(VIDEO_ROOT, 'index.json'), { version: 1, videos: [], lastPublishedAt: new Date().toISOString() })
  const r2 = tk.admit({ kind: 'schedule', now: new Date(2026, 10, 7, 22, 0) })
  assert.equal(r2.reason, 'not-due')
  fs.rmSync(path.join(VIDEO_ROOT, 'index.json'), { force: true })
})

test('admission: 手动触发不看窗口，但看开关 / 每日额度 / 工单串行', () => {
  writeCfg({ tickets: { maxPerDay: 1 } })
  let r = tk.admit({ kind: 'manual' })
  assert.equal(r.ok, true)

  const t = tk.createTicket({ kind: 'schedule', reason: '到期' })
  // 刚建的工单没有 sessionId → 阶段是 working/queued → 拦住
  r = tk.admit({ kind: 'manual' })
  assert.equal(r.reason, 'ticket-working')

  // 把它结案后，额度（maxPerDay=1）挡住了
  tk.stopTicket(t.id, '测试')
  r = tk.admit({ kind: 'manual' })
  assert.equal(r.reason, 'daily-limit')
  writeCfg({})
  tk.resetTicketsCache()
})

test('admission: 索引损坏时拒绝（不自动乱发）', () => {
  writeCfg({})
  fs.writeFileSync(path.join(VIDEO_ROOT, 'index.json'), '{broken')
  const r = tk.admit({ kind: 'schedule', now: new Date(2026, 10, 7, 22, 0) })
  assert.equal(r.reason, 'index-corrupt')
  fs.rmSync(path.join(VIDEO_ROOT, 'index.json'), { force: true })
})

// ---------------------------------------------------------------------------
// 建工单 / 报告 / 阶段
// ---------------------------------------------------------------------------

test('ticket: createTicket 建目录、落盘、事件、今日计数', () => {
  writeCfg({})
  tk.resetTicketsCache()
  try { fs.rmSync(ticketFile(), { force: true }) } catch { /* 忽略 */ }
  const before = tk.countToday()
  const t = tk.createTicket({ kind: 'schedule', reason: '到期' })
  assert.match(t.id, /^tk-\d{8}-\d{4}-[0-9a-f]{4}$/)
  assert.ok(fs.statSync(t.dir).isDirectory())
  assert.equal(path.dirname(t.dir), path.resolve(VIDEO_ROOT))
  assert.equal(t.mandate.policyVersion, '0.2.0')
  assert.equal(t.trigger.basis, 'inferred')
  assert.ok(t.events.some((e) => e.type === 'admitted'))
  assert.equal(tk.countToday(), before + 1)
  const st = readState()
  assert.ok(st.tickets.some((x) => x.id === t.id))
  const pub = tk.getTicketPublic(t.id)
  assert.equal(pub.stage, 'working/queued')
  assert.equal(pub.stageLabel, '排队中')
})

test('ticket: dispatch 记录 session/attempts；报告 ready 进「等你审阅」', async () => {
  writeCfg({})
  const t = tk.createTicket({ kind: 'manual', reason: '测试' })
  const ctx = fakeCtx()
  const r = await tk.dispatchTicket(t.id, ctx, { status: tk.statusLite(), markSchedule: false })
  assert.equal(r.ok, true)
  assert.equal(ctx.prompts.length, 1)
  assert.match(ctx.prompts[0].content[0].text, new RegExp(t.id))
  assert.match(ctx.prompts[0].content[0].text, /faship_report/)
  assert.match(ctx.prompts[0].content[0].text, /插件目录（文档都在这里）/)
  const pub1 = tk.getTicketPublic(t.id)
  assert.equal(pub1.attempts, 1)
  assert.equal(pub1.sessionId, r.sessionId)
  assert.equal(pub1.stage, 'working/running')

  let rep = tk.recordReport({ ticketId: t.id, status: 'ready', note: '做好了' })
  assert.equal(rep.ok, true)
  const pub2 = tk.getTicketPublic(t.id)
  assert.equal(pub2.stage, 'person/review')
  assert.equal(pub2.stageLabel, '等你审阅 / 决定发布')
  assert.equal(pub2.report.status, 'ready')
  assert.ok(pub2.events.some((e) => e.type === 'report'))
})

test('ticket: 非法报告状态被拒；dropped 直接结案', async () => {
  writeCfg({})
  const t = tk.createTicket({ kind: 'manual', reason: '测试' })
  const bad = tk.recordReport({ ticketId: t.id, status: 'finished', note: '' })
  assert.equal(bad.ok, false)
  const ok = tk.recordReport({ ticketId: t.id, status: 'dropped', note: '今天不想做' })
  assert.equal(ok.ok, true)
  const pub = tk.getTicketPublic(t.id)
  assert.equal(pub.endedAt !== null, true)
  assert.equal(pub.outcome.kind, 'dropped')
  assert.equal(pub.stage, 'done/dropped')
})

test('ticket: 证据推导 attention —— 自审没过 / 成片就绪 / ack 后不再出现', async () => {
  writeCfg({})
  const t = tk.createTicket({ kind: 'manual', reason: '测试' })
  writeJson(path.join(t.dir, 'storyboard.json'), { version: 4, slug: 'demo', title: '示例片' })
  writeJson(path.join(t.dir, 'review.json'), { pass: false, score: 60, reviewedAt: new Date().toISOString() })
  tk.recordReport({ ticketId: t.id, status: 'waiting', note: '等下一次' })
  let att = tk.listAttention()
  const fail = att.find((a) => a.ticketId === t.id && a.kind === 'review-failed')
  assert.ok(fail, '自审未过应出现在待你处理')
  assert.deepEqual(fail.actions, ['retry', 'ack'])
  assert.equal(tk.getTicketPublic(t.id).stage, 'person/failed')

  // 改成自审通过 + 有成片 → ready-for-review
  writeJson(path.join(t.dir, 'review.json'), { pass: true, score: 100, reviewedAt: new Date().toISOString() })
  fs.writeFileSync(path.join(t.dir, 'video.mp4'), 'x')
  tk.resetTicketsCache()
  att = tk.listAttention()
  const ready = att.find((a) => a.ticketId === t.id && a.kind === 'ready-for-review')
  assert.ok(ready, '成片就绪应出现在待你处理')
  assert.equal(tk.getTicketPublic(t.id).stage, 'person/review')

  // ack 之后不再出现（证据不变则一直压住）
  const ack = tk.ackTicket(t.id)
  assert.equal(ack.ok, true)
  tk.resetTicketsCache()
  att = tk.listAttention()
  assert.equal(att.filter((a) => a.ticketId === t.id).length, 0)
})

test('ticket: 报告 ready + 产物就绪时，ack 要同时压住两种表示（不会又冒出来）', async () => {
  writeCfg({})
  const t = tk.createTicket({ kind: 'manual', reason: 'ready+artifacts' })
  writeJson(path.join(t.dir, 'storyboard.json'), { version: 4, slug: 'both-ready', title: '双证据' })
  writeJson(path.join(t.dir, 'review.json'), { pass: true, score: 100, reviewedAt: new Date().toISOString() })
  writeJson(path.join(t.dir, 'publish.json'), { dryRun: true, title: '双证据' })
  fs.writeFileSync(path.join(t.dir, 'video.mp4'), 'x')
  tk.recordReport({ ticketId: t.id, status: 'ready', note: '都好了' })
  let att = tk.listAttention().filter((a) => a.ticketId === t.id)
  assert.ok(att.some((a) => a.kind === 'ready-for-review'))
  const ack = tk.ackTicket(t.id)
  assert.equal(ack.ok, true)
  tk.resetTicketsCache()
  att = tk.listAttention().filter((a) => a.ticketId === t.id)
  assert.equal(att.length, 0, JSON.stringify(att))
})

// ---------------------------------------------------------------------------
// 任务事件 → attention
// ---------------------------------------------------------------------------

test('jobs→tickets: 渲染失败 / 601 风控 会变成 attention，且风控不可自动重试', async () => {
  writeCfg({})
  const t1 = tk.createTicket({ kind: 'manual', reason: '渲染失败' })
  tk.handleJobEvent('finished', {
    id: 'job-x1', action: 'render', dir: t1.dir, ticketId: t1.id, status: 'failed', note: 'exit=1',
  })
  const att1 = tk.listAttention().filter((a) => a.ticketId === t1.id)
  assert.ok(att1.some((a) => a.kind === 'render-failed'), JSON.stringify(att1))

  const t2 = tk.createTicket({ kind: 'manual', reason: '风控' })
  tk.handleJobEvent('finished', {
    id: 'job-x2', action: 'publish-go', dir: t2.dir, ticketId: t2.id, status: 'failed',
    note: '预上传被拒：code=601 v_voucher required',
  })
  const att2 = tk.listAttention().filter((a) => a.ticketId === t2.id)
  const rl = att2.find((a) => a.kind === 'rate-limited')
  assert.ok(rl, JSON.stringify(att2))
  assert.match(rl.detail, /601/)
  assert.deepEqual(rl.actions, ['ack', 'stop'])
  // 风控工单不应出现在自动重试候选里
  const retry = tk.retryableTickets().map((x) => x.ticket.id)
  assert.equal(retry.includes(t2.id), false)
})

test('detectRateLimit：601/412/429 命中，普通错误不误判', () => {
  assert.equal(tk.detectRateLimit('{"code":601,"message":"too fast"}'), '601')
  assert.equal(tk.detectRateLimit('提交失败 code=412'), '412')
  assert.equal(tk.detectRateLimit('429 too many requests'), '429')
  assert.equal(tk.detectRateLimit('ffmpeg exited 1: no such file'), null)
})

// ---------------------------------------------------------------------------
// 重试 / 停止 / 收尾 / 对账
// ---------------------------------------------------------------------------

test('ticket: 自动重试候选与 attempt 上限', async () => {
  writeCfg({ worker: { autoRetry: { enabled: true, maxAttempts: 1, backoffMinutes: 1 } } })
  tk.resetTicketsCache()
  const t = tk.createTicket({ kind: 'manual', reason: '重试' })
  tk.addAttention(t.id, { kind: 'render-failed', detail: '崩了' })
  // 退避 1 分钟：把时钟往后拨 2 分钟再看候选
  const later = new Date(Date.now() + 2 * 60_000)
  let retry = tk.retryableTickets({ now: later })
  assert.ok(retry.some((x) => x.ticket.id === t.id))

  // 派工成功 → attention 被清、attempts=1；达到 maxAttempts 后不再是候选
  const ctx = fakeCtx()
  await tk.dispatchTicket(t.id, ctx, { markSchedule: false })
  tk.handleJobEvent('finished', { id: 'j2', action: 'render', dir: t.dir, ticketId: t.id, status: 'failed', note: 'again' })
  retry = tk.retryableTickets({ now: new Date(Date.now() + 4 * 60_000) })
  assert.equal(retry.some((x) => x.ticket.id === t.id), false, 'attempts 用尽后不再自动重试')
  writeCfg({})
})

test('ticket: stop 结案；sweep 把「index 已发布」的工单结案', () => {
  writeCfg({})
  const t = tk.createTicket({ kind: 'manual', reason: 'stop' })
  const r = tk.stopTicket(t.id)
  assert.equal(r.ok, true)
  assert.equal(tk.getTicketPublic(t.id).outcome.kind, 'stopped')

  const t2 = tk.createTicket({ kind: 'manual', reason: 'publish' })
  writeJson(path.join(t2.dir, 'storyboard.json'), { version: 4, slug: 'pub-demo', title: '要发布' })
  writeJson(path.join(VIDEO_ROOT, 'index.json'), { version: 1, videos: [{ slug: 'pub-demo', bvid: 'BV1xx', publishedAt: new Date().toISOString() }], lastPublishedAt: new Date().toISOString() })
  tk.sweepTickets()
  const pub = tk.getTicketPublic(t2.id)
  assert.equal(pub.outcome.kind, 'published')
  assert.equal(pub.stage, 'done/published')
  fs.rmSync(path.join(VIDEO_ROOT, 'index.json'), { force: true })
})

test('ticket: reconcile 把「重启前在做」的开放工单标成 host-restarted', async () => {
  writeCfg({})
  const t = tk.createTicket({ kind: 'manual', reason: '重启' })
  const ctx = fakeCtx()
  await tk.dispatchTicket(t.id, ctx, { markSchedule: false })
  const changed = tk.reconcileTickets({ graceMinutes: -1 })
  assert.ok(changed.includes(t.id), JSON.stringify(changed))
  const att = tk.listAttention().filter((a) => a.ticketId === t.id)
  assert.ok(att.some((a) => a.kind === 'host-restarted'))
})

// ---------------------------------------------------------------------------
// 手动叫醒（api.wakeNow）与汇总
// ---------------------------------------------------------------------------

test('api: wakeNow 建 manual 工单并派工；汇总包含 attention/admission', async () => {
  writeCfg({})
  tk.resetTicketsCache()
  const ctx = fakeCtx()
  const r = await api.wakeNow(ctx, { manual: true, reason: '测试手动' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.ok(r.ticket?.id)
  assert.equal(ctx.prompts.length, 1)
  const summary = tk.ticketsSummary()
  assert.ok(summary.tickets.some((x) => x.id === r.ticket.id))
  assert.equal(summary.admission.last.decision, 'accept')
  assert.equal(typeof summary.attention.length, 'number')
})

test('api: wakeNow 在没有 sessionController 时 503，且不建工单', async () => {
  writeCfg({})
  tk.resetTicketsCache()
  const before = tk.listTickets().length
  const r = await api.wakeNow({ get: () => undefined }, { manual: true })
  assert.equal(r.ok, false)
  assert.equal(r.status, 503)
  assert.equal(r.reason, 'no-session-controller')
  assert.equal(tk.listTickets().length, before)
})

test('api: ticketAction ack / stop / retry 的闸门', async () => {
  writeCfg({})
  const t = tk.createTicket({ kind: 'manual', reason: 'actions' })
  tk.addAttention(t.id, { kind: 'job-failed', detail: 'x' })
  let r = await api.ticketAction(fakeCtx(), { id: t.id, action: 'ack' })
  assert.equal(r.ok, true)
  r = await api.ticketAction(fakeCtx(), { id: 'tk-nope', action: 'ack' })
  assert.equal(r.status, 404)
  r = await api.ticketAction(fakeCtx(), { id: t.id, action: 'boom' })
  assert.equal(r.status, 400)
  r = await api.ticketAction(fakeCtx(), { id: t.id, action: 'retry' })
  assert.equal(r.ok, true, JSON.stringify(r))
  r = await api.ticketAction(fakeCtx(), { id: t.id, action: 'stop' })
  assert.equal(r.ok, true)
  assert.equal(tk.getTicketPublic(t.id).outcome.kind, 'stopped')
})

// ---------------------------------------------------------------------------
// Router（scheduler）与看门狗
// ---------------------------------------------------------------------------

test('scheduler: 到期 + 窗口内 → 建 1 个工单并派工；下一 tick 不重复', async () => {
  writeCfg({ tickets: { maxPerDay: 2 }, schedule: { enabled: true, window: { start: '00:00', end: '23:59' }, minGapMinutes: 1, cooldownHours: 30 } })
  tk.resetTicketsCache()
  const ctx = fakeCtx()
  const sch = schedMod.startScheduler(ctx, { tickMs: 3_600_000 })
  try {
    await sch.tickNow()
    let tickets = tk.listTickets()
    assert.equal(tickets.length, 1, '应该只建一个工单')
    assert.equal(ctx.prompts.length, 1)
    assert.equal(tickets[0].trigger.kind, 'schedule')
    // 第二个 tick：工单还在 working/queued → 不重复建
    await sch.tickNow()
    tickets = tk.listTickets()
    assert.equal(tickets.length, 1, '不能在同一轮重复建工单')
    assert.equal(ctx.prompts.length, 1)
    // 准入记录里应有一次 accept
    const adm = tk.admissionSummary()
    assert.ok(adm.recent.some((x) => x.decision === 'accept'))
  } finally {
    sch.stop()
  }
})

test('scheduler: 观察模式工单 mandate.observeOnly=true', async () => {
  writeCfg({ admission: { observeOnly: true }, schedule: { enabled: true, window: { start: '00:00', end: '23:59' } } })
  tk.resetTicketsCache()
  const ctx = fakeCtx()
  const sch = schedMod.startScheduler(ctx, { tickMs: 3_600_000 })
  try {
    await sch.tickNow()
    const t = tk.listTickets()[0]
    assert.ok(t, '应该建工单')
    assert.equal(t.mandate.observeOnly, true)
    assert.match(ctx.prompts[0].content[0].text, /观察模式/)
  } finally {
    sch.stop()
  }
})

test('watchdog: 没有任务时扫描为空；结束一个不存在的任务会报错（不崩）', () => {
  assert.deepEqual(jobsMod.watchdogScan({}), [])
  const r = jobsMod.terminateJob('job-nope', '测试')
  assert.equal(r.ok, false)
  assert.match(r.error, /不在运行/)
})
