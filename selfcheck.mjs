/**
 * selfcheck.mjs —— 插件的「预检」：**两个半端都在本地真跑一遍**，不靠"重启一次才知道错哪"
 *
 * 为什么要它（抄 dsh-bili-scroll 的教训）：
 *   ① 宿主半端 `apply()` 抛错 ⇒ DSH 日志只留一句 `1 entry did not activate`，插件整条不出现；
 *   ② 工具注册的 schema 不合法 / 路由注册签名不对 ⇒ 表现在设置页打开是 404 或按钮点了没反应；
 *   ③ 设置页 `client.js` 的 `__ModuleLoader__.load({ id })` 不等于包名 / factory 抛错 ⇒ 设置页整块空白。
 * 这三类问题在浏览器里都很难一眼看出来 —— 这里两个半端各跑一遍，错了直接报在哪一步。
 *
 * 用法：`node selfcheck.mjs`（在插件根目录；不需要 DSH 在跑）
 * 退出码：0 = 两个半端都正常；1 = 有问题（宿主里就会 "entry did not activate" / 设置页空白）
 *
 * ⚠️ 全程用**临时 DSH_HOME**（os.tmpdir 下），绝不碰真实配置、真实视频目录和真实任务状态。
 *    —— 宿主模块在 import 时读 DSH_HOME，所以环境变量必须在 **import 之前** 设好。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const SANDBOX = path.join(os.tmpdir(), `dsh-bili-faship-selfcheck-${process.pid}`)

/* ────────────── 0) 沙箱：先把 DSH_HOME 指到临时目录，再 import 任何宿主模块 ────────────── */
process.env.DSH_HOME = SANDBOX
process.env.BILI_FASHIP_CONFIG = path.join(SANDBOX, 'bili-faship.config.json')
delete process.env.BILI_WHALE_CONFIG // 别让旧配置的 video 段漏进来
try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 清不掉就复用 */ }
fs.mkdirSync(SANDBOX, { recursive: true })

const disposers = []
let failures = 0

function fail(msg, e) {
  failures += 1
  console.error(`\n✗ ${msg}`)
  if (e) {
    console.error(`  ${e?.name ?? 'Error'}: ${e?.message ?? e}`)
    const frame = String(e?.stack ?? '').split('\n').slice(1, 5).join('\n')
    if (frame) console.error(frame)
  }
}

function finish() {
  // 把 effect 注册的清理函数跑一遍（相当于插件卸载）—— 清理本身抛错也是问题，记下来
  for (const d of disposers.reverse()) {
    try { d() } catch (e) { fail('清理函数（effect 返回值）抛错 —— 插件卸载时宿主会报错', e) }
  }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 留着也无所谓 */ }
  if (failures > 0) {
    console.error(`\n✗ 自检失败：${failures} 项问题（宿主里表现为 entry did not activate / 设置页空白）`)
    process.exit(1)
  }
  console.log(`\n✓ 自检通过（全程不碰真家目录：DSH_HOME=${SANDBOX}）`)
  process.exit(0)
}

console.log(`[selfcheck] 临时 DSH_HOME = ${SANDBOX}`)

/* ────────────── ① host 半端：假 ctx 上真跑 apply() ────────────── */

let mod
try {
  mod = await import('./index.js')
} catch (e) {
  fail('连 import index.js 都失败（宿主里 = 插件整条不激活；看 lib/hostdeps.mjs 的宿主依赖兜底）', e)
  finish()
}

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
const registeredTools = []
const registeredRoutes = []
const effectErrors = []

const fakeConnection = {
  // 契约返回 undefined = 放行（selfcheck 不模拟真实请求）
  requestRejection: () => undefined,
}

const fakeCtx = {
  root: ROOT,
  get(key) {
    if (key === 'dshHomePath') {
      // ⭐ 宿主给的是**函数**（`dshHomePath(...segments)`），这里照样给函数 —— 别给字符串
      return (...segments) => path.join(SANDBOX, ...segments)
    }
    if (key === 'connection') return fakeConnection
    if (key === 'logger') return logger
    if (key === 'sessionController') return undefined // 故意不给：调度器应容忍「不可用」
    if (key === 'dshHome') return SANDBOX
    return undefined
  },
  get connection() { return fakeConnection },
  logger,
  tools: {
    register(tool) { registeredTools.push(tool); return tool },
  },
  webServer: {
    register(route) {
      registeredRoutes.push(route)
      const dispose = () => {}
      dispose.dispose = dispose // 宿主两种调用形状（d() / d.dispose()）都兼容
      return dispose
    },
  },
  effect(fn) {
    try {
      const ret = fn()
      if (typeof ret === 'function') disposers.push(ret)
    } catch (e) {
      effectErrors.push(e)
    }
  },
  settings: { register: () => ({}) },
  slots: { inject: () => {}, register: () => ({}) },
}

if (typeof mod?.apply !== 'function' && typeof mod?.default?.apply !== 'function') {
  fail('index.js 没有导出 apply(ctx)（默认导出或具名导出都行）—— 宿主不会激活这个插件')
}
// 兼容两种导出形状：`export default { name, inject, apply }`（whale 的做法）或具名导出（scroll 的做法）
const plugin = typeof mod?.apply === 'function' ? mod : mod?.default
if (plugin && typeof plugin.apply === 'function') {
  try {
    await plugin.apply(fakeCtx, {})
  } catch (e) {
    fail('host 半端 apply() 抛错了 —— 宿主里就是那句 `warning: 1 entry did not activate`', e)
  }
}

for (const e of effectErrors) fail('ctx.effect(fn) 里的同步代码抛错', e)

const toolNames = registeredTools.map((t) => t?.name ?? String(t))
const routePaths = registeredRoutes.map((r) => r?.path ?? r?.pathname ?? '')

console.log(`\n✓ host 半端：name=${plugin?.name ?? '(未导出)'}  inject=${JSON.stringify(plugin?.inject ?? null)}`)
console.log(`  工具 ${toolNames.length} 个：${toolNames.join(', ') || '（无）'}`)
console.log(`  路由 ${routePaths.length} 条：${routePaths.join(', ') || '（无）'}`)

// 工具名契约（DESIGN §6）：全部 faship_ 前缀，且 13 个都在（v0.2 加了工单三件套）
const EXPECTED_TOOLS = [
  'faship_status', 'faship_deps', 'faship_videos', 'faship_plan',
  'faship_render', 'faship_review', 'faship_publish', 'faship_job', 'faship_wake',
  'faship_tickets', 'faship_report', 'faship_ticket_action', 'faship_config',
]
if (toolNames.length === 0) fail('一个工具都没注册（ctx.tools.register 没被调用）')
const notFaship = toolNames.filter((n) => !String(n).startsWith('faship_'))
if (notFaship.length) fail(`这些工具没有 faship_ 前缀：${notFaship.join(', ')}`)
const missingTools = EXPECTED_TOOLS.filter((n) => !toolNames.includes(n))
if (missingTools.length) fail(`DESIGN §6 的工具没注册全，缺：${missingTools.join(', ')}`)

// 每个工具的 parameters 必须是 object schema（宿主 defineTool / 本地兜底都应产出这个形状）
let looseSchema = 0
for (const t of registeredTools) {
  const name = t?.name ?? '(无名)'
  const params = t?.parameters ?? t?.inputSchema ?? t?.schema
  if (!params || typeof params !== 'object') { fail(`工具 ${name} 没有参数 schema`); continue }
  if (params.type !== 'object') fail(`工具 ${name} 的 parameters.type 必须是 'object'（现在是 ${JSON.stringify(params.type)}）`)
  if (!params.properties || typeof params.properties !== 'object') fail(`工具 ${name} 的 parameters.properties 必须是对象`)
  if (params.additionalProperties !== false) looseSchema += 1
}
if (looseSchema > 0) {
  // 宿主的 defineTool 也不会补 additionalProperties（实测 dsh-tools 只产出 type/properties/required），
  // 这里只是提醒：工具 execute 自己要能容忍未知参数。
  console.log(`  提醒：${looseSchema} 个工具的 parameters 没写 additionalProperties:false（宿主/本地兜底都不补；execute 需容忍未知参数）`)
}

// 路由（DESIGN §5）：宿主可以注册一条 prefix 路由自己分发，也可以逐条注册 —— 两种都认
if (routePaths.length === 0) fail('一条 HTTP 路由都没注册（设置页会全是 404）')
const badRoutes = routePaths.filter((rp) => !String(rp).startsWith('/dsh-bili-faship/api'))
if (badRoutes.length) fail(`这些路由不在 /dsh-bili-faship/api 下：${badRoutes.join(', ')}`)
if (!routePaths.some((rp) => String(rp) === '/dsh-bili-faship/api' || String(rp).startsWith('/dsh-bili-faship/api'))) {
  fail('没有注册 /dsh-bili-faship/api 路由')
}
// 业务路由由 lib/api.mjs 分发：静态确认九条都在（详细版的断言在 tests/package.test.mjs）
const apiSource = fs.readFileSync(path.join(ROOT, 'lib', 'api.mjs'), 'utf8')
const missingRoutes = ['/settings', '/status', '/videos', '/deps', '/cookie', '/jobs', '/wake', '/report', '/media', '/tickets']
  .filter((p) => !apiSource.includes(`'${p}'`) && !apiSource.includes(`"${p}"`))
if (missingRoutes.length) fail(`lib/api.mjs 里没找到这些 DESIGN §5 路由：${missingRoutes.join(', ')}`)

// 真调一次 API handler：GET /dsh-bili-faship/api/（设置页第一下就是打这个前缀）
const prefixRoute = registeredRoutes.find((r) => r && typeof r.handler === 'function')
if (prefixRoute) {
  const fakeReq = {
    method: 'GET',
    url: '/dsh-bili-faship/api/',
    headers: { host: '127.0.0.1' },
    on() { return this },
    destroy() {},
  }
  const fakeRes = {
    statusCode: 200,
    headers: {},
    body: '',
    ended: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers || {}; return this },
    setHeader() {},
    end(chunk) { if (chunk) this.body += String(chunk); this.ended = true },
    destroy() {},
    on() { return this },
  }
  try {
    await prefixRoute.handler(fakeReq, fakeRes)
  } catch (e) {
    fail('API handler（GET /dsh-bili-faship/api/）抛错 —— 设置页会 500', e)
  }
  if (fakeRes.statusCode !== 200) {
    fail(`API 根路径应回 200，实际 ${fakeRes.statusCode}：${fakeRes.body.slice(0, 200)}`)
  } else {
    let parsed = null
    try { parsed = JSON.parse(fakeRes.body) } catch { /* 下面报错 */ }
    if (!parsed || parsed.ok !== true) fail(`API 根路径没有回 { ok:true }：${fakeRes.body.slice(0, 200)}`)
    else console.log(`  API 冒烟：GET ${'/dsh-bili-faship/api/'} → 200 ${JSON.stringify(parsed).slice(0, 120)}`)
  }
} else {
  fail('注册的路由里没有 handler（或形状不对）——设置页请求会没人接')
}

/* ────────────── ①.5 派工契约：宿主 prompt(request, signal) 必须带 AbortSignal ──────────────
 * v0.2.0 的 P0：漏传 signal → 真实宿主第一行 signal.throwIfAborted() 直接 TypeError，
 * 生物钟/「现在做一条」/工单重试全部 100% 失败，而 161 个单测全绿（mock 只写了一参）。
 * 这里用宿主真实形状的 controller 真走一遍 wakeNow → dispatchTicket → prompt。 */
try {
  const apiMod = await import('./lib/api.mjs')
  const prompts = []
  const strictController = {
    async create({ sessionId } = {}) { return { sessionId } },
    async prompt(request, signal) {
      // 宿主的真实第一行：signal 缺失时抛的就是这个 TypeError（不要改成可选调用）
      if (!(signal instanceof AbortSignal)) throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
      signal.throwIfAborted()
      prompts.push(request)
      return { accepted: true }
    },
  }
  const wakeCtx = {
    get(key) {
      if (key === 'sessionController') return strictController
      if (key === 'connection') return fakeConnection
      return undefined
    },
    tools: {},
    webServer: {},
  }
  const wake = await apiMod.wakeNow(wakeCtx, { manual: true, reason: 'selfcheck 派工契约' })
  if (!wake || wake.ok !== true) fail(`派工契约失败：wakeNow 返回 ${JSON.stringify(wake).slice(0, 400)}`)
  else if (prompts.length !== 1) fail(`派工契约失败：宿主应收到 1 条 prompt，实际 ${prompts.length}`)
  else console.log('  派工契约冒烟：wakeNow → prompt(request, AbortSignal) ✓')
} catch (e) {
  fail('派工契约冒烟抛错（叫醒链路可能又断了）', e)
}

/* ────────────── ② client 半端：假 window.__ModuleLoader__ + 假 react ────────────── */

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const clientPath = path.join(ROOT, 'client.js')

if (!fs.existsSync(clientPath)) {
  fail(`client.js 不存在（设置页整块不会出现）：${clientPath}`)
  finish()
}

// 假 react：factory 里只解构 createElement / useEffect / useRef / useState，够用就行
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  Fragment: 'Fragment',
}

const registrations = []
const fakeWindow = {
  __ModuleLoader__: {
    load(spec) { registrations.push(spec) },
  },
  confirm: () => false, // 危险开关默认 fail-closed
}
const styleNodes = []
const fakeDocument = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', setAttribute() {} }),
  head: { appendChild: (n) => styleNodes.push(n) },
  body: { appendChild: (n) => styleNodes.push(n) },
  documentElement: { appendChild: (n) => styleNodes.push(n) },
  addEventListener: () => {},
  removeEventListener: () => {},
}

// client.js 是「经典脚本」（自注册），不是 ESM：用 Function 包一层比 import 更接近浏览器
const clientSource = fs.readFileSync(clientPath, 'utf8')
try {
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', clientSource)(fakeWindow, fakeDocument)
} catch (e) {
  fail('client.js 一加载就抛错（浏览器里设置页会是一片空白）', e)
  finish()
}

if (registrations.length !== 1) {
  fail(`client.js 应该只调用一次 window.__ModuleLoader__.load({...})，实际 ${registrations.length} 次`)
  finish()
}
const spec = registrations[0]
if (spec?.id !== pkg.name) fail(`client.js 的 id（${spec?.id}）必须等于 package.json 的 name（${pkg.name}）`)
if (typeof spec?.factory !== 'function') {
  fail('client.js 的 load({...}) 里没有 factory 函数')
  finish()
}

let clientMod
try {
  clientMod = spec.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`client.js require 了没预料到的包：${name}（只允许 react）`)
  })
} catch (e) {
  fail('client.js 的 factory(require) 抛错', e)
  finish()
}
if (typeof clientMod?.apply !== 'function') fail('client.js 的 factory 必须返回带 apply(ctx) 的对象')
if (!Array.isArray(clientMod?.inject)) fail('client.js 没有导出 inject 数组')
else if (!clientMod.inject.includes('slots')) fail(`client.js 的 inject 必须包含 'slots'（现在是 ${JSON.stringify(clientMod.inject)}）`)

// 真调一次 apply（假 slots），把拼错的 slot 名 / 漏掉的 ctx 方法都逼出来
const slotsReg = []
const clientCtx = {
  effect: (fn) => {
    try {
      const ret = fn()
      if (typeof ret === 'function') disposers.push(ret)
    } catch (e) { fail('client.js 的 ctx.effect(fn) 抛错', e) }
  },
  slots: {
    inject: (name, fn) => { try { fn() } catch (e) { fail('client.js 的 slots.inject 回调抛错', e) } },
    register: (opts, Component) => { slotsReg.push({ ...opts, hasComponent: typeof Component === 'function' }); return {} },
  },
}
if (typeof clientMod?.apply === 'function') {
  try {
    await clientMod.apply(clientCtx)
  } catch (e) {
    fail('client.js 的 apply(ctx) 抛错（设置页会挂不上）', e)
  }
}

const section = slotsReg.find((s) => s.name === 'settings.section')
if (!slotsReg.length) fail('client.js 的 apply 没有往任何 slot 注册组件')
if (!section) fail("client.js 没有注册到 'settings.section' slot")
else {
  // DESIGN §8：slot 注册的 id 是插件入口 id `bili-faship`（不是 npm 包名；包名由 __ModuleLoader__ 的 id 保证）
  if (section.id !== 'bili-faship') fail(`settings.section 的 id 应该是 'bili-faship'（现在是 ${section.id}）`)
  if (!section.hasComponent) fail('settings.section 注册时没带组件函数（页面会是空的）')
  if (Number(section.order) !== 7) fail(`settings.section 的 order 应该是 7（现在是 ${section.order}）`)
  const label = typeof section.label === 'function' ? section.label() : section.label
  if (label !== '视频工坊') fail(`settings.section 的 label 应该是「视频工坊」（现在是 ${JSON.stringify(label)}）`)
}

const fieldCount = Array.isArray(clientMod?.FIELDS) ? clientMod.FIELDS.length : null

console.log(`\n✓ client 半端：id=${spec.id}  inject=${JSON.stringify(clientMod?.inject ?? null)}`)
for (const s of slotsReg) {
  console.log(`  slot ${s.name}  id=${s.id}  order=${s.order}  组件=${s.hasComponent ? '有' : '无 ✗'}`)
}
console.log(`  设置项 FIELDS：${fieldCount === null ? '（没导出，跳过）' : `${fieldCount} 个`}`)
console.log(`  样式注入：${styleNodes.length} 个 <style>（渲染时注入；这里不渲染组件，0 也正常）`)

finish()
