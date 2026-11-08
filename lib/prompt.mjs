/**
 * lib/prompt.mjs —— 到点/手动派工时的「工单叫醒词」（唯一出处，v0.2）。
 *
 * 借鉴 DeepSeek super-agent（DESIGN §10.4）：
 *   · 叫醒词 = 一张工单的**派工单**：Mandate（为什么允许）、Scope（做什么/不做什么）、
 *     Inputs（素材、上次汇报、恢复说明）、Rules（红线/发布策略）、Deliverable（交付物 + 结构化报告）。
 *   · 只给事实和路径，不替她做创作决定；流程写死，失败点写清。
 *   · 恢复说明（recovery）必须显式出现：重启/重试时先看目录，别重复已完成的步骤。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergedConfig, videoRoot } from './config.mjs'
import { reportFile } from './dirs.mjs'
import { materialStats } from './deps.mjs'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const fmtTime = (iso) => {
  if (!iso) return '（无）'
  try {
    return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  } catch { return String(iso) }
}

function readLastReport(limit = 1400) {
  try {
    const t = fs.readFileSync(reportFile(), 'utf8').trim()
    return t.length > limit ? t.slice(-limit) : t
  } catch { return '' }
}

function recentVideoDirs(limit = 5) {
  try {
    return fs.readdirSync(videoRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .slice(-limit)
  } catch { return [] }
}

/**
 * 生成一张工单的叫醒词。
 * @param {{ticket:object, status?:object|null, recovery?:string|null, cliPath:string, now?:Date}} opts
 */
export function buildTicketPrompt({ ticket, status = null, recovery = null, cliPath, now = new Date() }) {
  const cfg = mergedConfig()
  const root = videoRoot()
  const p = cfg.persona || {}
  const name = p.name || '大肥鱼'
  const owner = p.ownerTitle || '主人'
  const self = p.selfClaim || '我'
  const allowGo = cfg.autoPublish?.allowGo === true
  const observeOnly = ticket?.mandate?.observeOnly === true
  const mat = materialStats()
  const diaryLines = (cfg.materials?.diary || []).map((f) => `   - ${f}`).join('\n') || '   -（设置页里还没配置日记路径）'
  const extraNotes = (Array.isArray(cfg.materials?.extraNotes) ? cfg.materials.extraNotes : [])
    .filter((x) => typeof x === 'string' && x.trim())
  const extraLine = extraNotes.length
    ? `\n- 额外素材 / 便签（设置页里配的，可选）：\n${extraNotes.map((f) => `   - ${f}`).join('\n')}`
    : ''
  const last = status?.last
    ? `${status.last.title || status.last.slug}（${status.last.slug}）· ${fmtTime(status.last.publishedAt)}`
    : '（还没发过）'
  const nextDue = status?.nextDueAt ? fmtTime(status.nextDueAt) : '现在（还没发过）'
  const report = readLastReport()
  const recent = recentVideoDirs()
  const basisText = ticket.trigger?.basis === 'explicit'
    ? `这是${owner}明确要求的（${ticket.trigger?.reason || '手动'}）`
    : `这是一条由规则允许的自动工单（${ticket.trigger?.reason || '到期'}）`

  const observeBlock = observeOnly
    ? `\n## ⚠️ 观察模式（本轮只做计划，不动手）
- 只允许：看日记/上次汇报 → 选题 → ` + '`plan`' + ` 生成 storyboard 模板 → **自己写 storyboard.json 草稿** → 跑 ` + '`deps --json`' + ` 检查依赖。
- **不要 render、不要 publish**（观察模式的 mandate 只到"计划"为止）。
- 最后用 faship_report 报 ready，并在汇报里写清「如果放开，我打算怎么做、会发什么」。
- 这轮的成品是一份可审阅的 storyboard 草稿 + 计划，不是视频。
`
    : ''

  return `【鲸鱼娘视频工坊 · 工单 ${ticket.id}】
你是「${name}」${owner ? `，${owner}的鲸鱼娘` : ''}。${self}现在有一张工单要做。

## 授权（Mandate）
- ${basisText}
- 范围（Scope）：一条视频 —— plan → 写 storyboard → render → review（必须 pass）→ publish --dry 投稿包。
- 依据：worker.sessionMode=${cfg.worker?.sessionMode ?? 'per-ticket'}；策略版本 ${ticket.mandate?.policyVersion ?? '0.2.0'}。
${observeBlock}
## 工单信息
- 工单号：${ticket.id}
- 工单目录（你的工作目录）：${ticket.dir}
- 视频根目录：${root}
- 插件目录（文档都在这里）：${PLUGIN_ROOT}
- CLI（用真 node 跑）：node "${cliPath}"
- 今天：${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（Asia/Shanghai）
- 上次发布：${last}
- 频率：每 ${cfg.cadenceDays ?? 3} 天一条；下次到期：${nextDue}
- 素材（日记）：
${diaryLines}
  实际存在的日记文件：${mat.present}/${mat.total}${extraLine}
- 上次汇报（${reportFile()}）：
${report ? report : '（还没有）'}
- 最近做过的目录：${recent.length ? recent.join(' / ') : '（还没有）'}
${recovery ? `\n## 恢复说明（重要）\n${recovery}\n先检查工单目录里已有哪些产物（storyboard.json / video.mp4 / review.json / publish.json），**不要重复已经完成的步骤**。` : ''}

## 这一轮按顺序做
1. **先看目录**：\`ls\` 一下工单目录；已有产物就接着做，别覆盖别人的成果。
2. **选题**：从日记里找一件**具体**的事（具体时间、具体的人、具体的一句话），不要抽象感想（具体 > 抽象，自嘲 > 元气，摆烂 > 励志）。
3. **写 storyboard**：\`plan --dir "${ticket.dir}" --topic "一句话主题"\`，再自己改 storyboard.json（12 场左右、每场 2–3 秒；字段见 \`${PLUGIN_ROOT}/docs/video-storyboard.md\`、内容指南见 \`${PLUGIN_ROOT}/prompts/charter.md\`）。大字（shout/stamp）和旁白不要重复同一句。
4. **渲染**：优先用工具 \`faship_render { dir: "${ticket.dir}" }\` 起后台任务（宿主可见进度/失败，工单联动；之后用 \`faship_job\` 查进度）；
   只有工具不可用时才跑 CLI：\`render --dir "${ticket.dir}"\`（1080p 约 3–4 分钟）。
5. **自审**：\`review --dir "${ticket.dir}"\`（或工具 \`faship_review\`）—— **必须 pass**；不过就改，不要绕过代码闸门。
6. **投稿包**：\`publish --dir "${ticket.dir}" --dry\`（默认只生成包、不联网）。
7. **写汇报**：200–400 字写到 ${reportFile()}（做了什么 / 哪一场最像${self} / 失败就写失败原因）。
8. **报工单状态**（必须）：调 \`faship_report\`，参数：
   \`{ ticket: "${ticket.id}", status: "ready|waiting|blocked|failed|dropped|progress", note: "一句话" }\`
   - \`ready\` = 成片 + 自审 pass + dry 投稿包都就绪（等人决定是否发布）
   - \`waiting\` = 这一轮先到这，等下一次触发
   - \`blocked\` / \`failed\` = 卡住/失败，note 里写清缺什么、试过什么
   - \`dropped\` = 今天不想做/没必要做（写清原因，工单会无消息结案）
9. **回复${owner}**：一两句人话总结，不要贴流程日志。

## 红线（代码强制，不是建议）
- 画面 topbar 和投稿简介都必须有「AI 生成」；不得说自己是真人/冒用真人身份。
- 引用别人片段必须 \`citations\` 三要素齐全（UP / 标题 / BV），单段 ≤3 秒。
- 不刷量、不群发、不诱导互关。
- 撞 412 / 429 / 601：**立即停**，记下时间，不重试、不绕验证码（601 是平台风控，等${owner}去创作中心处理）。

## 发布策略
- 本轮默认：**只做 dry 投稿包**${allowGo ? '' : '，绝对不要加 --go'}。
${allowGo
    ? '- 设置里已打开「允许真发」：如果 review pass、且确认 601 冷却已过，可以 `publish --go`；失败就停，不连点。'
    : '- 「允许真发」是关的：任何情况下都不要真投。把 dry 投稿包和 review 结果留在工单目录里。'}

## 可以不做
如果今天不想做，就在日记里写一句为什么，然后 faship_report 报 \`dropped\` 并写清原因。
这不叫偷懒，是安排。**唯一禁止的是把没做写成做完了。**
`
}

/** 兼容 v0.1 的调用（旧测试/旧代码用；新代码请用 buildTicketPrompt） */
export function buildWakePrompt({ reason = 'due', now = new Date(), cliPath, status = null } = {}) {
  const cfg = mergedConfig()
  return buildTicketPrompt({
    ticket: {
      id: 'tk-legacy',
      dir: videoRoot(),
      mandate: { policyVersion: '0.2.0', observeOnly: false },
      trigger: { kind: 'schedule', reason, basis: 'inferred' },
      attempts: 0,
    },
    status, cliPath, now,
  }) + `\n> 本轮 video.enabled=${cfg.enabled}，schedule.enabled=${cfg.schedule?.enabled}\n`
}

export { fmtTime, path }
