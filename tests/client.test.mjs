/**
 * dsh-bili-faship —— 设置页 client.js 的单测
 * ============================================================================
 * 不依赖真实 DSH、不联网、不碰 DOM：用假 `window.__ModuleLoader__` + 假 `require('react')`
 * （最简单的 createElement / hooks stub）把 client.js 当普通脚本跑一遍，验证：
 *
 *   1. 自注册头：id 与 package.json 的包名一致，factory 只注册一次；
 *   2. 导出 `inject = ['slots']`、`apply(ctx)`、Section、FIELDS；
 *   3. apply 在假 ctx 上**不抛错**，且注册的是 `settings.section`
 *      （name/id/order=7/label()==='视频工坊'）；
 *   4. FIELDS 形状合法、无重复，且**覆盖 DESIGN §4 的全部配置项**；
 *   5. 危险开关 autoPublish.allowGo：默认关、danger 标记、必须有 confirm 文案；
 *      没有 confirm 环境时 fail-closed（拒绝）；源码里不存在「无确认真发」入口；
 *   6. 红线 redlines.* 只读展示；bannedWords 可编辑；
 *   7. HTTP 助手 asJson：res.ok / {ok:false} / 无 body 三种失败都抛错（不静默成功）；
 *   8. 保存体是整份 { config }；路径工具、list 解析、/media URL、状态卡/视频列表渲染；
 *   9. 样式契约：只注入一个 <style>、类名 bf- 前缀、颜色只用 --dsw-alias-*；
 *  10. 客户端只走 DESIGN §5 的路由。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT_PATH = path.join(ROOT, 'client.js')
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8')

// ── 假 React：只要够 factory / Section / FieldRow 跑起来就行 ──────────────
function makeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(init) {
      return [typeof init === 'function' ? init() : init, () => {}]
    },
    useEffect() { /* 测试里不跑副作用 */ },
    useRef(value) { return { current: value } },
  }
}

/**
 * 用假 window/document 在 vm 之外把 client.js 当脚本跑（它本来就是自注册脚本）。
 * @param {{confirm?: (msg: string) => boolean, react?: object}} [opts]
 */
function loadPlugin(opts = {}) {
  const registered = []
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) { registered.push(spec) },
    },
  }
  if (opts.confirm) fakeWindow.confirm = opts.confirm
  const fakeDocument = {
    getElementById() { return null },
    createElement() { return { textContent: '' } },
    head: { appendChild() {} },
  }
  const React = opts.react || makeReact()
  const run = new Function('window', 'document', SOURCE)
  run(fakeWindow, fakeDocument)

  assert.equal(registered.length, 1, 'factory 应该只注册一次')
  const spec = registered[0]
  assert.equal(typeof spec.factory, 'function', 'spec.factory 必须是函数')
  const mod = spec.factory((name) => {
    assert.equal(name, 'react', 'client 只允许 require("react")')
    return React
  })
  return { spec, mod, window: fakeWindow }
}

const PLUGIN = loadPlugin()
const MOD = PLUGIN.mod
const I = MOD.__internals

const fieldKey = (f) => f.path.map(String).join('.')

// ── 元素树小工具（配合假 createElement）───────────────────────────────────
function walk(node, out = []) {
  if (node == null || node === false || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out)
    return out
  }
  if ('type' in node) {
    out.push(node)
    for (const c of node.children) walk(c, out)
  }
  return out
}
function textOf(node) {
  let s = ''
  const add = (n) => {
    if (n == null || n === false) return
    if (typeof n === 'string' || typeof n === 'number') { s += String(n); return }
    if (Array.isArray(n)) { n.forEach(add); return }
    if (n && typeof n === 'object' && 'type' in n) n.children.forEach(add)
  }
  add(node)
  return s
}
const nodesOfType = (node, type) => walk(node).filter((n) => n.type === type)

/**
 * 假 React 不做真实渲染：把「函数组件」就地展开成它返回的元素树，
 * 这样断言 VideosBlock 里的 VideoCard / ReviewBox 时能看到 DOM 描述。
 * （被展开的组件都是无状态纯组件；有 hooks 的 FieldRow 在专项测试里直接调用。）
 */
function expand(node) {
  if (node == null || node === false || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  if (!('type' in node)) return node
  if (typeof node.type === 'function') return expand(node.type(node.props || {}))
  return { type: node.type, props: node.props, children: node.children.map(expand) }
}

const sampleValue = (f) => {
  switch (f.kind) {
    case 'switch': return true
    case 'number': return f.min == null ? 1 : f.min
    case 'range': return f.min == null ? 0 : f.min
    case 'select': return (f.options || [])[0]
    case 'list': return ['a', 'b']
    default: return 'x'
  }
}

// ════════════════════════════════════════════════════════════════════════
// 1. 自注册 / 导出
// ════════════════════════════════════════════════════════════════════════
test('自注册：window.__ModuleLoader__.load id 与 package.json 包名一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(PLUGIN.spec.id, 'dsh-bili-faship')
  assert.equal(PLUGIN.spec.id, pkg.name, 'id 必须等于 package.json 的 name')
})

test('导出 inject / apply / Section / FIELDS', () => {
  assert.deepEqual(MOD.inject, ['slots'])
  assert.equal(typeof MOD.apply, 'function')
  assert.equal(typeof MOD.Section, 'function')
  assert.ok(Array.isArray(MOD.FIELDS))
  assert.ok(Array.isArray(MOD.GROUP_ORDER))
  assert.equal(MOD.API, '/dsh-bili-faship/api', 'API base 必须是 DESIGN §5 的路径')
})

// ════════════════════════════════════════════════════════════════════════
// 2. apply：假 ctx 上注册 settings.section（不抛错）
// ════════════════════════════════════════════════════════════════════════
test('apply 在假 ctx 上不抛错，注册 settings.section（order=7 / label=视频工坊）', () => {
  const calls = []
  let captured = null
  const ctx = {
    effect(fn) {
      calls.push('effect')
      assert.equal(typeof fn, 'function')
      fn()
    },
    slots: {
      inject(name, fn) {
        calls.push('inject:' + name)
        assert.equal(typeof fn, 'function')
        return fn()
      },
      register(spec, component) {
        calls.push('register')
        captured = { spec, component }
        return () => {}
      },
    },
  }
  assert.doesNotThrow(() => MOD.apply(ctx))
  assert.deepEqual(calls, ['effect', 'inject:settings.section', 'register'])
  assert.equal(captured.spec.name, 'settings.section')
  assert.equal(captured.spec.id, 'bili-faship')
  assert.equal(captured.spec.order, 7)
  assert.equal(typeof captured.spec.label, 'function')
  assert.equal(captured.spec.label(), '视频工坊')
  assert.equal(typeof captured.component, 'function')
})

// ════════════════════════════════════════════════════════════════════════
// 3. FIELDS：形状 + 覆盖 DESIGN §4
// ════════════════════════════════════════════════════════════════════════
const KINDS = new Set(['text', 'number', 'switch', 'select', 'list', 'range'])

test('FIELDS 每项形状合法、path 唯一、分组都在 GROUP_ORDER 里', () => {
  const seen = new Set()
  for (const f of MOD.FIELDS) {
    assert.equal(typeof f.group, 'string', 'FIELDS 项必须有 group')
    assert.ok(MOD.GROUP_ORDER.includes(f.group), '未知分组会兜底但仍要显式登记：' + f.group)
    assert.ok(Array.isArray(f.path) && f.path.length >= 1, 'path 必须是非空数组')
    assert.equal(typeof f.label, 'string')
    assert.ok(KINDS.has(f.kind), '未知 kind：' + f.kind)
    const k = fieldKey(f)
    assert.ok(!seen.has(k), '重复字段：' + k)
    seen.add(k)
    if (f.kind === 'select') assert.ok(Array.isArray(f.options) && f.options.length >= 1, k + ' 的 select 必须有 options')
    if (f.kind === 'range' || f.kind === 'number') {
      assert.equal(typeof f.min, 'number', k + ' 缺 min')
      assert.equal(typeof f.max, 'number', k + ' 缺 max')
    }
  }
})

/** DESIGN §4 `video` 段的全部配置项（默认值键路径）。 */
const DESIGN_SECTION4_KEYS = [
  'enabled',
  'outDir',
  'cadenceDays',
  'minDurationSec',
  'maxDurationSec',
  'voice.voice',
  'voice.rate',
  'voice.pitch',
  'selfReview.passScore',
  'selfReview.minSubtitleCoverage',
  'selfReview.loudnessRange.0',
  'selfReview.loudnessRange.1',
  'selfReview.requireAiLabel',
  'selfReview.maxClipSec',
  'publish.enabled',
  'publish.profile',
  'publish.tid',
  'publish.partitionName',
  'publish.copyright',
  'publish.noReprint',
  'publish.tags',
  'publish.titlePrefix',
  'redlines.requireAiLabel',
  'redlines.forbidImpersonation',
  'redlines.forbidSpam',
  'redlines.forbidUncreditedClips',
  'redlines.bannedWords',
  'persona.name',
  'persona.ownerTitle',
  'persona.selfClaim',
  'materials.diary',
  'materials.extraNotes',
  'paths.stickers',
  'paths.cache',
  'paths.python',
  'paths.ffmpeg',
  'schedule.enabled',
  'schedule.window.start',
  'schedule.window.end',
  'schedule.cooldownHours',
  'autoPublish.dryRun',
  'autoPublish.allowGo',
]

test('FIELDS 覆盖 DESIGN §4 的生效配置项（' + DESIGN_SECTION4_KEYS.length + ' 项）；死开关不得再出现', () => {
  // v0.2.0 有 7 个「有 UI、无人消费」的死设置；0.2.1 删掉/改只读，这里锁住防回归
  const DEAD_KEYS = ['selfReview.enabled', 'selfReview.requireRedlineCard', 'publish.dryRunByDefault', 'publish.selfApprove', 'schedule.minGapMinutes']
  const liveKeys = new Set(MOD.FIELDS.map(fieldKey))
  for (const k of DEAD_KEYS) assert.equal(liveKeys.has(k), false, '死设置又回到设置页了：' + k)
  const byKey = new Map(MOD.FIELDS.map((f) => [fieldKey(f), f]))
  assert.equal(byKey.get('publish.copyright').readOnly, true, '版权类型应只读（固定自制）')
  assert.equal(byKey.get('selfReview.requireAiLabel').readOnly, true, 'AI 标注自审开关应只读（红线）')
  // 允许真发徽标必须读已保存配置（静态可检查：不再直接用 cfg 的 allowGo）
  assert.ok(!/const allowGoNow = Boolean\\(getPath\\(cfg, \\['autoPublish', 'allowGo'\\]\\)\\)/.test(SOURCE), 'allowGo 徽标不能读未保存草稿')
})
test('FIELDS 覆盖 DESIGN §4 的全部配置项', () => {
  const keys = new Set(MOD.FIELDS.map(fieldKey))
  const missing = DESIGN_SECTION4_KEYS.filter((k) => !keys.has(k))
  assert.deepEqual(missing, [], 'DESIGN §4 里这些配置项没出现在设置页：' + missing.join(', '))
})

test('FIELDS 覆盖任务的界面分区：节奏 / 工单与看门狗 / 发布与红线 / 自审 / 声音 / 渲染与路径 / 人物与素材', () => {
  assert.deepEqual(MOD.GROUP_ORDER.slice(),
    ['节奏', '工单与看门狗', '发布与红线', '自审', '声音', '渲染与路径', '人物与素材'])
  const groups = new Set(MOD.FIELDS.map((f) => f.group))
  for (const g of MOD.GROUP_ORDER) assert.ok(groups.has(g), '分组里一个字段都没有：' + g)
})

/** DESIGN §10.9 的 v0.2 配置增量（7 项，path 严格一致）。 */
const DESIGN_TICKET_CONFIG_KEYS = [
  'tickets.maxPerDay',
  'worker.sessionMode',
  'admission.observeOnly',
  'worker.autoRetry.enabled',
  'worker.autoRetry.maxAttempts',
  'watchdog.enabled',
  'watchdog.maxJobMinutes',
]

test('v0.2 FIELDS：§10.9 的 7 条新配置路径齐全、分组/形状正确', () => {
  const byKey = new Map(MOD.FIELDS.map((f) => [fieldKey(f), f]))
  const missing = DESIGN_TICKET_CONFIG_KEYS.filter((k) => !byKey.has(k))
  assert.deepEqual(missing, [], '缺 v0.2 配置项：' + missing.join(', '))

  // 前三个进「节奏」，后四个在新组「工单与看门狗」（task-4 要求）
  const rhythm = ['tickets.maxPerDay', 'worker.sessionMode', 'admission.observeOnly']
  for (const k of rhythm) assert.equal(byKey.get(k).group, '节奏', k + ' 应在「节奏」组')
  for (const k of DESIGN_TICKET_CONFIG_KEYS.slice(3)) {
    assert.equal(byKey.get(k).group, '工单与看门狗', k + ' 应在「工单与看门狗」组')
  }

  assert.equal(byKey.get('tickets.maxPerDay').kind, 'number')
  assert.equal(byKey.get('tickets.maxPerDay').min, 1)
  assert.equal(byKey.get('tickets.maxPerDay').max, 10)
  assert.equal(byKey.get('worker.sessionMode').kind, 'select')
  assert.deepEqual(byKey.get('worker.sessionMode').options, ['per-ticket', 'persistent'])
  assert.equal(byKey.get('admission.observeOnly').kind, 'switch')
  assert.ok(/选题|storyboard|不渲染/.test(byKey.get('admission.observeOnly').hint), 'observeOnly 的 hint 要说明只观察')
  assert.equal(byKey.get('worker.autoRetry.enabled').kind, 'switch')
  assert.equal(byKey.get('worker.autoRetry.maxAttempts').min, 0)
  assert.equal(byKey.get('worker.autoRetry.maxAttempts').max, 5)
  assert.equal(byKey.get('watchdog.enabled').kind, 'switch')
  assert.equal(byKey.get('watchdog.maxJobMinutes').min, 5)
  assert.equal(byKey.get('watchdog.maxJobMinutes').max, 240)
})

// ════════════════════════════════════════════════════════════════════════
// 4. 危险开关 / 红线只读 / 无「无确认真发」入口
// ════════════════════════════════════════════════════════════════════════
test('autoPublish.allowGo：switch + danger + 必须带 confirm 文案（打开前二次确认）', () => {
  const f = MOD.FIELDS.filter((x) => fieldKey(x) === 'autoPublish.allowGo')[0]
  assert.ok(f, '缺 autoPublish.allowGo 字段')
  assert.equal(f.kind, 'switch')
  assert.equal(f.danger, true, 'allowGo 必须标记 danger')
  assert.equal(typeof f.confirm, 'string')
  assert.ok(f.confirm.length >= 30, 'confirm 文案要写清楚后果')
  assert.ok(/B\s*站|投稿/.test(f.confirm), 'confirm 文案必须说明会真投稿')
})

test('没有 confirm 环境时 askConfirm fail-closed（拒绝），有 confirm 时才放行', () => {
  assert.equal(I.askConfirm('危险操作'), false, '拿不到 window.confirm 时必须拒绝')
  const allowed = loadPlugin({ confirm: () => true })
  assert.equal(allowed.mod.__internals.askConfirm('危险操作'), true)
  const denied = loadPlugin({ confirm: () => false })
  assert.equal(denied.mod.__internals.askConfirm('危险操作'), false)
})

test('设置页不存在「无确认真发」入口（源码里没有真发动作 / publish-go 调用）', () => {
  assert.equal(SOURCE.includes('publish-go'), false, 'client 不该出现真发动作（真发只能走工具/受控 API）')
  assert.equal(SOURCE.includes("'go'"), false, 'client 不该提交 mode=go')
  // 只允许 dry 投稿包动作
  assert.ok(SOURCE.includes("'publish-dry'"), '应只有 dry 投稿包动作')
})

test('红线 redlines.* 只读展示；bannedWords 可编辑', () => {
  const red = MOD.FIELDS.filter((f) => f.path[0] === 'redlines' && f.path.length === 2)
  assert.ok(red.length >= 4, 'redlines 至少 4 个红线开关')
  for (const f of red.filter((x) => x.kind === 'switch')) {
    assert.equal(f.readOnly, true, '红线开关必须只读：' + fieldKey(f))
  }
  const banned = MOD.FIELDS.filter((f) => fieldKey(f) === 'redlines.bannedWords')[0]
  assert.ok(banned, '缺 bannedWords')
  assert.equal(banned.kind, 'list')
  assert.notEqual(banned.readOnly, true, 'bannedWords 允许追加，不该只读')
})

// ════════════════════════════════════════════════════════════════════════
// 5. HTTP 助手：失败必须抛错（不静默成功）
// ════════════════════════════════════════════════════════════════════════
test('asJson：HTTP 非 2xx 抛错（带状态码与 body.error / errors 数组）', async () => {
  await assert.rejects(
    () => I.asJson({ ok: false, status: 400, json: async () => ({ ok: false, error: 'cadenceDays 越界' }) }),
    /cadenceDays 越界（HTTP 400）/,
  )
  await assert.rejects(
    () => I.asJson({ ok: false, status: 403, json: async () => { throw new Error('no body') } }),
    /HTTP 403/,
  )
  await assert.rejects(
    () => I.asJson({ ok: false, status: 409, json: async () => null }),
    /HTTP 409/,
  )
  // POST /settings 校验失败回 { ok:false, errors:[...] }（没有 error 字段）⇒ 必须把每条都显示出来
  const err = await I.asJson({
    ok: false,
    status: 400,
    json: async () => ({ ok: false, errors: ['cadenceDays 越界', 'publish.tid 必须是整数'] }),
  }).catch((e) => e)
  assert.ok(err instanceof Error)
  assert.match(err.message, /cadenceDays 越界/)
  assert.match(err.message, /publish\.tid 必须是整数/)
})

test('asJson：200 但 {ok:false} 也抛错；正常返回原 payload', async () => {
  await assert.rejects(
    () => I.asJson({ ok: true, status: 200, json: async () => ({ ok: false, error: '宿主说不行' }) }),
    /宿主说不行/,
  )
  const payload = { ok: true, config: { enabled: true } }
  const got = await I.asJson({ ok: true, status: 200, json: async () => payload })
  assert.equal(got, payload)
})

test('保存体是整份 { config }（不是增量 patch），未显示字段原样保留', () => {
  const loaded = {
    enabled: true,
    voice: { voice: 'zh-CN-XiaoyiNeural' },
    // 设置页没显示的字段也必须跟着整份提交，不能被抹掉
    __unknownFromFutureHost: { keep: 'me' },
  }
  const edited = JSON.parse(JSON.stringify(loaded))
  edited.voice.rate = '+10%'
  const body = I.saveBody(edited)
  assert.deepEqual(Object.keys(body), ['config'])
  assert.equal(body.config, edited, 'config 必须原样引用整份配置')
  assert.deepEqual(body.config.__unknownFromFutureHost, { keep: 'me' })
})

test('postSave：真的发 POST /settings，body 是整份 { config }', async () => {
  const calls = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true, config: { enabled: true }, warnings: [] }) }
  }
  try {
    const cfg = { enabled: true, voice: { rate: '+8%' }, __unshown: { keep: 1 } }
    const r = await I.postSave(cfg)
    assert.deepEqual(r, { ok: true, config: { enabled: true }, warnings: [] })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/dsh-bili-faship/api/settings')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.credentials, 'same-origin')
    const body = JSON.parse(calls[0].init.body)
    assert.deepEqual(Object.keys(body), ['config'])
    assert.equal(body.config.__unshown.keep, 1, '未显示的字段也要跟着整份提交')
  } finally {
    globalThis.fetch = origFetch
  }
})

// ════════════════════════════════════════════════════════════════════════
// 6. 纯函数：路径 / list / media / 状态文案
// ════════════════════════════════════════════════════════════════════════
test('getPath / setPath：嵌套读写 + 数组下标（loudnessRange[0]）', () => {
  assert.equal(I.getPath({ voice: { rate: '+8%' } }, ['voice', 'rate']), '+8%')
  assert.equal(I.getPath({}, ['voice', 'rate']), undefined)

  const c = { selfReview: { loudnessRange: [-20, -12] } }
  I.setPath(c, ['selfReview', 'loudnessRange', 0], -18)
  assert.deepEqual(c.selfReview.loudnessRange, [-18, -12])

  const created = {}
  I.setPath(created, ['selfReview', 'loudnessRange', 1], -9)
  assert.ok(Array.isArray(created.selfReview.loudnessRange), '数值下标应自动建数组')
  assert.equal(created.selfReview.loudnessRange.length, 2)
  assert.equal(created.selfReview.loudnessRange[1], -9)

  I.setPath(created, ['publish', 'tags'], ['a'])
  assert.deepEqual(created.publish, { tags: ['a'] })
})

test('parseList / listToText：中英文逗号、空白、末尾逗号都不会出空项', () => {
  assert.deepEqual(I.parseList('a，b, c ,,  '), ['a', 'b', 'c'])
  assert.deepEqual(I.parseList(''), [])
  assert.deepEqual(I.parseList(null), [])
  assert.equal(I.listToText(['生活', '日常']), '生活，日常')
  assert.equal(I.listToText(undefined), '')
})

test('mediaUrl：dir 优先用绝对目录（也支持 slug），file 白名单由宿主再校验', () => {
  // /videos 的 dir 是绝对路径 ⇒ 优先用它，避免 story.slug 与目录名不一致时读不到文件
  assert.equal(
    I.mediaUrl({ slug: 's1', dir: 'C:/videos/s1' }, 'cover.jpg'),
    '/dsh-bili-faship/api/media?dir=C%3A%2Fvideos%2Fs1&file=cover.jpg',
  )
  assert.equal(I.mediaUrl({ slug: 's1' }, 'video.mp4'), '/dsh-bili-faship/api/media?dir=s1&file=video.mp4')
  assert.equal(I.mediaUrl({ slug: 'a b' }, 'review.json'), '/dsh-bili-faship/api/media?dir=a%20b&file=review.json')
  assert.equal(I.mediaUrl(null, 'storyboard.json'), '/dsh-bili-faship/api/media?dir=&file=storyboard.json')
})

test('bvUrl：只把合法 BV 号变成链接（不信任任意字符串）', () => {
  assert.equal(I.bvUrl('BV1xx411c7mD'), 'https://www.bilibili.com/video/BV1xx411c7mD')
  assert.equal(I.bvUrl('javascript:alert(1)'), '')
  assert.equal(I.bvUrl(''), '')
  assert.equal(I.bvUrl(null), '')
})

test('scheduleReason / indexStateText / jobLabel：都有中文解释，未知值原样显示', () => {
  assert.equal(I.scheduleReason('due'), '到点了')
  assert.equal(I.scheduleReason('out-of-window'), '不在叫醒窗口内')
  assert.equal(I.scheduleReason('cooldown'), '叫醒冷却中')
  assert.equal(I.scheduleReason('schedule-off'), '生物钟关着')
  assert.equal(I.scheduleReason('already-woke-today'), '今天已经叫醒过')
  assert.equal(I.scheduleReason('job-running'), '有任务在跑')
  assert.equal(I.scheduleReason('something-new'), 'something-new')
  assert.equal(I.indexStateText('ok'), '正常')
  assert.equal(I.indexStateText('missing'), '缺失')
  assert.equal(I.indexStateText('error'), '损坏')
  assert.equal(I.jobLabel('render'), '渲染')
  assert.equal(I.jobLabel('publish-dry'), 'dry 投稿包')
})

// ════════════════════════════════════════════════════════════════════════
// 6.5 v0.2 工单 / 待你处理 / 准入（DESIGN §10）
// ════════════════════════════════════════════════════════════════════════
test('AttentionBlock：为空时整块不渲染（null）；非空渲染中文 kind + 重试/我知道了', () => {
  assert.equal(I.AttentionBlock({ attention: [], busy: '', onAction() {} }), null)
  assert.equal(I.AttentionBlock({ attention: null, busy: '', onAction() {} }), null)

  const calls = []
  const now = new Date().toISOString()
  const el = I.AttentionBlock({
    attention: [
      {
        ticketId: 'tk-1', short: 'day3-a', title: '第三天：站在中间', kind: 'rate-limited',
        detail: '任务日志出现 601：B站要求人工验证。', since: now, actions: ['retry', 'ack'],
      },
      {
        ticketId: 'tk-2', short: 'day4-b', title: '第四天：换气', kind: 'review-failed',
        detail: '自审未过（ai_label）', since: null, actions: ['ack'],
      },
      {
        ticketId: 'tk-3', short: 'day5-c', title: '第五天：投稿', kind: 'publish-failed',
        detail: '后台投稿失败：网络超时', since: now, actions: ['ack', 'stop'],
      },
    ],
    busy: '',
    onAction: (id, action, label) => calls.push([id, action, label]),
  })
  const text = textOf(el)
  assert.ok(text.includes('待你处理（3）'))
  assert.ok(text.includes('B站风控待人工'), 'rate-limited 要显示中文')
  assert.ok(text.includes('自审未过'), 'review-failed 要显示中文')
  assert.ok(text.includes('投稿失败'), 'publish-failed 要显示中文')
  assert.ok(text.includes('第三天：站在中间'))
  assert.ok(text.includes('自 刚刚') || text.includes('自 '), 'since 要有时间提示')
  const buttons = nodesOfType(el, 'button')
  const labels = buttons.map((n) => textOf(n))
  assert.ok(labels.includes('重试'))
  assert.ok(labels.includes('我知道了'))
  // 第一条点「重试」→ 回调带上 ticketId / action / label
  buttons[labels.indexOf('重试')].props.onClick()
  assert.deepEqual(calls[0], ['tk-1', 'retry', '重试'])
  // 第三条 host actions=['ack','stop']：待你处理区只给 ack —— stop 只在工单行（task-4 要求）
  const rows = walk(el).filter((n) => n.type === 'div' && n.props.className === 'bf-attn-item')
  assert.equal(rows.length, 3)
  const row3Buttons = nodesOfType(rows[2], 'button').map((n) => textOf(n))
  assert.ok(row3Buttons.includes('我知道了'))
  assert.ok(!row3Buttons.includes('停止'), '「待你处理」里不提供 stop（只在工单行提供）')
})

test('工单阶段中文映射：person/review→等你审阅、working/running→制作中、done/published→已发布', () => {
  assert.ok(I.ticketStageLabel({ stage: 'person/review' }).includes('等你审阅'))
  assert.equal(I.ticketStageLabel({ stage: 'working/running' }), '制作中')
  assert.equal(I.ticketStageLabel({ stage: 'done/published' }), '已发布')
  assert.equal(I.ticketStageLabel({ stage: 'person/failed' }).includes('失败'), true)
  assert.equal(I.ticketStageTone({ stage: 'person/review' }), 'warn')
  assert.equal(I.ticketStageTone({ stage: 'working/running' }), 'info')
  assert.equal(I.ticketStageTone({ stage: 'idle' }), 'muted')
  assert.equal(I.ticketStageTone({ stage: 'done/published' }), 'good')
  assert.equal(I.ticketStageTone({ stage: 'done/failed' }), 'bad')
  // host 给了 stageLabel 就以 host 为准（客户端只显示，不自己判断阶段）
  assert.equal(I.ticketStageLabel({ stage: 'person/review', stageLabel: '待你定稿' }), '待你定稿')
  // 未知阶段原样显示，不猜
  assert.equal(I.ticketStageLabel({ stage: 'something/new' }), 'something/new')
  assert.equal(I.isOpenTicket({ stage: 'working/running' }), true)
  assert.equal(I.isOpenTicket({ stage: 'person/review' }), true)
  assert.equal(I.isOpenTicket({ stage: 'done/published' }), false)
})

test('准入原因 / 决定中文映射（§10.3 的代码）', () => {
  assert.equal(I.admissionReasonText('accept'), '可以开始')
  assert.equal(I.admissionReasonText('due'), '到期可做')
  assert.equal(I.admissionReasonText('not-due'), '没到期')
  assert.equal(I.admissionReasonText('out-of-window'), '不在窗口')
  assert.equal(I.admissionReasonText('cooldown'), '冷却中')
  assert.equal(I.admissionReasonText('daily-limit'), '今日额度用完')
  assert.equal(I.admissionReasonText('job-running'), '有任务在跑')
  assert.equal(I.admissionReasonText('ticket-working'), '工单进行中')
  assert.equal(I.admissionReasonText('index-corrupt'), '投稿索引损坏')
  assert.equal(I.admissionReasonText('weird-code'), 'weird-code')
  assert.equal(I.admissionDecisionText('accept'), '接受')
  assert.equal(I.admissionDecisionText('reject'), '拒绝')
})

test('postTicketAction：POST /tickets body={id,action}，失败抛错（不静默）', async () => {
  const calls = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true, ticket: { id: 'tk-1' } }) }
  }
  try {
    const r = await I.postTicketAction('tk-1', 'retry')
    assert.deepEqual(r, { ok: true, ticket: { id: 'tk-1' } })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/dsh-bili-faship/api/tickets')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.credentials, 'same-origin')
    assert.deepEqual(JSON.parse(calls[0].init.body), { id: 'tk-1', action: 'retry' })
  } finally {
    globalThis.fetch = origFetch
  }

  // 失败（400 + {ok:false,error}）必须抛错 —— UI 会显示出来
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: '工单已结束' }) })
  try {
    await assert.rejects(() => I.postTicketAction('tk-1', 'ack'), /工单已结束（HTTP 400）/)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('TicketsBlock：阶段标签/尝试次数/目录/折叠时间线/行内重试与停止', () => {
  const now = new Date().toISOString()
  const tickets = {
    ok: true,
    policyVersion: '0.2.0',
    tickets: [
      {
        id: 'tk-1', short: 'day3-a', title: '第三天：站在中间', dir: 'C:/videos/day3-a',
        stage: 'working/running', attempts: 2, createdAt: now, updatedAt: now, endedAt: null,
        events: [
          { at: now, type: 'dispatched', detail: 'session=bili-faship-day3-a' },
          { at: now, type: 'report', detail: 'progress' },
        ],
        attention: [], report: { status: 'progress' }, outcome: null,
      },
      {
        id: 'tk-2', short: 'day2-b', title: '第二天：吃鱼', dir: 'C:/videos/day2-b',
        stage: 'done/published', attempts: 1, createdAt: now, updatedAt: now, endedAt: now,
        events: [], attention: [], report: null, outcome: { kind: 'published', at: now },
      },
    ],
    attention: [],
    admission: { todayCount: 1, maxPerDay: 2, last: null, recent: [] },
  }
  const calls = []
  const el = expand(I.TicketsBlock({
    tickets,
    busy: '',
    openIds: { 'tk-1': true },
    listOpen: true,
    onToggleList() {},
    onToggleEvents: (id) => calls.push(['events', id]),
    onAction: (id, action) => calls.push([id, action]),
  }))
  const text = textOf(el)
  assert.ok(text.includes('工单（最近 2 条）'))
  assert.ok(text.includes('policy 0.2.0'))
  assert.ok(text.includes('制作中'))
  assert.ok(text.includes('已发布'))
  assert.ok(text.includes('第 2 次'), '应显示尝试次数')
  assert.ok(text.includes('C:/videos/day3-a'))
  assert.ok(text.includes('dispatched'), '展开的工单要显示时间线事件')
  assert.ok(text.includes('收起时间线'))

  const rows = walk(el).filter((n) => n.type === 'div' && n.props.className === 'bf-ticket')
  assert.equal(rows.length, 2)
  const openButtons = nodesOfType(rows[0], 'button').map((n) => textOf(n))
  assert.ok(openButtons.includes('重试'))
  assert.ok(openButtons.includes('停止'))
  const doneButtons = nodesOfType(rows[1], 'button').map((n) => textOf(n))
  assert.ok(!doneButtons.includes('重试'), '已结束工单不该有重试')
  assert.ok(!doneButtons.includes('停止'), '已结束工单不该有停止')

  // 点「停止」→ 回调 (id, 'stop')；点「时间线」→ 回调 toggle
  nodesOfType(rows[0], 'button').filter((n) => textOf(n) === '停止')[0].props.onClick()
  assert.deepEqual(calls[0], ['tk-1', 'stop'])

  // 整块折叠时不渲染工单行
  const collapsed = expand(I.TicketsBlock({
    tickets, busy: '', openIds: {}, listOpen: false,
    onToggleList() {}, onToggleEvents() {}, onAction() {},
  }))
  assert.ok(textOf(collapsed).includes('展开工单列表'))
  assert.ok(!textOf(collapsed).includes('制作中'))
})

// ════════════════════════════════════════════════════════════════════════
// 7. 组件冒烟（不跑副作用；只验证渲染不抛错、关键内容在）
// ════════════════════════════════════════════════════════════════════════
test('FieldRow：六种 kind 都能渲染（含 range/select/list/switch/只读）', () => {
  for (const f of MOD.FIELDS) {
    const el = I.FieldRow({
      f,
      value: sampleValue(f),
      readOnly: Boolean(f.readOnly),
      onChange() {},
    })
    assert.ok(el && typeof el === 'object' && el.type, 'FieldRow 渲染失败：' + fieldKey(f))
    assert.equal(typeof textOf(el), 'string')
  }
})

test('Section：还没读到配置时显示「读取配置中…」且不抛错', () => {
  let el = null
  assert.doesNotThrow(() => { el = MOD.Section() })
  assert.ok(el && el.type)
  assert.ok((textOf(el) || '').includes('读取配置中'))
})

/** 队列式假 React：按调用顺序给 useState 喂初始值（模拟「配置已经读回来了」的已加载状态）。 */
function makeReactWithState(initials) {
  let i = 0
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(init) {
      if (i < initials.length) { const v = initials[i]; i += 1; return [v, () => {}] }
      return [typeof init === 'function' ? init() : init, () => {}]
    },
    useEffect() { /* 测试里不跑副作用，不 fetch */ },
    useRef(value) { return { current: value } },
  }
}

test('Section：配置读回来后完整渲染（状态卡/全部分组/凭据/视频列表/按钮），不抛错', () => {
  const now = new Date().toISOString()
  const cfg = {
    enabled: true,
    outDir: '',
    cadenceDays: 3,
    minDurationSec: 15,
    maxDurationSec: 180,
    voice: { voice: 'zh-CN-XiaoyiNeural', rate: '+8%', pitch: '+8Hz' },
    selfReview: { enabled: true, passScore: 80, minSubtitleCoverage: 0.9, loudnessRange: [-20, -12], requireAiLabel: true, requireRedlineCard: false, maxClipSec: 3 },
    publish: { enabled: true, dryRunByDefault: true, selfApprove: true, profile: 'ugcfx/bup', tid: 138, partitionName: '生活·日常', copyright: 1, noReprint: true, tags: ['AI生成'], titlePrefix: '' },
    redlines: { requireAiLabel: true, forbidImpersonation: true, forbidSpam: true, forbidUncreditedClips: true, bannedWords: ['刷量'] },
    persona: { name: '大肥鱼', ownerTitle: '主人', selfClaim: '我' },
    materials: { diary: ['D:/diary.md'], extraNotes: [] },
    paths: { stickers: '', cache: '', python: '', ffmpeg: '' },
    schedule: { enabled: true, window: { start: '21:00', end: '23:30' }, minGapMinutes: 10, cooldownHours: 30 },
    autoPublish: { dryRun: true, allowGo: true },   // 故意打开，验证危险横幅
  }
  const react = makeReactWithState([
    cfg,                                    // cfg
    JSON.stringify(cfg),                    // savedJson（与 cfg 相同 ⇒ 无脏标记）
    { configPath: 'C:/cfg.json', videoRoot: 'C:/videos', pluginRoot: 'X:/plug', home: 'C:/dsh', version: '0.1.0' },
    {
      ok: true, now, due: false, nextDueAt: null, cadenceDays: 3, indexState: 'ok',
      lastPublishedAt: null, last: null, pending: [], videos: 0,
      schedule: { enabled: true, inWindow: false, wakeable: false, lastWakeAt: null, lastWakeDay: null, reason: 'not-due' },
      jobs: [], lastReport: { updatedAt: null, bytes: 0 },
    },                                      // status
    null,                                   // deps
    [{
      slug: 's1', title: '第一条', dir: 'C:/videos/s1', mtime: now,
      hasVideo: true, hasCover: true, hasStoryboard: true,
      review: { pass: true, score: 100 }, published: null,
    }],                                     // videos
    'C:/videos',                            // videoRoot
    '',                                     // selectedDir
    '',                                     // expanded
    {},                                     // reviews
    { sessdata: '', bili_jct: '', buvid3: '' },  // creds
    '',                                     // busy
    '',                                     // err
    '',                                     // out
    {                                       // v0.2 tickets（attention 为空 ⇒ 不渲染「待你处理」）
      ok: true,
      policyVersion: '0.2.0',
      tickets: [{
        id: 'tk-1', short: 'day3-a', title: '第三条：站在中间', dir: 'C:/videos/day3-a',
        stage: 'working/running', stageLabel: '制作中', attempts: 1,
        createdAt: now, updatedAt: now, endedAt: null, events: [], attention: [],
        report: { status: 'progress' }, outcome: null,
      }],
      attention: [],
      admission: { todayCount: 1, maxPerDay: 2, last: null, recent: [] },
    },
    true,                                   // ticketsOpen
    {},                                     // ticketEvents
  ])
  const plugin = loadPlugin({ react })
  let el = null
  assert.doesNotThrow(() => { el = expand(plugin.mod.Section()) })
  const text = textOf(el)

  // 全部分组标题都在
  for (const g of plugin.mod.GROUP_ORDER) assert.ok(text.includes(g), '缺分组：' + g)
  // 关键字段标签
  for (const label of ['总开关', '几天一条', '叫醒窗口开始', '允许真发（--go）', '配音音色', '成片根目录', '角色名', '日记素材文件', '违禁词（红线）']) {
    assert.ok(text.includes(label), '缺字段：' + label)
  }
  // 状态卡 / 视频列表 / 凭据 / 动作条
  assert.ok(text.includes('还没到期'))
  assert.ok(text.includes('第一条'))
  assert.ok(text.includes('B 站凭据（只写不回显）'))
  const buttons = nodesOfType(el, 'button').map((n) => textOf(n))
  for (const b of ['保存', '依赖体检', '重新读取', '现在做一条', '渲染选中视频', '生成投稿包（dry）']) {
    assert.ok(buttons.includes(b), '缺按钮：' + b)
  }
  // allowGo=true ⇒ 顶部必须有危险横幅（没有「一键真发」按钮）
  assert.ok(text.includes('真发授权已打开'))
  assert.ok(!buttons.some((b) => /真发/.test(b)), '不允许出现「真发」按钮')
  // 红线条渲染成 disabled 的只读开关
  const switches = nodesOfType(el, 'input').filter((n) => n.props.type === 'checkbox')
  assert.ok(switches.some((n) => n.props.disabled === true), '红线条应是 disabled 只读')
  // 凭据框永不预填
  const pwds = nodesOfType(el, 'input').filter((n) => n.props.type === 'password')
  assert.equal(pwds.length, 3)
  assert.ok(pwds.every((n) => n.props.value === ''))
  // v0.2：工单块要渲染；attention 为空 ⇒「待你处理」整块不出现（健康状态不占注意力）
  assert.ok(text.includes('工单（最近 1 条）'), '应有工单列表')
  assert.ok(text.includes('制作中'), '工单阶段要中文显示')
  assert.ok(text.includes('今日工单 1/2'), '状态卡应有今日工单 N/max')
  assert.ok(!text.includes('待你处理'), 'attention 为空时不该渲染「待你处理」块')
  // cfg 与 savedJson 一致 ⇒ 没有「未保存」提示
  assert.ok(!text.includes('有改动还没保存'))
})

test('Section：attention 非空时顶部渲染「待你处理」+ 中文 kind + 重试/我知道了', () => {
  const now = new Date().toISOString()
  const react = makeReactWithState([
    {}, '{}',                                  // cfg / savedJson
    null, null, null, null,                    // meta / status / deps / videos
    '', '', '', {},                            // videoRoot / selectedDir / expanded / reviews
    { sessdata: '', bili_jct: '', buvid3: '' },// creds
    '', '', '',                                // busy / err / out
    {                                          // tickets：1 条 attention
      ok: true,
      policyVersion: '0.2.0',
      tickets: [{
        id: 'tk-1', short: 'day3-a', title: '第三天', dir: 'C:/videos/day3-a',
        stage: 'person/failed', attempts: 2, updatedAt: now, events: [],
      }],
      attention: [{
        ticketId: 'tk-1', short: 'day3-a', title: '第三天',
        kind: 'stalled', detail: '任务 40 分钟没有新日志', since: now, actions: ['retry', 'ack'],
      }],
      admission: { todayCount: 2, maxPerDay: 2, last: null, recent: [] },
    },
    true,                                      // ticketsOpen
    {},                                        // ticketEvents
  ])
  const plugin = loadPlugin({ react })
  const text = textOf(expand(plugin.mod.Section()))
  assert.ok(text.includes('待你处理（1）'), '有 attention 时顶部要渲染「待你处理」')
  assert.ok(text.includes('卡住'), 'stalled 应映射成中文')
  assert.ok(text.includes('重试'))
  assert.ok(text.includes('我知道了'))
  assert.ok(text.includes('失败，等你'), 'person/failed 阶段要中文显示')
  assert.ok(text.includes('今日工单 2/2'))
})

test('危险开关在 UI 上真的会先 confirm：取消时不动配置（fail-closed）', () => {
  const confirms = []
  const react = makeReactWithState([
    {}, '{}',                                  // cfg / savedJson（空配置够渲染：getPath 拿 undefined 也安全）
    null, null, null, null,                    // meta / status / deps / videos
    '', '', '', {},                            // videoRoot / selectedDir / expanded / reviews
    { sessdata: '', bili_jct: '', buvid3: '' },// creds
    '', '', '',                                // busy / err / out
  ])
  const plugin = loadPlugin({ react, confirm: (msg) => { confirms.push(String(msg)); return false } })
  const el = expand(plugin.mod.Section())
  const dangerRows = walk(el).filter((n) => n.props && n.props['data-danger'] !== undefined)
  assert.equal(dangerRows.length, 1, '应该只有 autoPublish.allowGo 一行是 danger 样式')
  const box = nodesOfType(dangerRows[0], 'input').filter((n) => n.props.type === 'checkbox')[0]
  assert.ok(box, 'danger 行里应有开关')
  assert.doesNotThrow(() => box.props.onChange({ target: { checked: true } }))
  assert.equal(confirms.length, 1, '打开 allowGo 必须先 confirm')
  assert.match(confirms[0], /真发|投稿/)
})

test('StatusCard：到期 / 上次发布 / 待发 / 任务 / 依赖 / 调度原因 / 索引坏了', () => {
  const now = new Date().toISOString()
  const el = I.StatusCard({
    status: {
      ok: false,                       // /status 的 ok:false = 管线状态不健康，payload 仍完整
      error: 'index.json 解析失败',
      now,
      due: true,
      nextDueAt: now,
      cadenceDays: 3,
      indexState: 'error',
      lastPublishedAt: null,
      last: null,
      pending: [{ slug: 'a', title: '待发的一条', dir: 'C:/v/a' }],
      videos: 2,
      schedule: { enabled: true, inWindow: true, lastWakeAt: null, lastWakeDay: null, wakeable: true, reason: 'due' },
      jobs: [{ id: 'j1', action: 'render', dir: 'C:/v/s1', status: 'running', startedAt: now, finishedAt: null, exitCode: null }],
      lastReport: { updatedAt: now, bytes: 123 },
    },
    meta: { configPath: 'C:/cfg.json', videoRoot: 'C:/videos', pluginRoot: 'X:/plug', version: '0.1.0' },
    deps: { ok: false, items: [{ name: 'stickers', ok: false, optional: true, detail: '缺表情包' }] },
    tickets: {
      ok: true,
      policyVersion: '0.2.0',
      tickets: [],
      attention: [{ ticketId: 'tk-1', kind: 'stalled' }, { ticketId: 'tk-2', kind: 'review-failed' }],
      admission: {
        todayCount: 1,
        maxPerDay: 2,
        last: { at: now, kind: 'schedule', decision: 'reject', reason: 'daily-limit', checks: {} },
        recent: [],
      },
    },
  })
  const text = textOf(el)
  assert.ok(text.includes('到点了'), '应显示到期')
  assert.ok(text.includes('上次发布：从未'))
  assert.ok(text.includes('待发：1 条'))
  assert.ok(text.includes('成片：2'))
  assert.ok(text.includes('今日工单 1/2'), '状态卡要显示今日工单 N/max')
  assert.ok(text.includes('待你处理：2 条'), '有 attention 时状态卡要提示条数')
  assert.ok(text.includes('上次准入：今日额度用完'), '准入 reason 要映射成中文')
  assert.ok(text.includes('拒绝'), '准入决定要显示中文')
  assert.ok(text.includes('任务：1 个'))
  assert.ok(text.includes('任务 渲染 · running'), '任务列表应显示中文动作名')
  assert.ok(text.includes('窗口内'))
  assert.ok(text.includes('下次到期'))
  assert.ok(text.includes('索引：损坏'), 'indexState=error 要能显示')
  assert.ok(text.includes('管线状态异常：index.json 解析失败'), 'ok:false 的 error 必须当警告显示，不许静默')
  // 可选依赖缺失不应算「硬依赖不可用」
  assert.ok(text.includes('依赖：全部可用'), 'optional 缺失不该算不可用')
})

test('VideosBlock：封面 / 播放 / B 站链接 / 自审摘要 / dry 投稿包按钮', () => {
  const el = expand(I.VideosBlock({
    videos: [
      {
        slug: 's1', title: '第一条', dir: 'C:/videos/s1', mtime: new Date().toISOString(),
        hasVideo: true, hasCover: true, hasStoryboard: true,
        review: { pass: true, score: 100 },
        published: { bvid: 'BV1xx411c7mD', publishedAt: '2026-11-01T00:00:00Z' },
      },
      {
        slug: 's2', title: '第二条', dir: 'C:/videos/s2', mtime: null,
        hasVideo: false, hasCover: false, hasStoryboard: false,
        review: null, published: null,
      },
    ],
    root: 'C:/videos',
    selectedDir: 'C:/videos/s1',
    onSelect() {}, onExpand() {}, onRun() {}, busy: '',
    expanded: 's1',
    reviews: {
      s1: {
        state: 'ok',
        data: {
          pass: true, score: 100, reviewedAt: new Date().toISOString(),
          checks: [{ id: 'aiLabel', ok: true, hard: true, detail: '画面与简介都有 AI 生成' }],
        },
      },
    },
  }))
  const imgs = nodesOfType(el, 'img')
  assert.equal(imgs.length, 1, '只有有封面的那条渲染 <img>')
  assert.ok(imgs[0].props.src.includes('file=cover.jpg'))
  assert.ok(decodeURIComponent(imgs[0].props.src).includes('dir=C:/videos/s1'))
  const links = nodesOfType(el, 'a').map((n) => n.props.href)
  assert.ok(links.some((u) => u.includes('file=video.mp4') && decodeURIComponent(u).includes('dir=C:/videos/s1')),
    '播放链接走 /media')
  assert.ok(links.includes('https://www.bilibili.com/video/BV1xx411c7mD'), '已发布应给出 B 站链接')
  const text = textOf(el)
  assert.ok(text.includes('第一条'))
  assert.ok(text.includes('自审通过'))
  assert.ok(text.includes('展开自审') || text.includes('收起自审'))
  assert.ok(text.includes('aiLabel'), '展开后应显示 review checks')
  const buttons = nodesOfType(el, 'button').map((n) => textOf(n))
  assert.ok(buttons.includes('渲染选中视频'))
  assert.ok(buttons.includes('生成投稿包（dry）'))
})

test('CredentialsBlock：三个密码框、初始为空（凭据只写不回显）', () => {
  const el = I.CredentialsBlock({
    creds: { sessdata: '', bili_jct: '', buvid3: '' },
    setCreds() {},
    onSave() {},
    busy: '',
  })
  const inputs = nodesOfType(el, 'input')
  assert.equal(inputs.length, 3)
  for (const i of inputs) {
    assert.equal(i.props.type, 'password', '凭据输入框必须是 password')
    assert.equal(i.props.value, '', '凭据框不回显任何值')
  }
})

// ════════════════════════════════════════════════════════════════════════
// 8. 样式 / 路由 / 安全源码级契约
// ════════════════════════════════════════════════════════════════════════
test('样式：只注入一个 <style>，类名全部 bf- 前缀，颜色只用 --dsw-alias-*', () => {
  const styleTags = SOURCE.match(/document\.createElement\((['"])style\1\)/g) || []
  assert.equal(styleTags.length, 1, '只允许注入一个 <style>')

  const classNames = [...SOURCE.matchAll(/className:\s*'([^']+)'/g)].map((m) => m[1])
    .flatMap((s) => s.split(/\s+/))
    .filter(Boolean)
  assert.ok(classNames.length >= 20, '应使用类名而不是内联样式')
  for (const c of classNames) assert.ok(c.startsWith('bf'), '类名必须 bf- 前缀：' + c)

  assert.ok(SOURCE.includes('--dsw-alias-'), '必须使用 DSH 主题变量')
  // 允许 hex 只作为主题变量的 fallback（var(--dsw-alias-x, #hex)），不允许裸色值
  for (const m of SOURCE.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
    const before = SOURCE.slice(Math.max(0, m.index - 90), m.index)
    assert.ok(before.includes('var(--dsw-alias-'),
      '硬编码颜色只能作为主题变量 fallback：' + m[0])
  }
})

test('只走 DESIGN §5 的路由（settings/status/videos/deps/cookie/jobs/wake/media/report/tickets）', () => {
  for (const route of ['/settings', '/status', '/videos', '/deps', '/cookie', '/jobs', '/wake', '/tickets']) {
    assert.ok(SOURCE.includes("'" + route + "'"), '缺路由：' + route)
  }
  assert.ok(SOURCE.includes('/media?dir='), '封面/播放/自审都走 /media')
  // 凭据只写不读：源码里不存在 GET /cookie
  assert.equal(/jget\(\s*['"`]\/cookie/.test(SOURCE), false)
})

test('不跨范围：client.js 不 import 宿主/管线的运行时模块（只有 require("react")）', () => {
  const requires = [...new Set([...SOURCE.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]))]
  assert.deepEqual(requires, ['react'])
})
