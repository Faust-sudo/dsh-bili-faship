/**
 * lib/tickets.mjs —— v0.2 工单（Ticket）/ 准入（Admission）/ 报告（Report）/ 待你处理（Attention）
 * ============================================================================
 * 借鉴 DeepSeek 官方 Super-agent 原型（dsh-superagent-prototype，MIT）的领域模型，
 * 按本插件规模压扁（DESIGN §10）：
 *
 *   Trigger（时钟/手动） → Admission（确定性闸门，不花 token） → Ticket（工单）
 *     → Assignment（派工：叫醒一个 Worker 会话） → Report（faship_report）
 *     → Panel（设置页「待你处理」）
 *
 * 三条硬规则（都是 super-agent 教的）：
 *   1. **诚实状态**：阶段优先由证据推导（目录里的产物 / 任务状态 / 任务日志 / index.json），
 *      不靠自由文本猜；报告只是输入之一。
 *   2. **安静**：没有需要人处理的事，面板就不占地方；准入只在有意义时记录（accept / 到期被拒 / 手动）。
 *   3. **可恢复**：宿主重启/任务卡死 → 工单标 attention（host-restarted / stalled），下次派工带恢复说明；
 *      自动重试有上限、有退避；平台风控（601/412/429）**永不自动重试**。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { mergedConfig, videoRoot } from './config.mjs'
import { ticketsFile, reportFile, workDir } from './dirs.mjs'
import { activeJob, listJobs, getJob, terminateJob } from './jobs.mjs'
import { buildTicketPrompt } from './prompt.mjs'
import { readScheduleState, writeScheduleState, inWakeWindow } from './status.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const POLICY_VERSION = '0.2.0'
const MAX_TICKETS = 50
const MAX_ADMISSION = 50
const RETRYABLE = new Set(['job-failed', 'render-failed', 'publish-failed', 'stalled', 'host-restarted', 'delivery-failed'])

/** 阶段中文标签（面板只显示这个，不显示内部 code） */
export const STAGE_LABELS = {
  'person/delivery': '待你处理（投递失败）',
  'person/blocked': '受阻，等你',
  'person/failed': '失败，等你',
  'person/review': '等你审阅 / 决定发布',
  'working/queued': '排队中',
  'working/running': '制作中',
  'idle': '等下一次触发',
  'done/published': '已发布',
  'done/dropped': '无需处理',
  'done/stopped': '已停止',
  'done/failed': '已失败',
}

function log(...args) {
  try { console.log('[bili-faship tickets]', ...args) } catch { /* 忽略 */ }
}

const iso = (d = new Date()) => d.toISOString()
const pad = (n) => String(n).padStart(2, '0')
const stampOf = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

/* ───────────────────────── 持久化 ───────────────────────── */

let cache = null

function emptyState() {
  return { version: 1, policyVersion: POLICY_VERSION, tickets: [], admission: [] }
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(ticketsFile(), 'utf8'))
    if (!isObj(raw) || !Array.isArray(raw.tickets)) return emptyState()
    return {
      version: 1,
      policyVersion: typeof raw.policyVersion === 'string' ? raw.policyVersion : POLICY_VERSION,
      tickets: raw.tickets.filter((t) => isObj(t) && typeof t.id === 'string').slice(-MAX_TICKETS),
      admission: Array.isArray(raw.admission) ? raw.admission.slice(-MAX_ADMISSION) : [],
    }
  } catch {
    return emptyState()
  }
}

export function readState() {
  if (!cache) cache = loadState()
  return cache
}

function saveState() {
  if (!cache) return
  try {
    const payload = {
      version: 1,
      policyVersion: POLICY_VERSION,
      updatedAt: iso(),
      tickets: cache.tickets.slice(-MAX_TICKETS),
      admission: cache.admission.slice(-MAX_ADMISSION),
    }
    fs.mkdirSync(path.dirname(ticketsFile()), { recursive: true })
    const tmp = `${ticketsFile()}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`)
    fs.renameSync(tmp, ticketsFile())
  } catch (e) { log('写 tickets.json 失败：' + (e?.message ?? e)) }
}

/** 测试用：丢掉内存缓存、从磁盘重读 */
export function resetTicketsCache() { cache = null }

function findRaw(id) {
  const st = readState()
  return st.tickets.find((t) => t.id === id) || null
}

function findRawByDir(dir) {
  if (!dir) return null
  const abs = path.resolve(dir)
  const st = readState()
  return st.tickets
    .filter((t) => !t.endedAt && t.dir && path.resolve(t.dir) === abs)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null
}

function touch(t, type, detail = '') {
  t.updatedAt = iso()
  t.events = Array.isArray(t.events) ? t.events : []
  t.events.push({ at: t.updatedAt, type, detail: String(detail).slice(0, 500) })
  if (t.events.length > 60) t.events = t.events.slice(-60)
}

/* ───────────────────────── 证据（产物 / 索引 / 任务） ───────────────────────── */

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

function readIndex(root) {
  const raw = readJson(path.join(root || videoRoot(), 'index.json'))
  return {
    ok: Boolean(raw && Array.isArray(raw.videos)),
    videos: Array.isArray(raw?.videos) ? raw.videos : [],
    lastPublishedAt: raw?.lastPublishedAt ?? null,
  }
}

function readArtifacts(t) {
  const dir = t.dir
  const read = (f) => readJson(path.join(dir, f))
  let storyRaw = read('storyboard.json')
  const story = storyRaw && isObj(storyRaw.story) ? storyRaw.story : storyRaw
  const review = read('review.json')
  const publish = read('publish.json')
  const meta = read('meta.json')
  const slug = String(story?.slug || path.basename(dir || ''))
  const mtime = (f) => { try { return fs.statSync(path.join(dir, f)).mtimeMs } catch { return 0 } }
  return {
    dir, story, meta, review, publish, slug,
    hasVideo: (() => { try { return fs.statSync(path.join(dir, 'video.mp4')).isFile() } catch { return false } })(),
    reviewMtime: mtime('review.json'),
    publishMtime: mtime('publish.json'),
    videoMtime: mtime('video.mp4'),
  }
}

function isPublished(t, art, index) {
  if (art.publish && art.publish.bvid) return true
  return index.videos.some((v) => v && typeof v.slug === 'string' && v.slug === art.slug && v.bvid)
}

/** 本工单相关的运行中任务 */
function jobsForTicket(t, jobs) {
  const abs = t.dir ? path.resolve(t.dir) : null
  return jobs.filter((j) => j.status === 'running' && (j.ticketId === t.id || (abs && j.dir && path.resolve(j.dir) === abs)))
}

/* ───────────────────────── 时间 / due（准入用；不依赖 scheduler，避免循环） ───────────────────────── */

export function dueNow(cfg, now = new Date()) {
  const root = videoRoot()
  const file = path.join(root, 'index.json')
  const exists = fs.existsSync(file)
  const index = readJson(file)
  const cadenceDays = Number(cfg?.cadenceDays ?? 3)
  if (!index) {
    if (exists) return { due: false, reason: 'index-corrupt', lastPublishedAt: null, nextDueAt: null, cadenceDays }
    return { due: true, reason: 'never-published', lastPublishedAt: null, nextDueAt: null, cadenceDays }
  }
  const lastAt = index?.lastPublishedAt
    || (Array.isArray(index?.videos) && index.videos.length
      ? index.videos.map((v) => v?.publishedAt).filter(Boolean).sort().pop()
      : null)
  if (!lastAt) return { due: true, reason: 'never-published', lastPublishedAt: null, nextDueAt: null, cadenceDays }
  const lastMs = Date.parse(String(lastAt))
  if (Number.isNaN(lastMs)) return { due: false, reason: 'index-bad-time', lastPublishedAt: lastAt, nextDueAt: null, cadenceDays }
  const nextMs = lastMs + cadenceDays * 86400_000
  return {
    due: now.getTime() >= nextMs,
    reason: now.getTime() >= nextMs ? 'due' : 'not-due',
    lastPublishedAt: new Date(lastMs).toISOString(),
    nextDueAt: new Date(nextMs).toISOString(),
    cadenceDays,
  }
}

function cooldownLeftMs(cfg, now = new Date()) {
  const st = readScheduleState()
  const lastMs = st.lastWakeAt ? Date.parse(st.lastWakeAt) : NaN
  if (!Number.isFinite(lastMs)) return 0
  const cd = Math.max(1, Number(cfg.schedule?.cooldownHours ?? 30)) * 3600_000
  return Math.max(0, lastMs + cd - now.getTime())
}

/* ───────────────────────── 准入（Admission） ───────────────────────── */

/**
 * 确定性准入闸门（不花 token）。DESIGN §10.3。
 * @param {{kind?:'schedule'|'manual', now?:Date, cfg?:object}} opts
 * @returns {{ok:boolean, reason:string, checks:object, due?:object}}
 */
export function admit({ kind = 'schedule', now = new Date(), cfg = mergedConfig() } = {}) {
  const checks = {}
  let dueState = null
  const reject = (reason) => ({ ok: false, reason, checks, due: dueState })
  checks.enabled = cfg.enabled === true
  if (!checks.enabled) return reject('disabled')
  if (kind === 'schedule') {
    checks.scheduleEnabled = cfg.schedule?.enabled === true
    if (!checks.scheduleEnabled) return reject('schedule-off')
  }
  const due = dueNow(cfg, now)
  dueState = due
  checks.due = due.due
  checks.indexReason = due.reason
  if (due.reason === 'index-corrupt') return reject('index-corrupt')

  checks.jobRunning = Boolean(activeJob())
  if (checks.jobRunning) return reject('job-running')

  const jobs = listJobs()
  const st = readState()
  const openStages = st.tickets
    .filter((t) => !t.endedAt)
    .map((t) => stageOf(t, readArtifacts(t), deriveAttention(t, readArtifacts(t), { jobs, now }), { jobs, now }))
  checks.ticketWorking = openStages.some((s) => s === 'working/running' || s === 'working/queued')
  if (checks.ticketWorking) return reject('ticket-working')

  checks.todayCount = countToday(now)
  const maxPerDay = Math.max(1, Number(cfg.tickets?.maxPerDay ?? 2))
  if (checks.todayCount >= maxPerDay) return reject('daily-limit')

  if (kind === 'schedule') {
    if (!due.due) return reject('not-due')
    checks.inWindow = inWakeWindow(cfg, now)
    if (!checks.inWindow) return reject('out-of-window')
    checks.cooldownLeftMs = cooldownLeftMs(cfg, now)
    if (checks.cooldownLeftMs > 0) return reject('cooldown')
  }
  return { ok: true, reason: 'accept', checks, due: dueState }
}

/** 今天的工单数（按本地日期，含已结束） */
export function countToday(now = new Date()) {
  const key = dayKey(now)
  return readState().tickets.filter((t) => dayKey(new Date(t.createdAt)) === key).length
}

/** 记录一条准入决定（accept / 到期被拒 / 手动 才记；完全没到期的 tick 不记——安静）。
 * 同类拒绝 10 分钟内只记一次，避免 60s tick 把账本刷满。 */
export function recordAdmission({ kind = 'schedule', decision, reason, checks = {}, at = new Date() }) {
  const st = readState()
  const last = st.admission[st.admission.length - 1]
  if (decision === 'reject' && last && last.kind === kind && last.decision === decision && last.reason === reason) {
    const age = at.getTime() - (Date.parse(last.at) || 0)
    if (age < 10 * 60_000) return
  }
  st.admission.push({ at: iso(at), kind, decision, reason: String(reason || ''), checks: clone(checks || {}) })
  if (st.admission.length > MAX_ADMISSION) st.admission = st.admission.slice(-MAX_ADMISSION)
  saveState()
}

export function admissionSummary(now = new Date()) {
  const st = readState()
  const recent = st.admission.slice(-5).reverse()
  return {
    todayCount: countToday(now),
    maxPerDay: Math.max(1, Number(mergedConfig().tickets?.maxPerDay ?? 2)),
    last: recent[0] || null,
    recent,
  }
}

/* ───────────────────────── 建工单 ───────────────────────── */

export function createTicket({ kind = 'schedule', reason = '', basis = null, observeOnly = false, now = new Date() } = {}) {
  const cfg = mergedConfig()
  const root = videoRoot()
  fs.mkdirSync(root, { recursive: true })
  const stamp = stampOf(now)
  let short = `ticket-${stamp}`
  let n = 1
  while (fs.existsSync(path.join(root, short))) { n += 1; short = `ticket-${stamp}-${n}` }
  const dir = path.join(root, short)
  fs.mkdirSync(dir, { recursive: true })
  const id = `tk-${stamp}-${crypto.randomBytes(2).toString('hex')}`
  const at = iso(now)
  const ticket = {
    id, short,
    title: kind === 'manual' ? '手动做一条视频' : `自动做一条视频（${reason || '到期'}）`,
    createdAt: at, updatedAt: at, endedAt: null,
    trigger: { kind, reason: String(reason || ''), basis: basis || (kind === 'manual' ? 'explicit' : 'inferred') },
    mandate: {
      policyVersion: POLICY_VERSION,
      scope: '一条视频：plan → storyboard → render → review → publish --dry',
      observeOnly: Boolean(observeOnly),
    },
    dir, sessionId: null, attempts: 0, lastAttemptAt: null,
    report: null, attention: [], acks: {}, outcome: null,
    events: [{ at, type: 'admitted', detail: `${kind} · ${reason || ''}` }],
  }
  const st = readState()
  st.tickets.push(ticket)
  if (st.tickets.length > MAX_TICKETS) st.tickets = st.tickets.slice(-MAX_TICKETS)
  saveState()
  log(`建工单 ${id}（${short} · ${kind}）`)
  return clone(ticket)
}

/* ───────────────────────── Attention（待你处理） ───────────────────────── */

function storedAttention(t) {
  return Array.isArray(t.attention) ? t.attention : []
}

function isAcked(t, key) {
  return Boolean(t.acks && key && t.acks[key])
}

/** 由「证据」推导出的 attention（不落盘：证据变了就自动消失/重出现） */
export function deriveAttention(t, art, { jobs = [], now = new Date() } = {}) {
  if (t.endedAt) return []
  const out = []
  const running = jobsForTicket(t, jobs).length > 0
  const rs = t.report?.status || null
  const quiet = !rs || rs === 'waiting' || rs === 'ready' || rs === 'blocked' || rs === 'failed'
  // 报告 ready 本身就是「等你审阅」：即使产物还没被扫描到，也要出现在待你处理里
  if (rs === 'ready') {
    const key = `report-ready:${t.report?.at || ''}`
    if (!isAcked(t, key)) {
      out.push({
        id: `at-ready-${t.id}`,
        kind: 'ready-for-review',
        detail: t.report?.note ? `agent 报告就绪：${String(t.report.note).slice(0, 300)}` : 'agent 报告一条视频已就绪，等你审阅/决定是否发布',
        since: t.report?.at || iso(now),
        actions: ['ack'],
        key,
      })
    }
  }
  if (quiet && !running) {
    if (art.review && art.review.pass === false) {
      const key = `reviewfail:${art.review.reviewedAt || art.reviewMtime || 0}`
      if (!isAcked(t, key)) {
        out.push({
          id: `at-reviewfail-${t.id}`,
          kind: 'review-failed',
          detail: `自审没过${art.review.score != null ? `（${art.review.score} 分）` : ''}；可重试让 agent 修改`,
          since: new Date(art.reviewMtime || now.getTime()).toISOString(),
          actions: ['retry', 'ack'],
          key,
        })
      }
    }
    const index = readIndex(videoRoot())
    const published = isPublished(t, art, index)
    if (!published && !out.some((a) => a.kind === 'ready-for-review') && art.review && art.review.pass === true && (art.publish || art.hasVideo)) {
      const key = `ready:${art.review.reviewedAt || art.reviewMtime || 0}:${art.publishMtime || 0}`
      if (!isAcked(t, key)) {
        out.push({
          id: `at-ready-${t.id}`,
          kind: 'ready-for-review',
          detail: art.publish
            ? `成片 + 自审 pass${art.review.score != null ? `（${art.review.score} 分）` : ''} + dry 投稿包都已就绪，等你决定是否在 B 站发布`
            : `成片 + 自审 pass${art.review.score != null ? `（${art.review.score} 分）` : ''}，等你审阅`,
          since: new Date(art.publishMtime || art.reviewMtime || now.getTime()).toISOString(),
          actions: ['ack'],
          key,
        })
      }
    }
  }
  return out
}

/** 全部 attention（持久化的 + 证据推导的） */
export function attentionOf(t, art, ctx) {
  const stored = storedAttention(t)
  const derived = deriveAttention(t, art, ctx)
  const seen = new Set(stored.map((a) => a.kind))
  return [...stored, ...derived.filter((a) => !seen.has(a.kind))]
}

export function addAttention(ticketId, { kind, detail = '', actions = ['retry', 'ack'] }) {
  const t = findRaw(ticketId)
  if (!t || t.endedAt) return null
  t.attention = storedAttention(t).filter((a) => a.kind !== kind)
  const entry = { id: `at-${crypto.randomBytes(3).toString('hex')}`, kind, detail: String(detail).slice(0, 800), since: iso(), actions }
  t.attention.push(entry)
  touch(t, 'attention', `${kind}：${detail}`)
  saveState()
  return clone(entry)
}

export function clearAttention(ticketId, kinds = null) {
  const t = findRaw(ticketId)
  if (!t) return false
  const before = storedAttention(t).length
  t.attention = kinds ? storedAttention(t).filter((a) => !kinds.includes(a.kind)) : []
  if (t.attention.length !== before) { touch(t, 'attention-cleared', kinds ? kinds.join(',') : 'all'); saveState() }
  return true
}

/* ───────────────────────── 阶段推导 ───────────────────────── */

export function stageOf(t, art, attention, { jobs = [], now = new Date() } = {}) {
  if (t.endedAt) return `done/${t.outcome?.kind || 'stopped'}`
  const kinds = new Set((attention || []).map((a) => a.kind))
  if (kinds.has('delivery-failed')) return 'person/delivery'
  if (kinds.has('rate-limited') || kinds.has('blocked')) return 'person/blocked'
  if (kinds.has('ready-for-review')) return 'person/review'
  if (kinds.size > 0) return 'person/failed'
  const rs = t.report?.status || null
  if (rs === 'ready') return 'person/review'
  if (rs === 'blocked') return 'person/blocked'
  if (rs === 'failed') return 'person/failed'
  if (rs === 'dropped') return 'done/dropped'
  if (isPublished(t, art, readIndex(videoRoot()))) return 'done/published'
  if (jobsForTicket(t, jobs).length > 0) return 'working/running'
  if (!t.sessionId) return 'working/queued'
  if (rs === 'waiting') return 'idle'
  return 'working/running'
}

/** 给外部的工单视图（阶段/标签/attention 都算好；不含 acks 内部字段） */
export function publicTicket(t, ctx) {
  const art = readArtifacts(t)
  const attention = attentionOf(t, art, ctx)
  const stage = stageOf(t, art, attention, ctx)
  return {
    id: t.id,
    short: t.short,
    title: (art.story && String(art.story.title || art.story.slug || '')) || t.title,
    dir: t.dir,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    endedAt: t.endedAt || null,
    attempts: t.attempts || 0,
    trigger: clone(t.trigger),
    mandate: clone(t.mandate),
    report: clone(t.report),
    outcome: clone(t.outcome),
    sessionId: t.sessionId || null,
    stage,
    stageLabel: STAGE_LABELS[stage] || stage,
    attention: attention.map(({ key, ...rest }) => rest),
    events: (t.events || []).slice(-20).map((e) => ({ ...e })),
  }
}

function snapshotCtx(now = new Date()) {
  return { jobs: listJobs(), now }
}

/** 最近工单（新→旧） */
export function listTickets({ limit = 50, now = new Date() } = {}) {
  const ctx = snapshotCtx(now)
  return readState().tickets
    .slice()
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, limit)
    .map((t) => publicTicket(t, ctx))
}

/** 所有开放工单的 attention（面板「待你处理」） */
export function listAttention({ now = new Date() } = {}) {
  const ctx = snapshotCtx(now)
  const out = []
  for (const t of readState().tickets) {
    if (t.endedAt) continue
    const art = readArtifacts(t)
    const attention = attentionOf(t, art, ctx)
    const stage = stageOf(t, art, attention, ctx)
    const title = (art.story && String(art.story.title || '')) || t.title
    for (const a of attention) {
      out.push({
        ticketId: t.id, short: t.short, title, stage, stageLabel: STAGE_LABELS[stage] || stage,
        kind: a.kind, detail: a.detail, since: a.since, actions: a.actions || ['ack'],
      })
    }
  }
  return out.sort((a, b) => String(b.since).localeCompare(String(a.since)))
}

/** 开放的、可自动重试的工单（attempts 未用尽 + 退避已过；风控永不自动重试） */
export function retryableTickets({ now = new Date(), cfg = mergedConfig() } = {}) {
  if (cfg.worker?.autoRetry?.enabled === false) return []
  const maxAttempts = Math.max(0, Number(cfg.worker?.autoRetry?.maxAttempts ?? 2))
  const backoffMs = Math.max(1, Number(cfg.worker?.autoRetry?.backoffMinutes ?? 10)) * 60_000
  const ctx = snapshotCtx(now)
  const out = []
  for (const t of readState().tickets) {
    if (t.endedAt) continue
    if ((t.attempts || 0) >= maxAttempts) continue
    const last = Date.parse(t.lastAttemptAt || t.createdAt) || 0
    if (now.getTime() - last < backoffMs) continue
    const art = readArtifacts(t)
    const attention = attentionOf(t, art, ctx)
    const kinds = attention.map((a) => a.kind)
    if (kinds.includes('rate-limited')) continue // 红线：风控永不自动重试
    if (!kinds.some((k) => RETRYABLE.has(k))) continue
    out.push({ ticket: t, attention })
  }
  return out
}

/** 轻量状态（叫醒词只需要这几个字段；避免 scheduler→status→pipeline 的重活） */
export function statusLite(cfg = mergedConfig()) {
  const due = dueNow(cfg)
  let last = null
  try {
    const index = readJson(path.join(videoRoot(), 'index.json'))
    const videos = Array.isArray(index?.videos) ? index.videos.slice() : []
    videos.sort((a, b) => String(a?.publishedAt || '').localeCompare(String(b?.publishedAt || '')))
    const v = videos[videos.length - 1]
    if (v && v.slug) last = { slug: String(v.slug), title: String(v.title || ''), publishedAt: v.publishedAt ?? null }
  } catch { /* 没有就算 */ }
  return {
    due: due.due,
    nextDueAt: due.nextDueAt,
    lastPublishedAt: due.lastPublishedAt,
    cadenceDays: due.cadenceDays,
    last,
  }
}

/** 准入原因的中文（面板/工具显示用） */
export const REASON_LABELS = {
  accept: '可以开始',
  disabled: '总开关关着',
  'schedule-off': '生物钟关着',
  'index-corrupt': '投稿索引损坏（先修 index.json）',
  'job-running': '已有任务在跑',
  'ticket-working': '已有一个工单在做',
  'daily-limit': '今天的工单额度用完了',
  'not-due': '还没到期',
  'out-of-window': '不在允许叫醒的窗口内',
  cooldown: '叫醒冷却中',
  'no-session-controller': '宿主没有 sessionController',
  'ticket-not-found': '工单不存在',
  'ticket-ended': '工单已结束',
}

/** 面板/工具用：按目录找开放工单（公开视图） */
export function findOpenTicketByDir(dir) {
  const t = findRawByDir(dir)
  return t ? publicTicket(t, snapshotCtx()) : null
}

/** 面板/工具用：按 id 取工单（公开视图） */
export function getTicketPublic(id, now = new Date()) {
  const t = findRaw(id)
  return t ? publicTicket(t, snapshotCtx(now)) : null
}

/* ───────────────────────── 派工（Assignment） ───────────────────────── */

function controllerOf(ctx) {
  if (!ctx) return null
  const c = (typeof ctx.get === 'function' ? ctx.get('sessionController') : null) || ctx.sessionController
  return c && typeof c.prompt === 'function' ? c : null
}

/** 决定 worker 会话 id / cwd（DESIGN §10.4） */
export function workerTarget(ticket, cfg = mergedConfig()) {
  const mode = cfg.worker?.sessionMode === 'persistent' ? 'persistent' : 'per-ticket'
  if (mode === 'persistent') return { mode, sessionId: 'bili-faship', cwd: workDir() }
  const safe = String(ticket.short || ticket.id).replace(/[^0-9A-Za-z\u4e00-\u9fa5_-]+/g, '-').slice(0, 60)
  return { mode, sessionId: `bili-faship-${safe}`, cwd: ticket.dir }
}

/**
 * 派工：把叫醒词投递给 worker 会话。成功才 ++attempts / 写 sessionId。
 * @returns {Promise<{ok:boolean, reason?:string, error?:string, sessionId?:string}>}
 */
export async function dispatchTicket(ticketId, ctx, { status = null, recovery = null, markSchedule = false, now = new Date() } = {}) {
  const t = findRaw(ticketId)
  if (!t) return { ok: false, reason: 'ticket-not-found', error: '工单不存在' }
  if (t.endedAt) return { ok: false, reason: 'ticket-ended', error: '工单已结束' }
  const controller = controllerOf(ctx)
  if (!controller) return { ok: false, reason: 'no-session-controller', error: '宿主没有 sessionController（headless profile 里没有这个服务）' }
  const cfg = mergedConfig()
  const target = workerTarget(t, cfg)
  try { fs.mkdirSync(target.cwd, { recursive: true }) } catch { /* 已存在/权限问题下面会报 */ }
  const cliPath = path.join(ROOT, 'tools', 'bili-faship.mjs')
  let prompt
  try {
    prompt = buildTicketPrompt({ ticket: t, status, recovery, cliPath })
  } catch (e) {
    return { ok: false, reason: 'prompt-failed', error: String(e?.message ?? e) }
  }
  // 复用已有会话：create 失败不是错误
  try { await controller.create?.({ sessionId: target.sessionId, cwd: target.cwd }) } catch { /* 沿用 */ }
  try {
    await controller.prompt({
      requestId: `bili-faship-${t.id}-${Date.now()}`,
      sessionId: target.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: prompt }],
    })
  } catch (e) {
    addAttention(t.id, { kind: 'delivery-failed', detail: `叫醒投递失败：${String(e?.message ?? e).slice(0, 300)}`, actions: ['retry', 'ack'] })
    t.lastAttemptAt = iso(now) // 尝试过：让自动重试按退避走，别每 tick 都打一次
    touch(t, 'dispatch-failed', String(e?.message ?? e))
    saveState()
    return { ok: false, reason: 'prompt-failed', error: String(e?.message ?? e) }
  }
  // 成功：清掉可重试的旧 attention，记 Assignment
  const retryableStored = storedAttention(t).filter((a) => RETRYABLE.has(a.kind)).map((a) => a.kind)
  if (retryableStored.length) t.attention = storedAttention(t).filter((a) => !RETRYABLE.has(a.kind))
  t.sessionId = target.sessionId
  t.attempts = (t.attempts || 0) + 1
  t.lastAttemptAt = iso(now)
  touch(t, 'dispatched', `${target.mode} · ${target.sessionId}${recovery ? ` · 恢复：${recovery}` : ''}`)
  saveState()
  if (markSchedule) {
    try {
      writeScheduleState({ ...readScheduleState(), lastWakeAt: iso(now), lastWakeDay: dayKey(now), lastAction: 'wake', lastSessionId: target.sessionId })
    } catch (e) { log('写 schedule.json 失败：' + (e?.message ?? e)) }
  }
  log(`派工 ${t.id} → ${target.sessionId}（第 ${t.attempts} 次）`)
  return { ok: true, sessionId: target.sessionId, mode: target.mode }
}

/* ───────────────────────── 报告（Report） ───────────────────────── */

export const REPORT_STATES = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']

export function recordReport({ ticketId, status, note = '' }) {
  const st = String(status || '')
  if (!REPORT_STATES.includes(st)) return { ok: false, error: `status 必须是 ${REPORT_STATES.join('|')}` }
  const t = findRaw(ticketId)
  if (!t) return { ok: false, error: '工单不存在' }
  if (t.endedAt) return { ok: false, error: '工单已结束（无法再报告）' }
  t.report = { status: st, note: String(note || '').slice(0, 1500), at: iso() }
  touch(t, 'report', `${st}：${note || ''}`)
  if (st === 'blocked') addAttention(t.id, { kind: 'blocked', detail: note || 'agent 报告受阻', actions: ['retry', 'ack'] })
  else if (st === 'failed') addAttention(t.id, { kind: 'failed', detail: note || 'agent 报告失败', actions: ['retry', 'ack'] })
  else if (st === 'ready' || st === 'waiting' || st === 'progress') {
    // 报告说"还在推进/就绪/等下一次"时，清掉旧的阻断类 attention（由证据推导的会自动更新）
    t.attention = storedAttention(t).filter((a) => a.kind === 'rate-limited')
    saveState()
  } else if (st === 'dropped') {
    endTicket(t, 'dropped', note || 'agent 报告无需处理')
  }
  saveState()
  return { ok: true, ticket: publicTicket(t, snapshotCtx()) }
}

/* ───────────────────────── 结束 / 动作 ───────────────────────── */

function endTicketInternal(t, kind, detail = '') {
  if (t.endedAt) return false
  t.endedAt = iso()
  t.outcome = { kind, detail: String(detail || '').slice(0, 500), at: t.endedAt }
  t.attention = []
  touch(t, 'ended', `${kind}${detail ? `：${detail}` : ''}`)
  return true
}

export function endTicket(ticketIdOrObj, kind, detail = '') {
  const t = typeof ticketIdOrObj === 'string' ? findRaw(ticketIdOrObj) : ticketIdOrObj
  if (!t) return false
  const changed = endTicketInternal(t, kind, detail)
  if (changed) saveState()
  return changed
}

/** 面板/工具动作：ack（我知道了）、stop（停止）、retry 在 api 层封装（要 ctx） */
export function ackTicket(id) {
  const t = findRaw(id)
  if (!t) return { ok: false, error: '工单不存在' }
  // 证据推导出来的 attention 用 acks（带证据 key）压住，直到证据变化
  const art = readArtifacts(t)
  const ctx = snapshotCtx()
  for (const a of deriveAttention(t, art, ctx)) {
    if (a.key) { t.acks = t.acks || {}; t.acks[a.key] = iso() }
  }
  t.attention = []
  touch(t, 'ack', '用户已读')
  saveState()
  return { ok: true, ticket: publicTicket(t, ctx) }
}

export function stopTicket(id, detail = '用户停止') {
  const t = findRaw(id)
  if (!t) return { ok: false, error: '工单不存在' }
  if (t.endedAt) return { ok: false, error: '工单已经结束' }
  const running = jobsForTicket(t, listJobs())
  for (const j of running) { try { terminateJob(j.id, `工单被停止：${detail}`) } catch { /* 忽略 */ } }
  endTicketInternal(t, 'stopped', detail)
  saveState()
  return { ok: true, ticket: publicTicket(t, snapshotCtx()) }
}

/* ───────────────────────── 任务事件 → 工单 ───────────────────────── */

export function detectRateLimit(text) {
  const s = String(text || '')
  const m = /(?:code["']?\s*[:=]\s*|"code":\s*)(601|412|429)|\b(601|412|429)\b[^\n]{0,80}(上传|风控|too fast|too many)/i.exec(s)
  return m ? (m[1] || m[2]) : null
}

function lastNonEmptyLines(text, n = 3) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-n).join(' / ').slice(0, 500)
}

/** jobs 模块的回调：任务开始/结束 → 工单事件 + failure attention */
export function handleJobEvent(type, job) {
  if (!job) return
  const t = (job.ticketId && findRaw(job.ticketId)) || findRawByDir(job.dir)
  if (!t) return
  if (type === 'started') {
    if (!t.endedAt) { touch(t, 'job-started', `${job.action} · ${job.id}`); saveState() }
    return
  }
  if (type !== 'finished' || t.endedAt) return
  touch(t, 'job-finished', `${job.action} · ${job.id} → ${job.status}${job.note ? `（${job.note}）` : ''}`)
  if (job.status === 'failed') {
    const full = (() => { try { return getJob(job.id) || job } catch { return job } })()
    const logText = String(full.log || '')
    const rate = detectRateLimit([logText, full.note || ''].join('\n'))
    if (rate) {
      addAttention(t.id, {
        kind: 'rate-limited',
        detail: `B 站风控 code=${rate}（${lastNonEmptyLines(logText) || full.note || '上传被拒'}）—— 需要人工去创作中心验证/等冷却，不要自动重试`,
        actions: ['ack', 'stop'],
      })
    } else if (job.action === 'render') {
      addAttention(t.id, { kind: 'render-failed', detail: `${full.note || '渲染失败'}：${lastNonEmptyLines(logText) || '（无日志）'}`, actions: ['retry', 'ack'] })
    } else {
      addAttention(t.id, { kind: 'job-failed', detail: `${job.action} 失败：${full.note || lastNonEmptyLines(logText) || ''}`, actions: ['retry', 'ack'] })
    }
  }
  if (job.status === 'done' && job.action === 'publish-go') {
    const art = readArtifacts(t)
    if (isPublished(t, art, readIndex(videoRoot()))) endTicketInternal(t, 'published', 'publish --go 成功，索引入账')
  }
  saveState()
}

/* ───────────────────────── 收尾 / 恢复 ───────────────────────── */

/** 把「已发布」和「报告 dropped」的开放工单结案（scheduler 每 tick 调一次，幂等） */
export function sweepTickets() {
  let changed = false
  const index = readIndex(videoRoot())
  for (const t of readState().tickets) {
    if (t.endedAt) continue
    if (t.report?.status === 'dropped') { changed = endTicketInternal(t, 'dropped', t.report.note || '') || changed; continue }
    const art = readArtifacts(t)
    if (isPublished(t, art, index)) changed = endTicketInternal(t, 'published', 'index.json 里已有这条') || changed
  }
  if (changed) saveState()
  return changed
}

/** 插件启动时：把「重启前在做、现在没人管」的开放工单标成 host-restarted */
export function reconcileTickets({ now = new Date(), graceMinutes = 30 } = {}) {
  const active = activeJob()
  const changes = []
  for (const t of readState().tickets) {
    if (t.endedAt) continue
    if (!t.sessionId) continue
    const rs = t.report?.status || null
    if (['waiting', 'ready', 'blocked', 'failed', 'dropped'].includes(rs)) continue
    const idleMs = now.getTime() - (Date.parse(t.updatedAt || t.createdAt) || now.getTime())
    const hasActive = active && (active.ticketId === t.id || (active.dir && t.dir && path.resolve(active.dir) === path.resolve(t.dir)))
    if (hasActive) continue
    if (idleMs < graceMinutes * 60_000) continue
    if (storedAttention(t).some((a) => a.kind === 'host-restarted')) continue
    addAttention(t.id, {
      kind: 'host-restarted',
      detail: '宿主重启/插件重载时，这个工单还在做。先检查工单目录里的产物，再决定重试（避免重复上一轮已完成的步骤）',
      actions: ['retry', 'ack'],
    })
    changes.push(t.id)
  }
  return changes
}

/* ───────────────────────── 面板/工具用的汇总 ───────────────────────── */

export function ticketsSummary(now = new Date()) {
  const tickets = listTickets({ now })
  const attention = listAttention({ now })
  return {
    ok: true,
    policyVersion: POLICY_VERSION,
    tickets,
    attention,
    admission: admissionSummary(now),
    open: tickets.filter((t) => !t.endedAt).length,
    needsAttention: attention.length,
  }
}

export { reportFile, workerTarget as _workerTarget }
