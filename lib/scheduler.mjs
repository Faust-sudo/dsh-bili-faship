/**
 * lib/scheduler.mjs —— 自主生物钟：到点把 agent 叫醒去做片（不靠对话框里挂 clock）。
 *
 * 抄 dsh-bili-whale 的生物钟（2026-10-18 主人要求）：
 *   · 插件宿主常驻 → 自己每 60 秒 tick 一次
 *   · 到点 → `ctx.sessionController.prompt({ sessionId, mode:'queue', content:[…] })`
 *     往她自己的专用会话里塞一个回合 → agent 真的醒来干活
 *   · 固定 sessionId（bili-faship）→ 跨天保留上下文，不是每天开新会话忘光
 *   · 状态落盘（schedule.json）：同一天不重复叫、成功后硬冷却 30 小时
 *
 * 与 whale 的差别：这里**只有一种叫醒**（做片），不处理监听/私信；条件全部来自
 * video.enabled + schedule.enabled + due + 窗口 + 冷却 + 没有任务在跑。
 */
import fs from 'node:fs'
import path from 'node:path'
import { mergedConfig, videoRoot } from './config.mjs'
import { scheduleFile, workDir } from './dirs.mjs'
import { activeJob } from './jobs.mjs'
import { buildWakePrompt } from './prompt.mjs'
import { readScheduleState, writeScheduleState, inWakeWindow } from './status.mjs'

const TICK_MS = 60_000
const SESSION_ID = 'bili-faship'
const START_DELAY_MS = 15_000

function log(...args) {
  try { console.log('[bili-faship]', ...args) } catch { /* 忽略 */ }
}

function localDayKey(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 轻量 due 判断：只读 index.json，不扫目录（tick 每分钟都跑，别做重活） */
export function dueNow(cfg, now = new Date()) {
  const root = videoRoot()
  const file = path.join(root, 'index.json')
  let index = null
  try {
    index = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // 不存在 = 从没发过 = 到期；损坏 = 不叫醒（别在坏账本上自动发东西）
    const exists = fs.existsSync(file)
    if (exists) return { due: false, reason: 'index-corrupt', lastPublishedAt: null, nextDueAt: null, cadenceDays: cfg.cadenceDays }
    return { due: true, reason: 'never-published', lastPublishedAt: null, nextDueAt: null, cadenceDays: cfg.cadenceDays }
  }
  const cadenceDays = Number(cfg.cadenceDays ?? 3)
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

/**
 * 立刻投递一次叫醒（POST /wake、faship_wake、tick 共用）。
 * @param {object} ctx cordis 上下文
 * @param {{manual?:boolean, reason?:string, cliPath:string, status?:object}} opts
 */
export async function deliverWake(ctx, { manual = false, reason = 'due', cliPath, status = null } = {}) {
  const controller = (typeof ctx?.get === 'function' ? ctx.get('sessionController') : null) || ctx?.sessionController
  if (!controller || typeof controller.prompt !== 'function') {
    return { ok: false, reason: 'no-session-controller', error: '宿主没有 sessionController（headless profile 里没有这个服务）' }
  }
  const text = buildWakePrompt({ reason: manual ? `手动叫醒（${reason}）` : reason, cliPath, status })
  // 会话不存在就创建；已存在时 create 会失败 —— 这不是错误，继续 prompt 即可
  try { await controller.create?.({ sessionId: SESSION_ID, cwd: workDir() }) } catch { /* 复用已有会话 */ }
  try {
    await controller.prompt({
      requestId: `bili-faship-${Date.now()}`,
      sessionId: SESSION_ID,
      mode: 'queue',
      content: [{ type: 'text', text }],
    })
  } catch (e) {
    return { ok: false, reason: 'prompt-failed', error: String(e?.message ?? e).slice(0, 400) }
  }
  const now = new Date()
  try {
    writeScheduleState({
      ...readScheduleState(),
      lastWakeAt: now.toISOString(),
      lastWakeDay: localDayKey(now),
      lastAction: manual ? 'wake-manual' : 'wake',
      lastSessionId: SESSION_ID,
    })
  } catch (e) { log('叫醒成功但写 schedule.json 失败：' + e.message) }
  log(`已叫醒（${manual ? '手动' : '自动'} · ${reason}）→ session=${SESSION_ID}`)
  return { ok: true, sessionId: SESSION_ID, at: now.toISOString() }
}

/**
 * 启动生物钟。
 * @param {object} ctx
 * @param {{cliPath:string, log?:(s:string)=>void, tickMs?:number}} opts
 */
export function startScheduler(ctx, opts = {}) {
  const tickMs = opts.tickMs ?? TICK_MS
  const cliPath = opts.cliPath
  let stopped = false
  let running = false
  let lastAttemptAt = 0
  let timer = null

  async function tick() {
    if (stopped || running) return
    running = true
    try {
      const cfg = mergedConfig()
      if (!cfg.enabled) return
      if (!cfg.schedule?.enabled) return
      const now = new Date()
      const due = dueNow(cfg, now)
      if (!due.due) return
      if (!inWakeWindow(cfg, now)) return
      const st = readScheduleState()
      if (st.lastWakeDay === localDayKey(now)) return
      const lastMs = st.lastWakeAt ? Date.parse(st.lastWakeAt) : NaN
      const cooldownMs = Math.max(1, Number(cfg.schedule?.cooldownHours ?? 30)) * 3600_000
      if (Number.isFinite(lastMs) && now.getTime() - lastMs < cooldownMs) return
      if (activeJob()) return
      const minGapMs = Math.max(1, Number(cfg.schedule?.minGapMinutes ?? 10)) * 60_000
      if (Date.now() - lastAttemptAt < minGapMs) return
      lastAttemptAt = Date.now()
      const r = await deliverWake(ctx, { cliPath, reason: '到期（自动）', status: { due: true, ...due } })
      if (!r.ok) log(`叫醒失败（${r.reason}）：${r.error || ''}`)
    } catch (e) {
      log('tick 异常：' + (e?.message ?? e))
    } finally {
      running = false
    }
  }

  // 启动后等一会儿再 tick：别和宿主启动抢资源
  const startTimer = setTimeout(() => { if (!stopped) tick() }, START_DELAY_MS)
  startTimer.unref?.()
  timer = setInterval(() => { if (!stopped) tick() }, tickMs)
  timer.unref?.()
  log(`生物钟已启动（每 ${Math.round(tickMs / 1000)} 秒 tick；session=${SESSION_ID}）`)

  return {
    stop() {
      stopped = true
      clearTimeout(startTimer)
      clearInterval(timer)
      log('生物钟已停止')
    },
    tickNow: tick,
  }
}

export { SESSION_ID, TICK_MS, scheduleFile }
