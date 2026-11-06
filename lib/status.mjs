/**
 * lib/status.mjs —— 「现在什么状态」的唯一计算口径（设置页 / 工具 / 生物钟共用）。
 *
 * 数据源：
 *   · 管线状态：tools/commands/video.mjs 的 videoStatus()（index.json + 待发目录）—— 与 CLI 完全一致
 *   · 视频列表：直接扫 videoRoot()（storyboard/meta/review/publish/cover）
 *   · 生物钟：<DSH_HOME>/bili-faship/schedule.json + 配置里的窗口/冷却
 *   · 汇报：<DSH_HOME>/bili-faship/last-report.md
 */
import fs from 'node:fs'
import path from 'node:path'
import { mergedConfig, videoRoot, CONFIG_FILE } from './config.mjs'
import { scheduleFile, reportFile } from './dirs.mjs'
import { listJobs, activeJob } from './jobs.mjs'

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** "HH:MM" → 当天分钟数 */
export function hhmmToMin(s) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s ?? ''))
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** 当前是否在叫醒窗口内（支持跨午夜，如 21:00–01:00） */
export function inWakeWindow(cfg, now = new Date()) {
  const win = cfg?.schedule?.window
  const start = hhmmToMin(win?.start)
  const end = hhmmToMin(win?.end)
  if (start === null || end === null) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  if (start === end) return true
  if (start < end) return cur >= start && cur <= end
  return cur >= start || cur <= end // 跨午夜
}

function localDayKey(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function readScheduleState() {
  const st = readJsonSafe(scheduleFile())
  if (!st || typeof st !== 'object') {
    return { version: 1, lastWakeAt: null, lastWakeDay: null, lastAction: null, lastSessionId: null }
  }
  return {
    version: 1,
    lastWakeAt: typeof st.lastWakeAt === 'string' ? st.lastWakeAt : null,
    lastWakeDay: typeof st.lastWakeDay === 'string' ? st.lastWakeDay : null,
    lastAction: st.lastAction ?? null,
    lastSessionId: st.lastSessionId ?? null,
  }
}

export function writeScheduleState(next) {
  fs.mkdirSync(path.dirname(scheduleFile()), { recursive: true })
  const tmp = `${scheduleFile()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`)
  fs.renameSync(tmp, scheduleFile())
}

/** 读管线状态（动态 import CLI 模块，避免插件启动时加载整条管线） */
export async function pipelineStatus() {
  const mod = await import('../tools/commands/video.mjs')
  return mod.videoStatus({ config: mergedConfig() })
}

/** 扫视频目录，拿到设置页/工具需要的列表 */
export function listVideos() {
  const root = videoRoot()
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return { root, videos: [] } }
  const videos = []
  const index = readJsonSafe(path.join(root, 'index.json'))
  const publishedBySlug = new Map()
  for (const v of (Array.isArray(index?.videos) ? index.videos : [])) {
    if (v && typeof v.slug === 'string') publishedBySlug.set(v.slug, v)
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const dir = path.join(root, e.name)
    const storyboard = path.join(dir, 'storyboard.json')
    if (!fs.existsSync(storyboard)) continue
    let story = readJsonSafe(storyboard)
    // storyboard.json 是合法 JSON 才当故事板；校验交给 CLI/review
    if (story && story.story && typeof story.story === 'object') story = story.story
    const meta = readJsonSafe(path.join(dir, 'meta.json'))
    const review = readJsonSafe(path.join(dir, 'review.json'))
    const publish = readJsonSafe(path.join(dir, 'publish.json'))
    let mtime = null
    try { mtime = fs.statSync(dir).mtime.toISOString() } catch { /* 忽略 */ }
    const published = (publish && publish.bvid) ? publish : (publishedBySlug.get(String(story?.slug ?? e.name)) || null)
    videos.push({
      slug: String(story?.slug ?? e.name),
      title: String(story?.title ?? meta?.title ?? published?.title ?? e.name),
      dir,
      mtime,
      hasVideo: fs.existsSync(path.join(dir, 'video.mp4')),
      hasCover: fs.existsSync(path.join(dir, 'cover.jpg')),
      hasStoryboard: true,
      review: review && typeof review === 'object'
        ? { pass: review.pass === true, score: Number(review.score ?? 0) }
        : null,
      published: published?.bvid ? { bvid: String(published.bvid), publishedAt: published.publishedAt ?? null } : null,
    })
  }
  videos.sort((a, b) => String(b.mtime || '').localeCompare(String(a.mtime || '')))
  return { root, videos }
}

export function readReport() {
  try {
    const text = fs.readFileSync(reportFile(), 'utf8')
    const st = fs.statSync(reportFile())
    return { text, updatedAt: st.mtime.toISOString(), bytes: Buffer.byteLength(text, 'utf8') }
  } catch {
    return { text: '', updatedAt: null, bytes: 0 }
  }
}

/** 生物钟视角：现在能不能叫醒、为什么 */
export function scheduleView(cfg, status, now = new Date()) {
  const st = readScheduleState()
  const job = activeJob()
  const today = localDayKey(now)
  const lastWakeMs = st.lastWakeAt ? Date.parse(st.lastWakeAt) : NaN
  const cooldownMs = Math.max(1, Number(cfg.schedule?.cooldownHours ?? 30)) * 3600_000
  let reason
  if (!cfg.enabled) reason = 'disabled'
  else if (!cfg.schedule?.enabled) reason = 'schedule-off'
  else if (job) reason = 'job-running'
  else if (!status?.due) reason = 'not-due'
  else if (!inWakeWindow(cfg, now)) reason = 'out-of-window'
  else if (st.lastWakeDay === today) reason = 'already-woke-today'
  else if (Number.isFinite(lastWakeMs) && now.getTime() - lastWakeMs < cooldownMs) reason = 'cooldown'
  else reason = 'due'
  return {
    enabled: Boolean(cfg.schedule?.enabled),
    inWindow: inWakeWindow(cfg, now),
    lastWakeAt: st.lastWakeAt,
    lastWakeDay: st.lastWakeDay,
    wakeable: reason === 'due',
    reason,
    cooldownUntil: Number.isFinite(lastWakeMs) ? new Date(lastWakeMs + cooldownMs).toISOString() : null,
    window: cfg.schedule?.window ?? null,
  }
}

/**
 * 完整状态（GET /status 与 faship_status 用）。
 */
export async function getStatus() {
  const cfg = mergedConfig()
  let pipe
  try {
    pipe = await pipelineStatus()
  } catch (e) {
    // index.json 损坏等：不要把状态做成 500，把错误带出去让用户看到
    pipe = {
      root: videoRoot(), indexState: 'error', indexFile: path.join(videoRoot(), 'index.json'),
      last: null, lastPublishedAt: null, nextDueAt: null, cadenceDays: cfg.cadenceDays,
      due: true, pending: [], error: String(e?.message ?? e),
    }
  }
  const vids = listVideos()
  const report = readReport()
  // v0.2 工单/准入汇总（动态 import：tickets 依赖 status，静态 import 会成环）
  let ticketInfo = { tickets: [], attention: [], admission: null, open: 0, needsAttention: 0 }
  try {
    const tk = await import('./tickets.mjs')
    ticketInfo = tk.ticketsSummary()
  } catch (e) {
    ticketInfo.error = String(e?.message ?? e)
  }
  return {
    ok: !pipe.error,
    now: new Date().toISOString(),
    home: path.dirname(CONFIG_FILE),
    configPath: CONFIG_FILE,
    videoRoot: pipe.root,
    due: Boolean(pipe.due),
    nextDueAt: pipe.nextDueAt ?? null,
    cadenceDays: Number(pipe.cadenceDays ?? cfg.cadenceDays ?? 3),
    indexState: pipe.indexState,
    lastPublishedAt: pipe.lastPublishedAt ?? null,
    last: pipe.last ?? null,
    pending: Array.isArray(pipe.pending) ? pipe.pending : [],
    videos: vids.videos.length,
    schedule: scheduleView(cfg, pipe),
    jobs: listJobs().slice(0, 10).map(({ id, action, dir, status, startedAt, finishedAt, exitCode, note }) => ({ id, action, dir, status, startedAt, finishedAt, exitCode, note })),
    lastReport: { updatedAt: report.updatedAt, bytes: report.bytes },
    // v0.2
    needsAttention: ticketInfo.needsAttention ?? 0,
    tickets: {
      open: ticketInfo.open ?? 0,
      needsAttention: ticketInfo.needsAttention ?? 0,
      attention: (ticketInfo.attention || []).slice(0, 10),
    },
    admission: ticketInfo.admission || null,
    error: pipe.error ?? null,
  }
}
