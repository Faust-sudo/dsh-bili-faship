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

/** 派工投递超时：宿主 prompt(request, signal) 会等准入完成才返回；正常几毫秒，超过这个就是宿主卡了。 */
const DISPATCH_TIMEOUT_MS = 30_000
/** 没有 sessionId 的工单，只有「刚建的」才算排队中；超过这个时间的说明派工没成功（别永久占住准入）。 */
const QUEUED_FRESH_MS = 10 * 60_000

export const POLICY_VERSION = '0.2.0'
const MAX_TICKETS = 50
const MAX_ADMISSION = 50
/** 可**自动**重试的 attention：只限「任务执行失败」这类确定性的失败。
 *  ⚠️ `stalled` / `host-restarted` 不在此列：舞台判断不了 agent 是否其实还在干活
 *  （per-ticket worker 可能直接在 CLI 里 render，不产生宿主 job 事件），
 *  自动再派一次会让同一个目录出现两个 worker（重复渲染/重复发布风险）。这两种留给人工 retry。 */
const RETRYABLE = new Set(['job-failed', 'render-failed', 'publish-failed', 'delivery-failed'])

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
  'done/expired': '已过期',
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
let cacheMtimeMs = 0

function emptyState() {
  return { version: 1, policyVersion: POLICY_VERSION, tickets: [], admission: [] }
}

/** tickets.json 损坏时先备份原件再当空账本（v0.2.0 会静默清空，下次写入就把证据覆盖掉）。 */
function backupCorruptTickets() {
  try {
    const f = ticketsFile()
    if (!fs.existsSync(f)) return
    const bak = `${f}.corrupt-${Date.now()}.bak`
    fs.copyFileSync(f, bak)
    log(`tickets.json 不是合法 JSON，已备份到 ${bak}`)
  } catch { /* 备份失败也不阻断启动 */ }
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(ticketsFile(), 'utf8'))
    if (!isObj(raw) || !Array.isArray(raw.tickets)) return emptyState()
    return {
      version: 1,
      policyVersion: typeof raw.policyVersion === 'string' ? raw.policyVersion : POLICY_VERSION,
      tickets: trimTickets(raw.tickets.filter((t) => isObj(t) && typeof t.id === 'string')),
      admission: Array.isArray(raw.admission) ? raw.admission.slice(-MAX_ADMISSION) : [],
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') backupCorruptTickets()
    return emptyState()
  }
}

export function readState() {
  if (cache) {
    // 多进程（宿主 + 手工 CLI/脚本）可能同时写账本：文件变了就重读，别拿旧缓存覆盖别人的更新
    try {
      const st = fs.statSync(ticketsFile())
      if (st.mtimeMs !== cacheMtimeMs) { cache = loadState(); cacheMtimeMs = st.mtimeMs }
    } catch { /* 文件不在：沿用内存 */ }
    return cache
  }
  cache = loadState()
  try { cacheMtimeMs = fs.statSync(ticketsFile()).mtimeMs } catch { cacheMtimeMs = 0 }
  return cache
}

function saveState() {
  if (!cache) return
  try {
    cache.tickets = trimTickets(cache.tickets)
    const payload = {
      version: 1,
      policyVersion: POLICY_VERSION,
      updatedAt: iso(),
      tickets: cache.tickets,
      admission: cache.admission.slice(-MAX_ADMISSION),
    }
    fs.mkdirSync(path.dirname(ticketsFile()), { recursive: true })
    const tmp = `${ticketsFile()}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`)
    fs.renameSync(tmp, ticketsFile())
    try { cacheMtimeMs = fs.statSync(ticketsFile()).mtimeMs } catch { /* 忽略 */ }
  } catch (e) { log('写 tickets.json 失败：' + (e?.message ?? e)) }
}

/** 测试用：丢掉内存缓存、从磁盘重读 */
export function resetTicketsCache() { cache = null; cacheMtimeMs = 0 }

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

/** 账本只留最近 MAX_TICKETS 条，但**开放工单不能丢**（丢了 = 孤儿目录 + 永不结案）。 */
function trimTickets(list) {
  if (list.length <= MAX_TICKETS) return list
  const open = list.filter((t) => !t.endedAt)
  const ended = list.filter((t) => t.endedAt)
  const keepOpen = open.slice(-MAX_TICKETS)
  const room = Math.max(0, MAX_TICKETS - keepOpen.length)
  const keepEnded = room > 0 ? ended.slice(-room) : []
  return [...keepEnded, ...keepOpen]
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
  // 本工单自己的 publish.json 有 bvid：铁证
  if (art.publish && art.publish.bvid) return true
  // index 兜底匹配：必须「同一 slug + 发布时间不早于工单创建时间」
  // （v0.2.0 只比 slug → 新工单碰巧用了历史已发布过的 slug 时会被误判"已发布"直接结案）
  const createdMs = Date.parse(t.createdAt || '') || 0
  return index.videos.some((v) => {
    if (!v || typeof v.slug !== 'string' || !v.bvid || v.slug !== art.slug) return false
    if (v.dir && t.dir) {
      try { return path.resolve(String(v.dir)) === path.resolve(t.dir) } catch { /* 落到时间判断 */ }
    }
    const pubMs = Date.parse(String(v.publishedAt || '')) || 0
    return pubMs >= createdMs
  })
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
  // ⚠️ 这里必须用 attentionOf（持久化 + 证据推导），不能用 deriveAttention：
  //    投递失败 / 风控 / 任务失败这些 attention 是**落盘**的，deriveAttention 推导不出来。
  //    v0.2.0 真实事故：一条 delivery-failed 工单被这里误判成 working/queued，
  //    于是每 tick 都返回 ticket-working —— 手动「现在做一条」也永远被挡住。
  const openViews = st.tickets
    .filter((t) => !t.endedAt)
    .map((t) => {
      const art = readArtifacts(t)
      const attention = attentionOf(t, art, { jobs, now })
      return { stage: stageOf(t, art, attention, { jobs, now }), attention }
    })
  checks.ticketWorking = openViews.some((v) => v.stage === 'working/running' || v.stage === 'working/queued')
  if (checks.ticketWorking) return reject('ticket-working')
  // 叫醒投递本身失败时不要再建新工单：新工单也会以同一种方式失败，只会在面板上堆一串
  // 「待你处理（投递失败）」。先把那条工单重试成 / 我知道了 / 停止，再继续。
  checks.deliveryBlocked = openViews.some((v) => v.attention.some((a) => a.kind === 'delivery-failed'))
  if (checks.deliveryBlocked) return reject('delivery-blocked')

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
  st.tickets = trimTickets(st.tickets)
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
  // 用户已经「我知道了」的失败/受阻：不再算"等你"，否则工单会永远显示忙等（且面板里没有可点的按钮）
  if ((rs === 'failed' || rs === 'blocked') && t.ackedAt) return 'idle'
  if (rs === 'ready') return 'person/review'
  if (rs === 'blocked') return 'person/blocked'
  if (rs === 'failed') return 'person/failed'
  if (rs === 'dropped') return 'done/dropped'
  if (isPublished(t, art, readIndex(videoRoot()))) return 'done/published'
  if (jobsForTicket(t, jobs).length > 0) return 'working/running'
  if (!t.sessionId) {
    // 「还没派工过」只有两种可能：刚建好（马上就会派工）→ 排队中；
    // 或者派工失败后用户点了「我知道了」（attention 被清掉）→ 必须落到 idle，
    // 否则一条永远轮不到的工单会显示"制作中"并永久占住准入（死锁）。
    if (t.ackedAt) return 'idle'
    const bornMs = Date.parse(t.createdAt || t.updatedAt || '') || 0
    return now.getTime() - bornMs < QUEUED_FRESH_MS ? 'working/queued' : 'idle'
  }
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
  'delivery-blocked': '有一条工单叫醒投递失败（先重试 / 我知道了 / 停止它）',
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

/** 进程内派工锁（见 dispatchTicket） */
const dispatching = new Set()

/** 某工单此刻是否正在派工（scheduler 预检用） */
export function isDispatching(ticketId) { return dispatching.has(ticketId) }

/** 宿主有没有 sessionController（headless profile 里没有）：scheduler 建工单前先探测 */
export function hasSessionController(ctx) { return Boolean(controllerOf(ctx)) }

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
  // 进程内派工锁：API「重试」与 scheduler.retryPass 可能并发进同一个工单，
  // 没有锁时宿主会收到两条 prompt、attempts 跳级（v0.2.0 实测 attempts 1→3，越过 maxAttempts）。
  if (dispatching.has(ticketId)) return { ok: false, reason: 'dispatching', error: '这张工单正在派工，等它完成' }
  dispatching.add(ticketId)
  try {
    const cfg = mergedConfig()
    const target = workerTarget(t, cfg)
    try { fs.mkdirSync(target.cwd, { recursive: true }) } catch { /* 已存在/权限问题下面会报 */ }
    const cliPath = path.join(ROOT, 'tools', 'bili-faship.mjs')
    let prompt
    try {
      prompt = buildTicketPrompt({ ticket: t, status, recovery, cliPath })
    } catch (e) {
      // 拼装失败也要留 attention + 退避戳：否则工单永远停在「排队中」，面板上没有任何可点的东西
      t.attempts = (t.attempts || 0) + 1
      t.lastAttemptAt = iso(now)
      addAttention(t.id, { kind: 'delivery-failed', detail: `叫醒词拼装失败：${String(e?.message ?? e).slice(0, 300)}`, actions: ['retry', 'ack'] })
      touch(t, 'dispatch-failed', `prompt-failed：${String(e?.message ?? e)}（第 ${t.attempts} 次）`)
      saveState()
      return { ok: false, reason: 'prompt-failed', error: String(e?.message ?? e) }
    }
    // 复用已有会话：create 失败不是错误（会话可能已存在；prompt 失败时会带真实原因）。
    // ⚠️ 宿主的 create() 可能**返回另一个 sessionId**：当请求的 id 已有带 turn 的历史、不能复用时，
    //    它会 mint 一个新会话（dsh-api-session-controller 的 claim/createMinted）。
    //    必须以返回值为准，否则会把叫醒词投给一个已经不会再用到的旧 id。
    let targetSessionId = target.sessionId
    try {
      const created = await controller.create?.({ sessionId: target.sessionId, cwd: target.cwd })
      if (created && typeof created.sessionId === 'string' && created.sessionId) targetSessionId = created.sessionId
    } catch (e) {
      log(`复用/新建会话 ${target.sessionId} 失败（继续尝试投递）：${String(e?.message ?? e).slice(0, 160)}`)
    }
    // ⚠️ 宿主契约：sessionController.prompt(request, signal) 的第二个参数是 AbortSignal，
    //    宿主实现第一行就是 signal.throwIfAborted()（解包源码 dsh-api-session-controller/lib/index.js 的 prompt(request, signal)）。
    //    v0.2.0 漏传这个参数 → 每次派工都 TypeError "Cannot read properties of undefined (reading 'throwIfAborted')"
    //    → 生物钟叫醒从来没成功过（本机 tickets.json 里连续几十次 dispatch-failed 就是它）。
    const signal = AbortSignal.timeout(DISPATCH_TIMEOUT_MS)
    try {
      await controller.prompt({
        requestId: `bili-faship-${t.id}-${Date.now()}`,
        sessionId: targetSessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      }, signal)
    } catch (e) {
      // 失败也算一次派工尝试：否则 delivery-failed 的自动重试没有上限（每 10 分钟一次、永远不停）
      t.attempts = (t.attempts || 0) + 1
      addAttention(t.id, { kind: 'delivery-failed', detail: `叫醒投递失败：${String(e?.message ?? e).slice(0, 300)}`, actions: ['retry', 'ack'] })
      t.lastAttemptAt = iso(now) // 尝试过：让自动重试按退避走，别每 tick 都打一次
      touch(t, 'dispatch-failed', `${String(e?.message ?? e)}（第 ${t.attempts} 次）`)
      saveState()
      return { ok: false, reason: 'prompt-failed', error: String(e?.message ?? e) }
    }
    // 投递是 async 的：这期间用户可能点了「停止」。已结束的工单不能再写 Assignment（否则幽灵会话继续跑）。
    const fresh = findRaw(t.id)
    if (!fresh || fresh.endedAt) {
      log(`工单 ${t.id} 在派工期间被停止，丢弃本次 Assignment`)
      return { ok: false, reason: 'ticket-ended', error: '派工期间工单被停止了' }
    }
    // 成功：清掉可重试的旧 attention，记 Assignment
    const retryableStored = storedAttention(fresh).filter((a) => RETRYABLE.has(a.kind)).map((a) => a.kind)
    if (retryableStored.length) fresh.attention = storedAttention(fresh).filter((a) => !RETRYABLE.has(a.kind))
    fresh.sessionId = targetSessionId
    fresh.attempts = (fresh.attempts || 0) + 1
    fresh.lastAttemptAt = iso(now)
    touch(fresh, 'dispatched', `${target.mode} · ${targetSessionId}${recovery ? ` · 恢复：${recovery}` : ''}`)
    saveState()
    if (markSchedule) {
      try {
        writeScheduleState({ ...readScheduleState(), lastWakeAt: iso(now), lastWakeDay: dayKey(now), lastAction: 'wake', lastSessionId: targetSessionId })
      } catch (e) { log('写 schedule.json 失败：' + (e?.message ?? e)) }
    }
    log(`派工 ${fresh.id} → ${targetSessionId}（第 ${fresh.attempts} 次）`)
    return { ok: true, sessionId: targetSessionId, mode: target.mode }
  } finally {
    dispatching.delete(ticketId)
  }
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
  // 证据推导出来的 attention 用 acks（带证据 key）压住，直到证据变化。
  // 注意：「成片就绪」有两种表示（报告 ready / 产物扫描），key 不同；
  // 两种都要压住，否则 ack 后下一次轮询会以另一种 key 重新冒出来。
  const art = readArtifacts(t)
  const ctx = snapshotCtx()
  const derived = deriveAttention(t, art, ctx)
  t.acks = t.acks || {}
  for (const a of derived) {
    if (a.key) t.acks[a.key] = iso()
  }
  if (derived.some((a) => a.kind === 'ready-for-review')) {
    if (t.report?.at) t.acks[`report-ready:${t.report.at}`] = iso()
    if (art.review) t.acks[`ready:${art.review.reviewedAt || art.reviewMtime || 0}:${art.publishMtime || 0}`] = iso()
  }
  t.attention = []
  t.ackedAt = iso() // 阶段推导用：ack 过的失败/受阻/未派工工单落 idle，不要永远显示"等你/制作中"
  t.lastStallNoticeAt = iso() // 已读：60 分钟内别再提"卡住/重启"
  touch(t, 'ack', '用户已读')
  saveState()
  return { ok: true, ticket: publicTicket(t, ctx) }
}

export function stopTicket(id, detail = '用户停止', ctx = null) {
  const t = findRaw(id)
  if (!t) return { ok: false, error: '工单不存在' }
  if (t.endedAt) return { ok: false, error: '工单已经结束' }
  const running = jobsForTicket(t, listJobs())
  for (const j of running) { try { terminateJob(j.id, `工单被停止：${detail}`) } catch { /* 忽略 */ } }
  // 结束 worker 会话里正在跑的 turn：只杀宿主 job 不够 —— worker 会话可能还在跑 CLI/工具，
  // 点「停止」之后它仍可能继续写目录、甚至继续 publish（v0.2.0 实测：stop 只终止后台 job）。
  if (t.sessionId) {
    try {
      const controller = controllerOf(ctx)
      if (controller && typeof controller.cancel === 'function') {
        const r = controller.cancel({ sessionId: t.sessionId })
        if (r && typeof r.then === 'function') r.catch((e) => log(`取消会话 ${t.sessionId} 失败：${String(e?.message ?? e).slice(0, 160)}`))
        touch(t, 'session-cancelled', `已请求取消会话 ${t.sessionId}`)
      }
    } catch (e) {
      log(`取消会话 ${t.sessionId} 失败（继续结案）：${String(e?.message ?? e).slice(0, 160)}`)
    }
  }
  endTicketInternal(t, 'stopped', detail)
  saveState()
  return { ok: true, ticket: publicTicket(t, snapshotCtx()) }
}

/* ───────────────────────── 任务事件 → 工单 ───────────────────────── */

/** 风控识别（红线）：publish 层风控失败统一带 `[RISK]` 前缀；同时兼容历史/平台原文的各种码。
 *  ⚠️ v0.2.0 只认 `code=601`，导致 -412/-352/-799/-509/-10403/10031、HTTP 412/429 全落成
 *  「可自动重试」的 job-failed —— 红线（永不重试）失效。 */
export function detectRateLimit(text, { action = '' } = {}) {
  const s = String(text || '')
  if (!s) return null
  if (/\[RISK\b[^\]]*\]/i.test(s)) return 'risk'
  const code = /(?:code["']?\s*[:=]\s*|code=)(-?(?:601|412|429|10031|10403|352|799|509))\b/i.exec(s)
  if (code) return code[1]
  const http = /\bHTTP\s+(412|429)\b/i.exec(s)
  if (http) return http[1]
  // 纯文本兜底只在发布动作里用（渲染/TTS 的报错里出现「风控」字样不代表 B 站风控）
  if (String(action).startsWith('publish') && /(上传过快|请求过于频繁|请求太快|触发平台风控|风控|验证码|稍作休息|too many requests|too fast)/i.test(s)) return 'text'
  return null
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
    const rate = detectRateLimit([logText, full.note || ''].join('\n'), { action: job.action })
    if (rate) {
      addAttention(t.id, {
        kind: 'rate-limited',
        detail: `B 站风控 code=${rate}（${lastNonEmptyLines(logText) || full.note || '上传被拒'}）—— 需要人工去创作中心验证/等冷却，不要自动重试`,
        actions: ['ack', 'stop'],
      })
    } else if (/watchdog|看门狗/i.test(String(full.note || ''))) {
      // 看门狗结束的任务：面板/README 的口径是 stalled（不是 render-failed）
      addAttention(t.id, { kind: 'stalled', detail: `任务被看门狗结束：${full.note || ''}；${lastNonEmptyLines(logText) || '（无日志）'}`, actions: ['retry', 'ack'] })
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

/** 把「已发布」「报告 dropped」「等太久没动静的 waiting」的开放工单结案（scheduler 每 tick 调一次，幂等） */
export function sweepTickets() {
  let changed = false
  const index = readIndex(videoRoot())
  for (const t of readState().tickets) {
    if (t.endedAt) continue
    if (t.report?.status === 'dropped') { changed = endTicketInternal(t, 'dropped', t.report.note || '') || changed; continue }
    // report=waiting 的工单若 48 小时没有任何动静，自动结案：否则它会永远挂在"等下一次触发"，
    // 下一次触发又会新建工单，旧工单就成了永久僵尸（占 50 条账本上限、面板永远多一条）。
    if (t.report?.status === 'waiting' && Date.now() - lastActivityMs(t) > 48 * 3600_000) {
      changed = endTicketInternal(t, 'expired', '这一轮没有产出，48 小时无动静，自动结案') || changed
      continue
    }
    const art = readArtifacts(t)
    if (isPublished(t, art, index)) changed = endTicketInternal(t, 'published', 'index.json 里已有这条') || changed
  }
  if (changed) saveState()
  return changed
}

/** 工单最近一次"有动静"的时间：事件时间 + 目录/产物 mtime 取最大。
 *  worker 可能直接在 CLI 里 render（不产生宿主 job 事件），只看 updatedAt 会在长渲染期间误判"卡住"
 *  → reconcile 标 stalled → 自动重试再派一个 worker = 同一目录两个 worker。 */
function lastActivityMs(t) {
  let ms = Date.parse(t.updatedAt || t.createdAt || '') || 0
  if (!t.dir) return ms
  try { ms = Math.max(ms, fs.statSync(t.dir).mtimeMs) } catch { /* 目录没了 */ }
  for (const f of ['storyboard.json', 'video.mp4', 'review.json', 'publish.json', 'meta.json', 'timing.json']) {
    try { ms = Math.max(ms, fs.statSync(path.join(t.dir, f)).mtimeMs) } catch { /* 还没有 */ }
  }
  return ms
}

/** 插件启动 / 每 tick 的存活检查：把「没人管」的开放工单标成 attention。
 *  · 启动时用 kind='host-restarted'（宿主重启/插件重载）
 *  · 运行期每 tick 用 kind='stalled'（工单长时间没有任何动静、也没有在跑的任务）
 * 同一种通知 60 分钟内不重复（避免 60s tick 刷屏；ack 也会刷新这个时间）。 */
export function reconcileTickets({ now = new Date(), graceMinutes = 45, kind = 'host-restarted' } = {}) {
  const active = activeJob()
  const changes = []
  for (const t of readState().tickets) {
    if (t.endedAt) continue
    if (!t.sessionId) continue
    const rs = t.report?.status || null
    if (['waiting', 'ready', 'blocked', 'failed', 'dropped'].includes(rs)) continue
    const idleMs = now.getTime() - lastActivityMs(t)
    if (idleMs < graceMinutes * 60_000) continue
    const hasActive = active && (active.ticketId === t.id || (active.dir && t.dir && path.resolve(active.dir) === path.resolve(t.dir)))
    if (hasActive) continue
    if (storedAttention(t).some((a) => a.kind === 'host-restarted' || a.kind === 'stalled')) continue
    const lastNotice = Date.parse(t.lastStallNoticeAt || '') || 0
    if (now.getTime() - lastNotice < 60 * 60_000) continue
    addAttention(t.id, {
      kind,
      detail: kind === 'stalled'
        ? `工单超过 ${Math.round(graceMinutes)} 分钟没有任何动静，也没有在跑的任务（可能卡住/会话已结束）。先检查工单目录，再重试或停止`
        : '宿主重启/插件重载时，这个工单还在做。先检查工单目录里的产物，再决定重试（避免重复上一轮已完成的步骤）',
      actions: ['retry', 'ack'],
    })
    t.lastStallNoticeAt = iso(now)
    saveState()
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
