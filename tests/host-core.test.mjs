/**
 * host-core.test.mjs —— 宿主半端核心逻辑的离线单测（配置 / 状态 / 生物钟判断 / 叫醒词）。
 *
 * 约束：
 *   · 全部在临时 HOME/DSH_HOME 里跑，不碰真实配置与真实视频目录；
 *   · 不联网、不渲染、不真发；
 *   · 用动态 import，保证 env 在模块加载（paths.mjs 会在 import 时读 env）之前设好。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'faship-host-core-'))
const DSH = path.join(HOME, '.dsh')
const VIDEO_ROOT = path.join(HOME, 'videos')
fs.mkdirSync(DSH, { recursive: true })
fs.mkdirSync(VIDEO_ROOT, { recursive: true })
const CFG = path.join(DSH, 'bili-faship.config.json')
fs.writeFileSync(CFG, JSON.stringify({ version: 1, video: { outDir: VIDEO_ROOT } }, null, 2))
process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.env.DSH_HOME = DSH
process.env.BILI_FASHIP_CONFIG = CFG
process.env.BILI_WHALE_CONFIG = path.join(DSH, 'no-such-whale-config.json')
delete process.env.WHALE_VIDEO_CACHE
delete process.env.WHALE_STICKER_DIR
delete process.env.WHALE_PYTHON

after(() => fs.rmSync(HOME, { recursive: true, force: true }))

const cfgMod = await import('../lib/config.mjs')
const statusMod = await import('../lib/status.mjs')
const promptMod = await import('../lib/prompt.mjs')
const dirsMod = await import('../lib/dirs.mjs')
const schedMod = await import('../lib/scheduler.mjs')

const writeCfg = (videoPatch) => {
  fs.writeFileSync(CFG, JSON.stringify({ version: 1, video: { outDir: VIDEO_ROOT, ...videoPatch } }, null, 2))
  cfgMod.resetVideoConfig()
}
const readCfgFile = () => JSON.parse(fs.readFileSync(CFG, 'utf8'))

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

test('config: 默认值包含 DESIGN §4 的关键字段，且 allowGo 默认关', () => {
  writeCfg({})
  const cfg = cfgMod.mergedConfig()
  assert.equal(cfg.cadenceDays, 3)
  assert.equal(cfg.voice.voice, 'zh-CN-XiaoyiNeural')
  assert.equal(cfg.voice.rate, '+8%')
  assert.equal(cfg.autoPublish.allowGo, false)
  assert.equal(cfg.autoPublish.dryRun, true)
  assert.equal(cfg.schedule.enabled, true)
  assert.equal(cfg.schedule.window.start, '21:00')
  assert.equal(cfg.publish.tid, 138)
  assert.equal(cfg.publish.dryRunByDefault, true)
  assert.equal(cfg.redlines.requireAiLabel, true)
  assert.ok(Array.isArray(cfg.materials.diary))
  assert.equal(cfg.persona.name, '大肥鱼')
})

test('config: POST /settings 的三种形状都接受（{config} / {video} / 裸配置）', () => {
  writeCfg({})
  let r = cfgMod.saveConfig({ config: { cadenceDays: 5 } })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(cfgMod.mergedConfig().cadenceDays, 5)
  assert.equal(readCfgFile().video.cadenceDays, 5)

  r = cfgMod.saveConfig({ video: { cadenceDays: 6 } })
  assert.equal(r.ok, true)
  assert.equal(cfgMod.mergedConfig().cadenceDays, 6)

  r = cfgMod.saveConfig({ cadenceDays: 4 })
  assert.equal(r.ok, true)
  assert.equal(cfgMod.mergedConfig().cadenceDays, 4)
})

test('config: 保存只写白名单字段，未知字段回 ignored 且不落盘', () => {
  writeCfg({})
  const r = cfgMod.saveConfig({ config: { cadenceDays: 3, evilField: 'x', publish: { tid: 138, hack: 1 } } })
  assert.equal(r.ok, true)
  assert.ok(r.ignored.includes('evilField'), JSON.stringify(r.ignored))
  assert.ok(r.ignored.includes('publish.hack'), JSON.stringify(r.ignored))
  assert.equal(readCfgFile().video.evilField, undefined)
  assert.equal(readCfgFile().video.publish.hack, undefined)
})

test('config: 非法值被拒（400 语义），且不写盘', () => {
  writeCfg({ cadenceDays: 3 })
  const before = fs.readFileSync(CFG, 'utf8')
  const cases = [
    { cadenceDays: 0 },
    { cadenceDays: 99 },
    { schedule: { window: { start: '25:00', end: '26:00' } } },
    { selfReview: { loudnessRange: [-12, -20] } },
    { selfReview: { passScore: 101 } },
    { publish: { tid: -1 } },
    { persona: { name: 'x'.repeat(41) } },
  ]
  for (const c of cases) {
    const r = cfgMod.saveConfig({ config: c })
    assert.equal(r.ok, false, `应拒绝：${JSON.stringify(c)}`)
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0)
  }
  assert.equal(fs.readFileSync(CFG, 'utf8'), before, '非法保存不应改动文件')
})

test('config: 改完 resetVideoConfig 后 videoRoot 生效', () => {
  const alt = path.join(HOME, 'videos-alt')
  writeCfg({ outDir: alt })
  assert.equal(cfgMod.videoRoot(), path.resolve(alt))
  writeCfg({})
  assert.equal(cfgMod.videoRoot(), path.resolve(VIDEO_ROOT))
})

test('config: 打开允许真发会带 warning（不是 error）', () => {
  writeCfg({})
  const r = cfgMod.saveConfig({ config: { autoPublish: { allowGo: true } } })
  assert.equal(r.ok, true)
  assert.ok(r.warnings.some((w) => w.includes('允许真发')))
  writeCfg({})
})

// ---------------------------------------------------------------------------
// 时间窗口 / due / 调度视图
// ---------------------------------------------------------------------------

test('schedule: HH:MM 解析与窗口判断（含跨午夜）', () => {
  assert.equal(statusMod.hhmmToMin('21:00'), 21 * 60)
  assert.equal(statusMod.hhmmToMin('00:30'), 30)
  assert.equal(statusMod.hhmmToMin('25:00'), null)
  const cfg = { schedule: { window: { start: '21:00', end: '23:30' } } }
  const at = (h, m) => { const d = new Date(2026, 10, 6, h, m, 0); return d }
  assert.equal(statusMod.inWakeWindow(cfg, at(21, 30)), true)
  assert.equal(statusMod.inWakeWindow(cfg, at(20, 59)), false)
  assert.equal(statusMod.inWakeWindow(cfg, at(23, 30)), true)
  assert.equal(statusMod.inWakeWindow(cfg, at(23, 31)), false)
  const cross = { schedule: { window: { start: '22:00', end: '02:00' } } }
  assert.equal(statusMod.inWakeWindow(cross, at(23, 0)), true)
  assert.equal(statusMod.inWakeWindow(cross, at(1, 0)), true)
  assert.equal(statusMod.inWakeWindow(cross, at(12, 0)), false)
})

test('schedule: dueNow —— 没有 index = 到期；刚发过 = 没到期；过期 = 到期', () => {
  const cfg = { cadenceDays: 3 }
  const indexFile = path.join(VIDEO_ROOT, 'index.json')
  try { fs.rmSync(indexFile, { force: true }) } catch {}
  let r = schedMod.dueNow(cfg)
  assert.equal(r.due, true)
  assert.equal(r.reason, 'never-published')

  const now = new Date()
  const recent = new Date(now.getTime() - 1 * 86400_000).toISOString()
  fs.writeFileSync(indexFile, JSON.stringify({ version: 1, videos: [], lastPublishedAt: recent }))
  r = schedMod.dueNow(cfg)
  assert.equal(r.due, false)
  assert.equal(r.reason, 'not-due')

  const old = new Date(now.getTime() - 4 * 86400_000).toISOString()
  fs.writeFileSync(indexFile, JSON.stringify({ version: 1, videos: [], lastPublishedAt: old }))
  r = schedMod.dueNow(cfg)
  assert.equal(r.due, true)
  assert.ok(r.nextDueAt)

  fs.writeFileSync(indexFile, '{ broken json')
  r = schedMod.dueNow(cfg)
  assert.equal(r.due, false, '坏账本不能当成"从未发布"')
  assert.equal(r.reason, 'index-corrupt')
  fs.rmSync(indexFile, { force: true })
})

test('schedule: scheduleView 的 reason 枚举齐全（disabled / schedule-off / not-due / job-running）', () => {
  writeCfg({})
  const cfg = cfgMod.mergedConfig()
  assert.equal(statusMod.scheduleView({ ...cfg, enabled: false }, { due: true }).reason, 'disabled')
  assert.equal(statusMod.scheduleView({ ...cfg, schedule: { ...cfg.schedule, enabled: false } }, { due: true }).reason, 'schedule-off')
  assert.equal(statusMod.scheduleView(cfg, { due: false }).reason, 'not-due')
  const due = statusMod.scheduleView(cfg, { due: true }, new Date(2026, 10, 6, 12, 0))
  assert.equal(due.reason, 'out-of-window')
  const inWin = statusMod.scheduleView(cfg, { due: true }, new Date(2026, 10, 6, 22, 0))
  assert.equal(inWin.reason, 'due')
  assert.equal(inWin.wakeable, true)
})

test('schedule: 同一天叫过之后不再 wake（already-woke-today）', () => {
  writeCfg({})
  const cfg = cfgMod.mergedConfig()
  const now = new Date(2026, 10, 6, 22, 0)
  statusMod.writeScheduleState({ lastWakeAt: now.toISOString(), lastWakeDay: '2026-11-06', lastAction: 'wake', lastSessionId: 'bili-faship' })
  const v = statusMod.scheduleView(cfg, { due: true }, now)
  assert.equal(v.reason, 'already-woke-today')
  assert.equal(v.wakeable, false)
  fs.rmSync(dirsMod.scheduleFile(), { force: true })
})

// ---------------------------------------------------------------------------
// 视频列表 / 汇报
// ---------------------------------------------------------------------------

test('status: listVideos 读出 storyboard/meta/review/发布信息', () => {
  const dir = path.join(VIDEO_ROOT, 'day1-foo')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'storyboard.json'), JSON.stringify({ version: 4, slug: 'day1-foo', title: '第一天', scenes: [] }))
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ title: 'meta 标题' }))
  fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ pass: true, score: 100 }))
  fs.writeFileSync(path.join(dir, 'cover.jpg'), 'x')
  fs.writeFileSync(path.join(dir, 'publish.json'), JSON.stringify({ bvid: 'BV1xx', publishedAt: '2026-11-01T00:00:00.000Z' }))
  const r = statusMod.listVideos()
  const item = r.videos.find((v) => v.slug === 'day1-foo')
  assert.ok(item, '应列出 day1-foo')
  assert.equal(item.title, '第一天')
  assert.equal(item.hasCover, true)
  assert.equal(item.hasVideo, false)
  assert.deepEqual(item.review, { pass: true, score: 100 })
  assert.equal(item.published.bvid, 'BV1xx')
})

test('status: readReport 没有文件时返回空；有文件时带 updatedAt/bytes', () => {
  fs.rmSync(dirsMod.reportFile(), { force: true })
  let r = statusMod.readReport()
  assert.equal(r.text, '')
  assert.equal(r.updatedAt, null)
  fs.mkdirSync(path.dirname(dirsMod.reportFile()), { recursive: true })
  fs.writeFileSync(dirsMod.reportFile(), '这轮做了一条片')
  r = statusMod.readReport()
  assert.match(r.text, /一条片/)
  assert.ok(r.bytes > 0)
  assert.ok(r.updatedAt)
})

test('status: getStatus 在没有 index 时也给出完整形状（due=true）', async () => {
  writeCfg({})
  try { fs.rmSync(path.join(VIDEO_ROOT, 'index.json'), { force: true }) } catch {}
  const st = await statusMod.getStatus()
  assert.equal(st.due, true)
  assert.equal(st.indexState, 'missing')
  assert.ok(st.schedule && typeof st.schedule.reason === 'string')
  assert.ok(Array.isArray(st.jobs))
  assert.ok(st.configPath.endsWith('bili-faship.config.json'))
})

// ---------------------------------------------------------------------------
// 叫醒词
// ---------------------------------------------------------------------------

test('prompt: 叫醒词包含人设/到期信息/CLI 路径/红线/报告路径/投稿策略', () => {
  writeCfg({})
  const text = promptMod.buildWakePrompt({ reason: '到期（自动）', cliPath: 'C:/x/tools/bili-faship.mjs', status: { nextDueAt: null } })
  assert.match(text, /大肥鱼/)
  assert.match(text, /到期/)
  assert.match(text, /bili-faship\.mjs/)
  assert.match(text, /AI 生成/)
  assert.match(text, /601/)
  assert.match(text, /last-report\.md/)
  assert.match(text, /dry/)
  assert.match(text, /不要加 --go/)
  assert.match(text, /可以不做/)
  assert.match(text, /把没做写成做完了/)
})

test('prompt: 打开 allowGo 后叫醒词改口径（允许 --go，但仍要求确认）', () => {
  writeCfg({ autoPublish: { allowGo: true, dryRun: false } })
  const text = promptMod.buildWakePrompt({ cliPath: 'x' })
  assert.match(text, /允许真发/)
  assert.match(text, /601/)
  writeCfg({})
})
