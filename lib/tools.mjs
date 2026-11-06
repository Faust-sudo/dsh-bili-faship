/**
 * lib/tools.mjs —— 注册给 agent 的 faship_* 工具。
 *
 * 为什么要有工具（而不是只给 CLI）：
 *   · agent 在会话里可以直接查状态/起渲染/看任务日志，不用拼 shell 命令、不用记路径；
 *   · 工具返回值是结构化 JSON，比 CLI 文本更适合模型读；
 *   · 危险动作（真发）在工具层再做一次闸门（confirm + allowGo + review pass）。
 *
 * 注册器（defineTool）来自 lib/hostdeps.mjs：优先用宿主的，拿不到用本地等价实现。
 * 任何一个工具注册失败都只 log，不影响插件其它部分（绝对不能让插件整条不激活）。
 */
import path from 'node:path'
import {
  getSettings, getStatusFull, getVideos, getDeps, runAction, wakeNow,
  getTickets, ticketAction, reportToTicket,
} from './api.mjs'
import { getJob, listJobs, runSync, resolveDir } from './jobs.mjs'
import { REPORT_STATES } from './tickets.mjs'
import { mergedConfig } from './config.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')

function log(...args) {
  try { console.log('[bili-faship tools]', ...args) } catch { /* 忽略 */ }
}

/** 工具返回值必须是无损 JSON（宿主 2026-10-14 踩过的坑） */
function safe(v) {
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}

const textOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

/** 所有工具共用的一段说明，避免 agent 拿它去干别的 */
const SAFETY = '红线由代码强制：AI 标注 / 不冒充真人 / 引用三要素且 ≤3 秒 / 不刷量不群发；撞 412/429/601 立即停，不重试不绕验证码。'

/**
 * @param {object} ctx cordis 上下文
 * @param {Function} defineTool 宿主或本地的 defineTool
 * @returns {string[]} 注册成功的工具名
 */
export function registerTools(ctx, defineTool) {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    log('宿主没有 tools 服务，跳过工具注册（插件其它部分照常）')
    return []
  }
  const names = []
  const tool = (spec) => {
    try {
      ctx.tools.register(defineTool({
        ...spec,
        output: spec.output || textOutput,
        async execute(args = {}, exec) {
          return safe(await spec.execute(args, exec))
        },
      }))
      names.push(spec.name)
    } catch (e) {
      log(`工具 ${spec.name} 注册失败（不影响插件）：${e?.message ?? e}`)
    }
  }

  tool({
    name: 'faship_status',
    description: `看「鲸鱼娘视频工坊」现在的状态：是否到期、上次发布、待发视频、生物钟是否可叫醒、正在跑的任务、上次汇报。做片前先调它。${SAFETY}`,
    parameters: {},
    async execute() {
      const st = await getStatusFull()
      const { jobs, ...rest } = st
      return { ...rest, jobs: (jobs || []).slice(0, 5) }
    },
  })

  tool({
    name: 'faship_deps',
    description: '依赖体检：node / ffmpeg / Python+Pillow / 随包素材 / 数据目录 / 表情包 / 字体 / cookie / 日记素材。装完插件或渲染报错时先调它。',
    parameters: {},
    async execute() { return await getDeps() },
  })

  tool({
    name: 'faship_videos',
    description: '列出视频根目录下所有视频：slug/标题/有没有成片封面/review 是否 pass/是否已发布。',
    parameters: {},
    async execute() { return getVideos() },
  })

  tool({
    name: 'faship_plan',
    description: '建一条视频的工作目录 + 生成 storyboard.json 模板（已存在则只校验不覆盖）。之后自己改 storyboard.json 再调 faship_render。',
    parameters: {
      topic: { type: 'string', required: true, description: '一句话主题；用于目录名与模板标题' },
      dir: { type: 'string', description: '可选：显式视频目录（必须在视频根目录内）；不填则按 topic 生成' },
      width: { type: 'number', description: '可选：画面宽（默认 1920；冒烟用 320）' },
      height: { type: 'number', description: '可选：画面高（默认 1080；冒烟用 180）' },
      fps: { type: 'number', description: '可选：帧率（默认 30；冒烟用 15）' },
    },
    async execute(args) {
      const r = await runAction({ action: 'plan', topic: String(args.topic ?? ''), dir: args.dir, width: args.width, height: args.height, fps: args.fps })
      return r.ok ? { ok: true, ...(r.result || {}) } : { ok: false, error: r.error }
    },
  })

  tool({
    name: 'faship_render',
    description: '渲染一条视频（后台任务，约 3–4 分钟）。返回 job；之后用 faship_job 查进度和日志。会做 TTS → 逐帧渲染 → 字幕 → 混音 → 成片+封面。',
    parameters: {
      dir: { type: 'string', required: true, description: '视频目录（plan 生成的那个）' },
    },
    async execute(args) {
      const r = await runAction({ action: 'render', dir: String(args.dir ?? '') })
      return r.ok ? { ok: true, job: r.job } : { ok: false, error: r.error, job: r.job || null }
    },
  })

  tool({
    name: 'faship_review',
    description: '代码自审（同步，几秒）：schema/时长/响度/字幕覆盖/AI 标注/引用标注/红线词 + 0–100 分。pass 是发布前置硬条件。',
    parameters: {
      dir: { type: 'string', required: true, description: '视频目录' },
    },
    async execute(args) {
      const r = await runAction({ action: 'review', dir: String(args.dir ?? '') })
      if (r.ok) return { ok: true, ...(r.result || {}) }
      return { ok: false, error: r.error, result: r.result || null }
    },
  })

  tool({
    name: 'faship_publish',
    description: '生成 dry 投稿包（默认，不联网）或真发。真发（mode="go"）必须同时：设置里 autoPublish.allowGo=true、autoPublish.dryRun=false、review 已 pass、并显式 confirm=true。真发是后台任务（B站 两次写之间有冷却）。',
    parameters: {
      dir: { type: 'string', required: true, description: '视频目录（必须 review pass）' },
      mode: { type: 'string', required: true, description: 'dry = 只生成投稿包（推荐）；go = 真发（需要 confirm）' },
      confirm: { type: 'boolean', description: '真发必须显式传 true' },
    },
    async execute(args) {
      const mode = String(args.mode ?? 'dry')
      if (mode !== 'dry' && mode !== 'go') return { ok: false, error: 'mode 只能是 dry 或 go' }
      const r = await runAction({ action: mode === 'go' ? 'publish-go' : 'publish-dry', dir: String(args.dir ?? ''), confirm: args.confirm === true })
      return r.ok ? { ok: true, ...(r.job ? { job: r.job } : { result: r.result }) } : { ok: false, error: r.error }
    },
  })

  tool({
    name: 'faship_job',
    description: '查后台任务（渲染/真发）的状态与日志尾部；不传 id 就列出最近任务。',
    parameters: {
      id: { type: 'string', description: '可选：任务 id；不传则列出最近任务' },
    },
    async execute(args) {
      const id = String(args.id ?? '')
      if (!id) return { ok: true, jobs: listJobs().slice(0, 10) }
      const j = getJob(id)
      if (!j) return { ok: false, error: `没有这个任务：${id}` }
      return { ok: true, job: j, log: j.log }
    },
  })

  tool({
    name: 'faship_wake',
    description: '立刻叫醒一次做片（不等窗口/冷却；设置页「现在做一条」同款）。正常自动流程不需要它。',
    parameters: {
      force: { type: 'boolean', description: '留 true 表示确认要手动叫醒' },
    },
    async execute(args) {
      if (args.force !== true) return { ok: false, error: '手动叫醒需要 force: true（防止误触）' }
      // 由 index.js 注入的 wake 函数在 ctx 上取；这里用 api 的入口
      const r = await wakeNow(ctx, { manual: true, reason: 'agent 手动' })
      return r.ok ? { ok: true, ...r } : { ok: false, error: r.error, reason: r.reason }
    },
  })

  tool({
    name: 'faship_tickets',
    description: `看工单（v0.2）：开放的/最近的工单、每个工单的阶段（等你审阅/受阻/失败/制作中/已完成）、以及「需要你处理」的 attention 列表和最近准入记录。开工做片前先调它。${SAFETY}`,
    parameters: {},
    async execute() {
      const s = getTickets()
      return {
        ok: true,
        policyVersion: s.policyVersion,
        attention: s.attention,
        tickets: (s.tickets || []).slice(0, 10),
        admission: s.admission,
      }
    },
  })

  tool({
    name: 'faship_report',
    description: `给工单报结构化状态（v0.2，必做）：progress=还在做 / waiting=这一轮先到这 / ready=成片+自审 pass+dry 投稿包就绪，等人决定发布 / blocked=卡住需要人 / failed=失败 / dropped=无需处理（工单会无消息结案）。note 写一句话原因或结果。`,
    parameters: {
      ticket: { type: 'string', required: true, description: '工单 id（叫醒词里给的 tk-…）' },
      status: { type: 'string', required: true, description: `工单状态：${REPORT_STATES.join('|')}` },
      note: { type: 'string', description: '一句话说明（结果/卡在哪/为什么不做）' },
    },
    async execute(args) {
      const status = String(args.status ?? '')
      if (!REPORT_STATES.includes(status)) return { ok: false, error: `status 必须是 ${REPORT_STATES.join('|')}` }
      const r = reportToTicket({ ticket: args.ticket, status, note: args.note })
      return r.ok ? { ok: true, ticket: r.ticket } : { ok: false, error: r.error }
    },
  })

  tool({
    name: 'faship_ticket_action',
    description: '工单动作（v0.2）：retry=再派工一次（清 attention；受任务/工单串行约束）/ ack=我知道了（清 attention）/ stop=停止并结案。',
    parameters: {
      id: { type: 'string', required: true, description: '工单 id' },
      action: { type: 'string', required: true, description: 'retry | ack | stop' },
    },
    async execute(args) {
      const r = await ticketAction(ctx, { id: String(args.id ?? ''), action: String(args.action ?? '') })
      return r.ok ? { ok: true, ticket: r.ticket } : { ok: false, error: r.error }
    },
  })

  tool({
    name: 'faship_config',
    description: '读当前配置（只读；改配置走设置页）。写 storyboard 前想知道声音/尺寸/发布策略时用它。',
    parameters: {},
    async execute() {
      const s = getSettings()
      return { ok: true, config: s.config, configPath: s.configPath, videoRoot: s.videoRoot }
    },
  })

  log(`已注册工具 ${names.length} 个：${names.join(', ')}`)
  return names
}

export { ROOT, mergedConfig, resolveDir, runSync }
