/**
 * host-dispatch-contract.test.mjs —— 与**真实 DSH 宿主契约**对齐的回归测试（v0.2.0 真实事故）
 *
 * 为什么单独一个文件：v0.2.0 的 161 个单测全绿，但插件在真实宿主里**从来没叫醒过她**——
 * 因为所有测试的假 sessionController 都写成 `prompt(req)`（忽略第二个参数），
 * 而宿主的实现是 `prompt(request, signal)`，第一行就是 `signal.throwIfAborted()`。
 * 漏传 signal → TypeError "Cannot read properties of undefined (reading 'throwIfAborted')"。
 *
 * 这里用「宿主形状」的假 controller（必须收到 AbortSignal，否则直接按宿主的方式炸），
 * 再加上对派工失败计数 / 准入死锁 / ack 后阶段 的回归断言。
 * 参考实现：app.asar 里 `dsh-api-session-controller/lib/index.js` 的 SessionController.prompt。
 */
import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'faship-contract-'))
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

const cfgMod = await import('../lib/config.mjs')
const tk = await import('../lib/tickets.mjs')
const schedMod = await import('../lib/scheduler.mjs')

const ticketFile = () => path.join(DSH, 'bili-faship', 'tickets.json')
const scheduleFile = () => path.join(DSH, 'bili-faship', 'schedule.json')
const readState = () => JSON.parse(fs.readFileSync(ticketFile(), 'utf8'))
const writeState = (v) => { fs.mkdirSync(path.dirname(ticketFile()), { recursive: true }); fs.writeFileSync(ticketFile(), JSON.stringify(v, null, 2)) }
const patchTicket = (fn) => {
  const st = readState()
  for (const t of st.tickets) fn(t)
  writeState(st)
  tk.resetTicketsCache()
}

/** 与宿主同形状的 sessionController：prompt(request, signal)，signal 缺失就按宿主方式炸 */
function hostCtx({ fail = false, createFail = false } = {}) {
  const prompts = []
  const controller = {
    async create({ sessionId } = {}) {
      if (createFail) throw new Error('create boom')
      return { sessionId }
    },
    async prompt(request, signal) {
      // 宿主实现第一行（不是可选项）：漏传 signal 时，真实宿主抛的就是下面这个 TypeError
      signal.throwIfAborted()
      prompts.push({ request, signal })
      if (fail) throw new Error('prompt boom')
      return { accepted: true }
    },
  }
  return {
    prompts,
    get(k) { return k === 'sessionController' ? controller : undefined },
    tools: {}, webServer: {},
  }
}

const writeCfg = (video = {}) => {
  fs.writeFileSync(CFG, JSON.stringify({ version: 1, video: { outDir: VIDEO_ROOT, cadenceDays: 3, minDurationSec: 8, ...video } }, null, 2))
  cfgMod.resetVideoConfig()
  tk.resetTicketsCache()
}

const ALL_DAY = { enabled: true, window: { start: '00:00', end: '23:59' }, cooldownHours: 1 }

beforeEach(() => {
  for (const f of ['tickets.json', 'jobs.json', 'schedule.json', 'last-report.md']) {
    try { fs.rmSync(path.join(DSH, 'bili-faship', f), { force: true }) } catch { /* 忽略 */ }
  }
  try { fs.rmSync(path.join(VIDEO_ROOT, 'index.json'), { force: true }) } catch { /* 忽略 */ }
  writeCfg({})
})

// ---------------------------------------------------------------------------
// 1. 派工必须按宿主契约传 AbortSignal
// ---------------------------------------------------------------------------

test('dispatch: 必须给 host prompt 传 AbortSignal（漏传 = 真实宿主的 TypeError）', async () => {
  const t = tk.createTicket({ kind: 'manual', reason: '契约' })
  const ctx = hostCtx()
  const r = await tk.dispatchTicket(t.id, ctx, { status: tk.statusLite(), markSchedule: false })
  assert.equal(r.ok, true, `派工应成功，实际：${r.error || r.reason}`)
  assert.equal(ctx.prompts.length, 1)
  assert.ok(ctx.prompts[0].signal instanceof AbortSignal, '第二个参数必须是 AbortSignal')
  assert.equal(ctx.prompts[0].signal.aborted, false)
  const saved = readState().tickets[0]
  assert.equal(saved.attempts, 1)
  assert.match(String(saved.sessionId), /^bili-faship-/)
})

test('dispatch: create 失败不阻断投递（会话可能已存在）', async () => {
  const t = tk.createTicket({ kind: 'manual', reason: '契约' })
  const ctx = hostCtx({ createFail: true })
  const r = await tk.dispatchTicket(t.id, ctx, { status: tk.statusLite(), markSchedule: false })
  assert.equal(r.ok, true)
  assert.equal(ctx.prompts.length, 1)
})

// ---------------------------------------------------------------------------
// 2. 投递失败：计尝试次数 + delivery-failed，自动重试有上限
// ---------------------------------------------------------------------------

test('dispatch 失败：写 delivery-failed、attempts++，自动重试候选有上限', async () => {
  writeCfg({ worker: { autoRetry: { enabled: true, maxAttempts: 2, backoffMinutes: 1 } } })
  const t = tk.createTicket({ kind: 'manual', reason: '契约' })
  const ctx = hostCtx({ fail: true })

  const r1 = await tk.dispatchTicket(t.id, ctx, { status: tk.statusLite(), markSchedule: false })
  assert.equal(r1.ok, false)
  let saved = readState().tickets[0]
  assert.equal(saved.attempts, 1, '失败的派工也要计一次，否则自动重试没有上限')
  assert.ok(saved.attention.some((a) => a.kind === 'delivery-failed'))

  // 把 lastAttemptAt 拨到退避之前，模拟「10 分钟后再重试」
  patchTicket((x) => { x.lastAttemptAt = new Date(Date.now() - 10 * 60_000).toISOString() })
  assert.equal(tk.retryableTickets().length, 1, 'attempts 未用尽时应在候选里')
  const r2 = await tk.dispatchTicket(t.id, ctx, { status: tk.statusLite(), markSchedule: false })
  assert.equal(r2.ok, false)
  saved = readState().tickets[0]
  assert.equal(saved.attempts, 2)
  // 用尽 maxAttempts 后，自动重试候选必须为空（不能每 10 分钟永远重试）
  patchTicket((x) => { x.lastAttemptAt = new Date(Date.now() - 10 * 60_000).toISOString() })
  assert.equal(tk.retryableTickets().length, 0)
})

// ---------------------------------------------------------------------------
// 3. 准入：落盘 attention 参与阶段推导（v0.2.0 死锁回归）
// ---------------------------------------------------------------------------

test('admit: 落盘的 delivery-failed 不能把工单误判成 working/queued（旧代码：ticket-working 死锁）', () => {
  writeCfg({ schedule: ALL_DAY, tickets: { maxPerDay: 5 } })
  const t = tk.createTicket({ kind: 'schedule', reason: '到期' })
  tk.addAttention(t.id, { kind: 'delivery-failed', detail: '模拟投递失败', actions: ['retry', 'ack'] })

  const pub = tk.getTicketPublic(t.id)
  assert.equal(pub.stage, 'person/delivery')

  const r = tk.admit({ kind: 'schedule', now: new Date() })
  assert.notEqual(r.reason, 'ticket-working', '旧代码在这里把 delivery-failed 误判成 working/queued')
  assert.equal(r.reason, 'delivery-blocked', '应当明确告诉用户：先处理这条投递失败的工单')
  assert.equal(r.checks.deliveryBlocked, true)
})

test('admit: 投递失败的工单被 ack 之后，不能永久占住准入（阶段落 idle）', () => {
  writeCfg({ schedule: ALL_DAY, tickets: { maxPerDay: 5 } })
  const t = tk.createTicket({ kind: 'schedule', reason: '到期' })
  tk.addAttention(t.id, { kind: 'delivery-failed', detail: '模拟投递失败', actions: ['retry', 'ack'] })
  // 把创建时间拨到 20 分钟前：模拟「派工失败很久了，用户点了我知道了」
  patchTicket((x) => { x.createdAt = new Date(Date.now() - 20 * 60_000).toISOString(); x.updatedAt = x.createdAt })

  const acked = tk.ackTicket(t.id)
  assert.equal(acked.ok, true)
  const pub = tk.getTicketPublic(t.id)
  assert.equal(pub.stage, 'idle', 'ack 之后应落 idle，而不是永远显示"排队中/制作中"')

  const r = tk.admit({ kind: 'schedule', now: new Date() })
  assert.equal(r.ok, true, `ack 后应允许下一次准入，实际：${r.reason}`)
})

test('stage: 刚建的工单仍是 working/queued（别把正常排队误判 idle）', () => {
  writeCfg({})
  const t = tk.createTicket({ kind: 'manual', reason: '契约' })
  assert.equal(tk.getTicketPublic(t.id).stage, 'working/queued')
})

// ---------------------------------------------------------------------------
// 4. 调度器 tick 端到端：用宿主形状的 controller 真跑一遍
// ---------------------------------------------------------------------------

test('scheduler tick: 到期 → 建工单 → 用宿主契约派工 → 报告 ready 进「待你审阅」', async () => {
  writeCfg({ schedule: ALL_DAY, tickets: { maxPerDay: 5 } })
  const ctx = hostCtx()
  const sched = schedMod.startScheduler(ctx, { tickMs: 3600_000 })
  try {
    await sched.tickNow()
  } finally {
    sched.stop()
  }

  assert.equal(ctx.prompts.length, 1, '生物钟应当叫醒一次')
  assert.ok(ctx.prompts[0].signal instanceof AbortSignal)
  assert.match(ctx.prompts[0].request.content[0].text, /工单 tk-/)

  const st = readState()
  assert.equal(st.tickets.length, 1)
  assert.equal(st.tickets[0].attempts, 1)
  assert.equal(st.tickets[0].sessionId.startsWith('bili-faship-'), true)
  assert.ok(fs.existsSync(scheduleFile()), '派工成功应写 schedule.json 的 lastWakeAt')
  assert.equal(tk.getTicketPublic(st.tickets[0].id).stage, 'working/running')

  const rep = tk.recordReport({ ticketId: st.tickets[0].id, status: 'ready', note: '成片+自审+dry 包就绪' })
  assert.equal(rep.ok, true)
  const pub = tk.getTicketPublic(st.tickets[0].id)
  assert.equal(pub.stage, 'person/review')
  assert.ok(tk.ticketsSummary().attention.some((a) => a.kind === 'ready-for-review'))
})

test('scheduler: 投递一直失败时不再堆新工单（delivery-blocked 兜底）', async () => {
  writeCfg({
    schedule: ALL_DAY,
    tickets: { maxPerDay: 3 },
    worker: { autoRetry: { enabled: true, maxAttempts: 2, backoffMinutes: 1 } },
  })
  const ctx = hostCtx({ fail: true })
  const sched = schedMod.startScheduler(ctx, { tickMs: 3600_000 })
  try {
    await sched.tickNow() // 建第一个工单 + 第一次派工失败
    assert.equal(readState().tickets.length, 1)
    assert.equal(readState().tickets[0].attempts, 1)

    patchTicket((x) => { x.lastAttemptAt = new Date(Date.now() - 10 * 60_000).toISOString() })
    await sched.tickNow() // 自动重试第二次，失败；准入应被 delivery-blocked 挡住
    const st2 = readState()
    assert.equal(st2.tickets.length, 1, '投递失败时不应再建新工单')
    assert.equal(st2.tickets[0].attempts, 2)
    assert.equal(st2.admission[st2.admission.length - 1].reason, 'delivery-blocked')
  } finally {
    sched.stop()
  }
})
