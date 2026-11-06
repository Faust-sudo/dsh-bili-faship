/**
 * dsh-bili-faship —— 宿主半端入口。
 * ============================================================================
 * 它是什么：把「鲸鱼娘自动做 B 站视频」的能力（原独立项目 bili-faship）做成一个 DSH 插件：
 *
 *   1. **设置页**「设置 → 视频工坊」（lib/client.js，浏览器半端自注册）——
 *      配置、依赖体检、现在做一条、任务进度、成片/封面预览、写 cookie。
 *   2. **HTTP API** `/dsh-bili-faship/api/*`（lib/api.mjs）——
 *      全部先过 DSH 信任栅栏；只接受本机回环；凭据只写不读回。
 *   3. **工具** `faship_*`（lib/tools.mjs）—— agent 在会话里查状态/起渲染/自审/投稿/看日志。
 *   4. **生物钟**（lib/scheduler.mjs）—— 每 60 秒 tick；到点（每 N 天一条 + 窗口内）用
 *      `ctx.sessionController.prompt(...)` 把她叫醒去做片；状态落盘，同一天不重复叫。
 *   5. **视频管线**（tools/**）—— plan → render(TTS/逐帧/字幕/混音) → review(硬闸门) →
 *      publish(--dry 投稿包 / --go 真发，受 601 红线约束)。
 *
 * 借鉴：dsh-bili-whale（设置页 section / 生物钟 / 信任栅栏 / 依赖体检 / 真 node 运行时）、
 *       dsh-bili-scroll（defineTool 注册 / 宿主依赖解析 / selfcheck / 打包规范）。
 *
 * 设计文档：DESIGN.md；用户文档：README.md。
 * ============================================================================
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadHostDeps } from './lib/hostdeps.mjs'
import { registerTools } from './lib/tools.mjs'
import { handleApi, API_PREFIX } from './lib/api.mjs'
import { startScheduler } from './lib/scheduler.mjs'
import { initJobs, disposeJobs, setJobListener } from './lib/jobs.mjs'
import { handleJobEvent } from './lib/tickets.mjs'
import { tryNodeRuntime } from './lib/node-runtime.mjs'
import { mergedConfig, CONFIG_FILE, videoRoot } from './lib/config.mjs'
import { DSH_HOME } from './tools/lib/paths.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, 'tools', 'bili-faship.mjs')
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version || '0.0.0' } catch { return '0.0.0' }
})()

function log(...args) {
  try { console.log('[bili-faship]', ...args) } catch { /* 忽略 */ }
}

// 工具注册器：优先宿主 dsh-tools，拿不到用本地等价实现（绝不让插件因一个 import 不激活）
let hostDeps = { defineTool: null, source: 'local', notes: ['未初始化'] }
try {
  hostDeps = await loadHostDeps()
} catch (e) {
  log('宿主依赖解析异常（用本地兜底继续）：' + String(e?.message ?? e))
  hostDeps = { defineTool: null, source: 'local', notes: [String(e?.message ?? e)] }
}

export default {
  name: 'dsh-bili-faship',

  // tools: 注册 faship_* 工具；webServer: 挂 /dsh-bili-faship/api/* 路由。
  // sessionController / connection 故意**不**写进 inject：
  //   · 有的 profile（headless/ACP）没有它们；写进来会让插件整条不激活 ✗
  //   · 运行时用 ctx.get(...) 懒取；拿不到就降级（生物钟不叫醒 / 信任栅栏 fail-closed）
  inject: ['tools', 'webServer'],

  apply(ctx) {
    const disposers = []
    let sched = null

    // 0) 任务状态机：读 jobs.json，把上次遗留的 running 标 interrupted
    try { initJobs() } catch (e) { log('初始化任务队列失败：' + e.message) }
    // 0.1) 任务事件 → 工单（失败/601 会写成「待你处理」）
    try { setJobListener(handleJobEvent) } catch (e) { log('挂任务事件监听失败：' + e.message) }

    // 1) 工具（faship_status / render / review / publish / job / wake / deps / videos / config）
    if (hostDeps.defineTool) {
      try { registerTools(ctx, hostDeps.defineTool) } catch (e) { log('工具注册异常（插件继续）：' + String(e?.message ?? e)) }
    } else {
      log('没有可用的 defineTool，跳过工具注册（插件其它部分照常）')
    }

    // 2) HTTP API（信任栅栏在 handler 内部，fail-closed）
    try {
      if (!ctx.webServer || typeof ctx.webServer.register !== 'function') {
        log('宿主没有 webServer 服务，设置页 API 不可用')
      } else {
        const reg = ctx.webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: async (req, res) => {
            try { await handleApi(ctx, req, res) } catch (e) {
              try { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) })) } catch { /* 忽略 */ }
            }
          },
        })
        if (typeof reg === 'function') disposers.push(reg)
        else if (reg && typeof reg.dispose === 'function') disposers.push(() => reg.dispose())
        else if (reg && typeof reg[Symbol.dispose] === 'function') disposers.push(() => reg[Symbol.dispose]())
      }
    } catch (e) {
      log('HTTP 路由挂载失败：' + String(e?.message ?? e))
    }

    // 3) 生物钟（到点自己叫醒 agent；sessionController 在 tick 里懒取）
    try {
      sched = startScheduler(ctx, { cliPath: CLI })
    } catch (e) {
      log('生物钟启动失败（不影响手动做片/设置页）：' + String(e?.message ?? e))
    }

    // 4) 卸载清理
    try {
      ctx.effect(() => () => {
        try { sched?.stop() } catch { /* 忽略 */ }
        try { disposeJobs() } catch { /* 忽略 */ }
        for (const d of disposers.splice(0)) { try { d() } catch { /* 忽略 */ } }
        log('已卸载')
      })
    } catch (e) { log('注册卸载钩子失败：' + String(e?.message ?? e)) }

    // 5) 启动摘要（出问题时第一眼能看出插件到底激活没有）
    try {
      const rt = tryNodeRuntime(DSH_HOME)
      const cfg = mergedConfig()
      log(`v${VERSION} 已挂载 · API ${API_PREFIX} · 设置页「视频工坊」`)
      log(`配置：${CONFIG_FILE} · 视频根：${videoRoot()} · 管线 CLI：${CLI}`)
      log(`真 node：${rt.ok ? rt.file : '✗ 未找到（' + rt.error + '）'} · defineTool 来源：${hostDeps.source}${hostDeps.source === 'local' ? '（本地等价实现）' : ''}`)
      log(`做片开关：enabled=${cfg.enabled} · 每 ${cfg.cadenceDays} 天一条 · 自动叫醒=${cfg.schedule?.enabled} · 允许真发=${cfg.autoPublish?.allowGo === true}`)
      for (const note of hostDeps.notes || []) log('依赖解析：' + note)
    } catch (e) { log('启动摘要生成失败：' + String(e?.message ?? e)) }
  },
}
