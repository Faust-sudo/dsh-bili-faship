/**
 * lib/scheduler.mjs —— 自主生物钟 = 一个**确定性 Router**（v0.2，借鉴 super-agent）
 *
 * 每 60 秒一 tick，顺序三件事（DESIGN §10.4 / §10.6）：
 *   1. **看门狗**：running 任务超时/卡住 → 结束 + 工单 attention（stalled）
 *   2. **收尾 + 自动重试**：已发布/已 dropped 的工单结案；可重试的 attention 按次数/退避再派工
 *   3. **准入 → 建工单 → 派工**：确定性闸门（due/窗口/冷却/限额/无任务）通过才叫醒 agent
 *
 * 不做的事（也很重要）：
 *   · 不判断内容、不花 token —— 准入是纯规则，可解释、可记录；
 *   · 不在同一天重复叫醒（daily-limit + 冷却 + 工单串行）；
 *   · 平台风控（601/412/429）永不自动重试（lib/tickets.mjs 的 rate-limited）。 
 */
import { mergedConfig } from './config.mjs'
import { activeJob, watchdogScan } from './jobs.mjs'
import {
  admit, recordAdmission, createTicket, dispatchTicket, reconcileTickets,
  sweepTickets, retryableTickets, statusLite, listTickets,
} from './tickets.mjs'

const TICK_MS = 60_000
const START_DELAY_MS = 15_000

function log(...args) {
  try { console.log('[bili-faship]', ...args) } catch { /* 忽略 */ }
}

/**
 * 启动生物钟。
 * @param {object} ctx cordis 上下文
 * @param {{cliPath?:string, tickMs?:number, log?:(s:string)=>void}} opts
 */
export function startScheduler(ctx, opts = {}) {
  const tickMs = opts.tickMs ?? TICK_MS
  let stopped = false
  let running = false
  let timer = null
  let startTimer = null

  function anyTicketWorking() {
    return listTickets().some((t) => !t.endedAt && (t.stage === 'working/running' || t.stage === 'working/queued'))
  }

  /** 自动重试：可重试 attention + attempts 未用尽 + 退避已过 → 再派工一次 */
  async function retryPass(cfg) {
    if (cfg.worker?.autoRetry?.enabled === false) return false
    if (activeJob() || anyTicketWorking()) return false
    const maxAttempts = Math.max(0, Number(cfg.worker?.autoRetry?.maxAttempts ?? 2))
    const backoffMs = Math.max(1, Number(cfg.worker?.autoRetry?.backoffMinutes ?? 10)) * 60_000
    const items = retryableTickets()
    if (!items.length) return false
    const now = Date.now()
    for (const { ticket } of items) {
      const attempts = Number(ticket.attempts || 0)
      if (attempts >= maxAttempts) continue // 次数用尽：留给「待你处理」
      const last = Date.parse(ticket.lastAttemptAt || ticket.createdAt) || 0
      if (now - last < backoffMs) continue
      const r = await dispatchTicket(ticket.id, ctx, {
        status: statusLite(cfg),
        recovery: `这是自动重试（第 ${attempts + 1} 次派工）。上一轮没有正常收尾；先检查工单目录里已有哪些产物（storyboard/video/review/publish），不要重复已完成的步骤。`,
        markSchedule: false,
      })
      if (r.ok) { log(`自动重试 ${ticket.id} → ${r.sessionId}`); return true }
      log(`自动重试 ${ticket.id} 失败：${r.reason} ${r.error || ''}`)
      return false
    }
    return false
  }

  async function tick() {
    if (stopped || running) return
    running = true
    try {
      const cfg = mergedConfig()
      if (!cfg.enabled) return

      // 1) 看门狗
      if (cfg.watchdog?.enabled !== false) {
        const hits = watchdogScan({
          maxJobMinutes: Number(cfg.watchdog?.maxJobMinutes ?? 40),
          idleMinutes: Number(cfg.watchdog?.idleMinutes ?? 8),
        })
        for (const h of hits) log(`看门狗结束任务 ${h.job.id}：${h.reason}`)
      }

      // 2) 收尾 + 自动重试
      sweepTickets()
      if (await retryPass(cfg)) return

      // 3) 准入 → 建工单 → 派工（只有规则的自动触发走这里）
      if (cfg.schedule?.enabled !== true) return
      const adm = admit({ kind: 'schedule', cfg })
      const due = adm.due || statusLite(cfg)
      if (adm.ok) {
        recordAdmission({ kind: 'schedule', decision: 'accept', reason: 'accept', checks: adm.checks })
        const reason = due.reason === 'never-published'
          ? '从没发过，到期'
          : `距上次发布到期（${due.cadenceDays} 天一条）`
        const ticket = createTicket({
          kind: 'schedule',
          reason,
          observeOnly: cfg.admission?.observeOnly === true,
        })
        const r = await dispatchTicket(ticket.id, ctx, {
          status: statusLite(cfg),
          markSchedule: true,
        })
        if (r.ok) log(`已建工单 ${ticket.id} 并派工 → ${r.sessionId}`)
        else log(`工单 ${ticket.id} 派工失败：${r.reason} ${r.error || ''}`)
      } else if (adm.reason !== 'not-due' && adm.reason !== 'index-corrupt') {
        // 到期但被窗口/冷却/限额/任务挡住 → 记一条，面板能解释"为什么今天没做"
        recordAdmission({ kind: 'schedule', decision: 'reject', reason: adm.reason, checks: adm.checks })
      }
    } catch (e) {
      log('tick 异常：' + (e?.message ?? e))
    } finally {
      running = false
    }
  }

  // 启动时先对账：上次重启前遗留的 open 工单 → host-restarted
  try {
    const changes = reconcileTickets()
    if (changes.length) log(`启动对账：${changes.length} 个工单标记为「宿主重启待处理」`)
  } catch (e) { log('启动对账失败：' + (e?.message ?? e)) }

  startTimer = setTimeout(() => { if (!stopped) tick() }, START_DELAY_MS)
  startTimer.unref?.()
  timer = setInterval(() => { if (!stopped) tick() }, tickMs)
  timer.unref?.()
  log(`生物钟已启动（Router：看门狗 → 收尾/重试 → 准入/派工；每 ${Math.round(tickMs / 1000)} 秒 tick）`)

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

export { TICK_MS }
