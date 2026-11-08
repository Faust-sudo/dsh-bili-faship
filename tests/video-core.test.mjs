/**
 * video-core.test.mjs — 视频创作 A 部分（storyboard / render / review / CLI status）的离线单测。
 *
 * 约束：
 *  · 不联网：TTS 只测纯函数（token 向量），render 用 deps 注入假 TTS/假进程；
 *  · 不真渲染：review 的响度用 deps.loudness 注入；render 的 ffmpeg/python 用假 exec；
 *  · 全部在临时目录里跑，测试结束删干净。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// ---- 先固定 home / DSH_HOME / 配置路径，再动态 import 插件模块（paths.mjs 在 import 时读 env）----
// 插件版配置只有一份：<DSH_HOME>/bili-faship.config.json；BILI_FASHIP_CONFIG 指向它，避免读到真实用户的配置。
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'faship-video-core-'))
const DSH = path.join(HOME, '.dsh')
const VIDEO_ROOT = path.join(HOME, 'videos')
fs.mkdirSync(DSH, { recursive: true })
const CONFIG_FILE = path.join(DSH, 'bili-faship.config.json')
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ version: 1, video: { outDir: VIDEO_ROOT } }))
process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.env.DSH_HOME = DSH
process.env.BILI_FASHIP_CONFIG = CONFIG_FILE
delete process.env.BILI_WHALE_CONFIG
delete process.env.WHALE_STICKER_DIR
delete process.env.WHALE_VIDEO_CACHE

after(() => fs.rmSync(HOME, { recursive: true, force: true }))

const sb = await import('../tools/video/storyboard.mjs')
const tts = await import('../tools/video/tts.mjs')
const renderMod = await import('../tools/video/render.mjs')
const reviewMod = await import('../tools/video/review.mjs')
const cli = await import('../tools/commands/video.mjs')
const videoConfigMod = await import('../tools/lib/video-config.mjs')

const CLI = path.resolve(import.meta.dirname, '..', 'tools', 'bili-faship.mjs')

let seq = 0
function freshDir(name = 'case') {
  seq += 1
  const dir = path.join(HOME, 'work', `${String(seq).padStart(2, '0')}-${name}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function templateDir(name = 'case', mutate = null) {
  const dir = freshDir(name)
  const story = sb.planTemplate({ topic: '这个号，从今天起全归我', date: '2026-10-25' })
  if (mutate) mutate(story)
  const check = sb.validateStoryboard(sb.normalizeStoryboard(story))
  assert.equal(check.ok, true, `fixture 应合法：${JSON.stringify(check.errors)}`)
  fs.writeFileSync(sb.storyboardPath(dir), JSON.stringify(story, null, 2))
  return { dir, story }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

/** 造一份「有字幕、能过时长」的 meta/timing 夹具；return {meta, timing}。 */
function coverageTiming(story, ttsDur = 2) {
  const byId = {}
  for (const scene of story.scenes) if (String(scene.narration || '').trim()) byId[scene.id] = ttsDur
  const timeline = renderMod.buildTimeline(story.scenes, { ttsDurById: byId })
  const cues = renderMod.buildCues(timeline)
  return { timeline, cues, timing: renderMod.buildTiming({ story, timeline, cues }) }
}

function metalessFixture({ durationSec = 40, story: storyOverride = null, mutate = null } = {}) {
  const { dir, story } = templateDir('review', (s) => {
    if (mutate) mutate(s)
  })
  const story2 = storyOverride || story
  const { timing } = coverageTiming(story2)
  writeJson(path.join(dir, 'timing.json'), timing)
  // 真实 review 会检查 video.mp4 是否存在；夹具放一个占位视频（deps.duration 用 meta 时长）
  fs.writeFileSync(path.join(dir, 'video.mp4'), Buffer.alloc(64, 7))
  writeJson(path.join(dir, 'meta.json'), {
    durationSec,
    files: { video: 'video.mp4', cover: 'cover.jpg', subtitles: 'subtitles.srt', timing: 'timing.json' },
  })
  return { dir, story: story2, timing }
}

// ---------------------------------------------------------------------------
// 1. schema / plan
// ---------------------------------------------------------------------------

test('storyboard: plan 模板合法、带人设提示与 AI 标注', () => {
  const story = sb.planTemplate({ topic: '随便聊聊', persona: { name: '大肥鱼' } })
  const r = sb.validateStoryboard(sb.normalizeStoryboard(story))
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.ok(story.scenes.length >= 1)
  assert.ok(story._hints.availableMascots.includes('happy'))
  assert.ok(story._hints.cardKinds.includes('big'))
  assert.match(story.topbar.right, /AI\s*生成/)
  assert.match(story.publish.description, /AI\s*生成/)
  assert.equal(story.version, 4)
})

test('storyboard: 非法 card.kind / mascot / 重复 id / 奇数宽 都会报错', () => {
  const story = sb.planTemplate({ topic: 'x' })
  story.scenes = [
    { id: 'a', narration: '一', mascot: 'nope', card: { kind: 'nope' } },
    { id: 'a', narration: '二' },
  ]
  story.version = 3
  story.width = 321
  const r = sb.validateStoryboard(sb.normalizeStoryboard(story))
  assert.equal(r.ok, false)
  const paths = r.errors.map((e) => e.path)
  assert.ok(paths.includes('version'), paths.join(','))
  assert.ok(paths.includes('width'), paths.join(','))
  assert.ok(paths.includes('scenes[0].mascot'), paths.join(','))
  assert.ok(paths.includes('scenes[0].card.kind'), paths.join(','))
  assert.ok(paths.includes('scenes[1].id'), paths.join(','))
})

test('storyboard: writePlan 首次生成、二次只校验不覆盖', () => {
  const dir = freshDir('plan')
  const first = sb.writePlan(dir, { topic: '第一次' })
  assert.equal(first.created, true)
  assert.equal(first.result.ok, true)
  const file = sb.storyboardPath(dir)
  assert.ok(fs.existsSync(file))

  // 手工改标题 → 再 plan 不应该覆盖
  const edited = sb.readJson(file)
  edited.title = '我自己改的标题'
  fs.writeFileSync(file, JSON.stringify(edited, null, 2))
  const second = sb.writePlan(dir, { topic: '第二次' })
  assert.equal(second.created, false)
  assert.equal(second.result.ok, true)
  assert.equal(sb.readJson(file).title, '我自己改的标题')

  // 坏文件 → 只校验并报错，不覆盖
  fs.writeFileSync(file, '{ 坏 JSON')
  const third = sb.writePlan(dir, { topic: '第三次' })
  assert.equal(third.created, false)
  assert.equal(third.result.ok, false)
})

test('storyboard: readStoryboard 缺文件/坏 JSON 给出可读错误', () => {
  const dir = freshDir('missing')
  assert.throws(() => sb.readStoryboard(dir), /没有找到/)
  fs.writeFileSync(sb.storyboardPath(dir), '{oops')
  assert.throws(() => sb.readStoryboard(dir), /读取/)
})

// ---------------------------------------------------------------------------
// 2. tts 纯函数
// ---------------------------------------------------------------------------

test('tts: Sec-MS-GEC v2 token 固定向量全部匹配（不联网）', () => {
  const rows = tts.selfTestToken()
  assert.ok(rows.length >= 4)
  for (const r of rows) assert.equal(r.pass, true, `ts=${r.timestamp} got=${r.got}`)
})

// ---------------------------------------------------------------------------
// 3. render 纯逻辑
// ---------------------------------------------------------------------------

test('render: buildTimeline 按「前导 0.4s + TTS + 0.35s」排时间轴，无旁白场次用 minDuration', () => {
  const scenes = [
    { id: 's1', narration: '你好呀', minDuration: 2.6 },
    { id: 's2', narration: '', minDuration: 3 },
    { id: 's3', narration: '再见', minDuration: 2.6 },
  ]
  const tl = renderMod.buildTimeline(scenes, { ttsDurById: { s1: 2, s3: 1.2 } })
  assert.equal(tl.length, 3)
  assert.ok(Math.abs(tl[0].dur - 2.75) < 1e-9) // max(2.6, .4+2+.35)
  assert.equal(tl[1].dur, 3)
  assert.ok(Math.abs(tl[2].dur - 2.6) < 1e-9) // max(2.6, .4+1.2+.35=1.95)
  assert.equal(tl[0].start, 0)
  assert.ok(Math.abs(tl[1].start - 2.75) < 1e-9)
  assert.ok(Math.abs(tl[0].narrationStart - 0.4) < 1e-9)
  assert.ok(Math.abs(renderMod.timelineTotal(tl) - 8.35) < 1e-9)
  assert.throws(() => renderMod.buildTimeline(scenes, { ttsDurById: {} }), /没有 TTS 时长/)
})

test('render: buildCues / srt / 覆盖率为纯函数，结果稳定', () => {
  const story = sb.planTemplate({ topic: '字幕测试' })
  const { timeline, cues, timing } = coverageTiming(story, 2)
  assert.ok(cues.length >= story.scenes.length)
  assert.ok(cues.every((c) => c.start >= 0 && c.end > c.start))
  const srt = renderMod.srtFromCues(cues)
  assert.match(srt, /^1\n00:00:/)
  assert.match(srt, /-->/)
  // 每条 cue 都落在自己场景的时间范围里
  for (const cue of cues) {
    const scene = timeline[cue.scene]
    assert.ok(cue.start >= scene.start - 1e-6, JSON.stringify(cue))
    assert.ok(cue.end <= scene.start + scene.dur + 1e-6, JSON.stringify(cue))
  }
  const cov = reviewMod.computeSubtitleCoverage(story, timing)
  assert.equal(cov.ratio, 1)
  // 少一场字幕 → 覆盖率下降
  const broken = { ...timing, cues: timing.cues.filter((c) => c.scene !== 2) }
  assert.ok(reviewMod.computeSubtitleCoverage(story, broken).ratio < 1)
})

test('render: buildAudioArgs 含 BGM 循环/adelay/amix/loudnorm；无输入时给静音底', () => {
  const timeline = [
    { tts: 'a.wav', narrationStart: 0.4, start: 0, dur: 2.75, scene: { card: { kind: 'big' }, stamp: { text: 'x' } } },
    { tts: 'b.wav', narrationStart: 3.55, start: 3.15, dur: 2.75, scene: { card: { kind: 'none' } } },
    { tts: 'c.wav', narrationStart: 6.3, start: 5.9, dur: 2.75, scene: { card: { kind: 'list' } } },
  ]
  const args = renderMod.buildAudioArgs({
    timeline, total: 8.65, bgmPath: 'bgm.mp3', bgmVolume: 0.72,
    sfx: { pop: 'pop.wav', ding: 'ding.wav', whoosh: 'whoosh.wav' }, outPath: 'audio.wav',
  }).join(' ')
  assert.match(args, /-stream_loop -1 -i bgm\.mp3/)
  assert.match(args, /adelay=/)
  assert.match(args, /amix=inputs=/)
  assert.match(args, new RegExp(renderMod.LOUDNORM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(args, /afade=t=out/)
  assert.match(args, /loudnorm/)

  const empty = renderMod.buildAudioArgs({ timeline: [], total: 3, bgmPath: null, sfx: {}, outPath: 'a.wav' }).join(' ')
  assert.match(empty, /anullsrc/)
  assert.match(empty, /loudnorm/)
})

// ---------------------------------------------------------------------------
// 4. render 编排（假 TTS + 假进程，不联网/不渲染）
// ---------------------------------------------------------------------------

function makeFakeExec(trace = []) {
  return (exe, args) => {
    trace.push({ exe: path.basename(exe), args: [...args] })
    const a = args.map(String)
    const last = a[a.length - 1]
    if (a.includes('-filter_complex')) {
      fs.writeFileSync(last, 'fake-audio')
      return { status: 0 }
    }
    if (a.includes('-af') && a.some((x) => x.includes('areverse'))) {
      fs.writeFileSync(last, 'fake-wav')
      return { status: 0 }
    }
    if (a.includes('-c:v') && a.includes('copy')) {
      fs.writeFileSync(last, 'fake-video')
      return { status: 0 }
    }
    if (path.basename(exe) === 'python') {
      const outIdx = a.indexOf('--out')
      const coverIdx = a.indexOf('--cover')
      if (outIdx > 0) fs.writeFileSync(a[outIdx + 1], 'fake-silent')
      if (coverIdx > 0) fs.writeFileSync(a[coverIdx + 1], 'fake-cover')
      return { status: 0 }
    }
    // probe：ffmpeg -i <file>
    if (a.includes('-i') && !a.includes('-y')) {
      return { status: 0, stderr: 'Duration: 00:00:02.50, start: 0.0' }
    }
    return { status: 0, stderr: '' }
  }
}

test('render: renderVideo 用注入的 TTS/进程跑通全流程，产物原子落盘', async () => {
  const { dir } = templateDir('render-ok')
  const trace = []
  const fsx = fs
  const result = await renderMod.renderVideo({
    dir,
    config: videoConfigMod.videoConfig(),
    deps: {
      synthesize: async ({ text, outMp3 }) => {
        assert.ok(String(text).length > 0)
        fsx.mkdirSync(path.dirname(outMp3), { recursive: true })
        fsx.writeFileSync(outMp3, Buffer.alloc(2000, 1))
        return { mp3: outMp3, durationMs: 2500 }
      },
      exec: makeFakeExec(trace),
      ffmpeg: 'ffmpeg',
      python: 'python',
    },
  })
  assert.equal(result.video, path.join(dir, 'video.mp4'))
  for (const name of ['video.mp4', 'cover.jpg', 'subtitles.srt', 'timing.json', 'meta.json']) {
    assert.ok(fs.existsSync(path.join(dir, name)), `${name} 应存在`)
  }
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
  assert.ok(meta.durationSec > 0)
  const timing = JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'))
  assert.ok(timing.cues.length >= 1)
  assert.ok(trace.some((t) => t.exe === 'python'), '应调用过 python 渲染器')
  // 没有残留工作目录
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('.work-')).length, 0)
})

test('render: TTS 失败会抛错且不留半成品（无 .work 残留）', async () => {
  const { dir } = templateDir('render-fail')
  await assert.rejects(
    renderMod.renderVideo({
      dir,
      config: videoConfigMod.videoConfig(),
      deps: {
        synthesize: async () => { throw new Error('假 TTS 挂了') },
        exec: makeFakeExec(),
        ffmpeg: 'ffmpeg',
        python: 'python',
      },
    }),
    /假 TTS 挂了/,
  )
  for (const name of ['video.mp4', 'meta.json', 'timing.json', 'cover.jpg']) {
    assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} 不应存在`)
  }
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('.work-')).length, 0)
})

// ---------------------------------------------------------------------------
// 5. review 硬闸门
// ---------------------------------------------------------------------------

async function runReview(fixture, { config = videoConfigMod.videoConfig(), loudness = -16 } = {}) {
  return reviewMod.reviewVideo({
    dir: fixture.dir,
    config,
    deps: {
      loudness: async () => loudness,
      duration: async (_video, { dir }) => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).durationSec } catch { return null }
      },
    },
  })
}

function checkOf(result, id) {
  const c = result.checks.find((x) => x.id === id)
  assert.ok(c, `缺检查项 ${id}：${result.checks.map((x) => x.id).join(',')}`)
  return c
}

test('review: 全绿 → pass:true、score 100，并写 review.json', async () => {
  const fixture = metalessFixture()
  const result = await runReview(fixture)
  assert.equal(result.pass, true, JSON.stringify(result.checks))
  assert.equal(result.score, 100, JSON.stringify(result.checks))
  for (const id of ['schema', 'duration', 'loudness', 'aiLabel', 'citations', 'redline', 'subtitleCoverage']) {
    assert.equal(checkOf(result, id).ok, true, id)
  }
  const saved = JSON.parse(fs.readFileSync(path.join(fixture.dir, 'review.json'), 'utf8'))
  assert.equal(saved.pass, true)
  assert.equal(saved.score, 100)
  assert.ok(saved.reviewedAt)
  assert.ok(Array.isArray(saved.checks))
})

test('review: 缺 AI 标注 → FAIL（aiLabel 硬闸门）', async () => {
  const fixture = metalessFixture({
    mutate: (s) => {
      s.topbar.right = ''
      s.publish = { titleForPost: '标题', description: '普通简介，没有标注', tags: [] }
    },
  })
  const result = await runReview(fixture)
  assert.equal(result.pass, false)
  assert.equal(checkOf(result, 'aiLabel').ok, false)
})

test('review: 引用缺 BV → FAIL（citations 硬闸门）', async () => {
  const fixture = metalessFixture({
    mutate: (s) => {
      s.citations = [{ up: '某个UP', title: '某条视频', clipSec: 2 }]
    },
  })
  const result = await runReview(fixture)
  assert.equal(result.pass, false)
  const c = checkOf(result, 'citations')
  assert.equal(c.ok, false)
  assert.match(c.detail, /bv/)
})

test('review: 引用超 maxClipSec → FAIL', async () => {
  const fixture = metalessFixture({
    mutate: (s) => {
      s.citations = [{ bv: 'BV1xx411c7mD', up: '某个UP', title: '某条视频', clipSec: 9 }]
    },
  })
  const result = await runReview(fixture)
  assert.equal(result.pass, false)
  assert.match(checkOf(result, 'citations').detail, /超过上限/)
})

test('review: 超时长/过短 → FAIL（duration 硬闸门）', async () => {
  const tooLong = metalessFixture({ durationSec: 999 })
  assert.equal((await runReview(tooLong)).pass, false)
  assert.match(checkOf(await runReview(tooLong), 'duration').detail, /上限/)

  const tooShort = metalessFixture({ durationSec: 3 })
  const r2 = await runReview(tooShort)
  assert.equal(r2.pass, false)
  assert.match(checkOf(r2, 'duration').detail, /下限/)
})

test('review: 红线词 / 冒充真人短语 → FAIL（redline 硬闸门）', async () => {
  const banned = metalessFixture({
    mutate: (s) => { s.scenes[0].narration = '今天我们来刷量，冲一波数据。' },
  })
  const r1 = await runReview(banned)
  assert.equal(r1.pass, false)
  assert.match(checkOf(r1, 'redline').detail, /刷量/)

  const impersonate = metalessFixture({
    mutate: (s) => { s.scenes[0].narration = '大家好，我是真人，真的不是AI。' },
  })
  const r2 = await runReview(impersonate)
  assert.equal(r2.pass, false)
  assert.match(checkOf(r2, 'redline').detail, /我是真人/)
})

test('review: 字幕覆盖不足 → FAIL；响度超区间/测不出 → FAIL', async () => {
  // 只给第一场造字幕
  const fixture = metalessFixture()
  const timing = JSON.parse(fs.readFileSync(path.join(fixture.dir, 'timing.json'), 'utf8'))
  timing.cues = timing.cues.filter((c) => c.scene === 0)
  writeJson(path.join(fixture.dir, 'timing.json'), timing)
  const r = await runReview(fixture)
  assert.equal(r.pass, false)
  assert.equal(checkOf(r, 'subtitleCoverage').ok, false)

  const loud = metalessFixture()
  const r2 = await runReview(loud, { loudness: -35 })
  assert.equal(r2.pass, false)
  assert.match(checkOf(r2, 'loudness').detail, /不在/)

  const unknown = metalessFixture()
  const r3 = await runReview(unknown, { loudness: null })
  assert.equal(r3.pass, false)
  assert.match(checkOf(r3, 'loudness').detail, /测不出/)
})

test('review: schema 不合法也会 FAIL，并把 schema 错误写进 checks', async () => {
  const dir = freshDir('bad-schema')
  fs.writeFileSync(sb.storyboardPath(dir), JSON.stringify({ version: 3, slug: '', title: '', scenes: [] }))
  const result = await reviewMod.reviewVideo({
    dir, config: videoConfigMod.videoConfig(), deps: { loudness: async () => -16 },
  })
  assert.equal(result.pass, false)
  assert.equal(checkOf(result, 'schema').ok, false)
})

// ---------------------------------------------------------------------------
// 6. status（index.json 合同 + 待发扫描）
// ---------------------------------------------------------------------------

function makeStatusRoot() {
  const root = freshDir('status-root')
  // v1：已发布
  const v1 = path.join(root, 'v1')
  fs.mkdirSync(v1)
  fs.writeFileSync(sb.storyboardPath(v1), JSON.stringify(sb.planTemplate({ topic: '旧视频', slug: 'v1' })))
  writeJson(path.join(v1, 'publish.json'), { bvid: 'BV1old000001' })
  // v2：自审 pass 但没发 → pending
  const v2 = path.join(root, 'v2')
  fs.mkdirSync(v2)
  writeJson(sb.storyboardPath(v2), sb.planTemplate({ topic: '新视频', slug: 'v2' }))
  writeJson(path.join(v2, 'review.json'), { pass: true, score: 92, reviewedAt: '2026-10-24T12:00:00.000Z', checks: [] })
  // v3：自审没过 → 不算待发
  const v3 = path.join(root, 'v3')
  fs.mkdirSync(v3)
  writeJson(sb.storyboardPath(v3), sb.planTemplate({ topic: '没过的视频', slug: 'v3' }))
  writeJson(path.join(v3, 'review.json'), { pass: false, score: 40, reviewedAt: '2026-10-24T12:00:00.000Z', checks: [] })
  writeJson(path.join(root, 'index.json'), {
    version: 1,
    videos: [{ slug: 'v1', title: '旧视频', bvid: 'BV1old000001', aid: 111, publishedAt: '2026-10-20T00:00:00.000Z' }],
    lastPublishedAt: '2026-10-20T00:00:00.000Z',
  })
  return root
}

test('status: 读 index.json 算 due/nextDueAt，pending=自审 pass 未发', () => {
  const root = makeStatusRoot()
  const cfg = videoConfigMod.videoConfig()
  const before = cli.videoStatus({ root, config: cfg, now: new Date('2026-10-21T00:00:00.000Z') })
  assert.equal(before.indexState, 'ok')
  assert.equal(before.last.slug, 'v1')
  assert.equal(before.last.bvid, 'BV1old000001')
  assert.equal(before.cadenceDays, cfg.cadenceDays)
  assert.equal(before.due, false) // 10-20 + 3 天 = 10-23
  assert.equal(before.nextDueAt, '2026-10-23T00:00:00.000Z')
  assert.deepEqual(before.pending.map((p) => p.slug), ['v2'])

  const afterDue = cli.videoStatus({ root, config: cfg, now: new Date('2026-10-24T00:00:00.000Z') })
  assert.equal(afterDue.due, true)
})

test('status: index.json 不存在 = 从未发布(due)；损坏 = 报错', () => {
  const root = freshDir('status-missing')
  const r = cli.videoStatus({ root, config: videoConfigMod.videoConfig(), now: new Date('2026-10-25T00:00:00.000Z') })
  assert.equal(r.indexState, 'missing')
  assert.equal(r.last, null)
  assert.equal(r.due, true)
  assert.equal(r.nextDueAt, null)
  assert.deepEqual(r.pending, [])

  const broken = freshDir('status-broken')
  fs.writeFileSync(path.join(broken, 'index.json'), '{not json')
  assert.throws(() => cli.videoStatus({ root: broken, config: videoConfigMod.videoConfig() }), /损坏/)

  const badShape = freshDir('status-badshape')
  fs.writeFileSync(path.join(badShape, 'index.json'), JSON.stringify({ version: 1 }))
  assert.throws(() => cli.videoStatus({ root: badShape, config: videoConfigMod.videoConfig() }), /格式不对/)
})

// ---------------------------------------------------------------------------
// 7. CLI（子进程，离线）
// ---------------------------------------------------------------------------

function runCli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
    env: { ...process.env, ...(opts.env || {}) },
  })
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}

test('CLI: help 写清创作子命令（插件版入口 tools/bili-faship.mjs，不再有旧 video <BV>）', () => {
  const r = runCli(['help'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /plan\/render\/review\/publish\/status/)
  assert.match(r.stdout, /bili-faship\.mjs plan/)
  assert.doesNotMatch(r.stdout, /看视频内容/)
})

test('CLI: 未知子命令 → 报错 + 帮助，exit 2（不静默透传旧命令）', () => {
  const r = runCli(['watch', 'BV1xx411c7mD'])
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /未知子命令/)
  assert.match(r.stdout, /bili-faship\.mjs plan/)
})

test('CLI: deps --json 输出体检结构（离线可跑，字段齐全）', () => {
  const r = runCli(['deps', '--json'])
  const out = JSON.parse(r.stdout)
  assert.equal(typeof out.ok, 'boolean')
  assert.ok(Array.isArray(out.items) && out.items.length >= 4)
  for (const it of out.items) {
    assert.equal(typeof it.name, 'string')
    assert.equal(typeof it.ok, 'boolean')
    assert.equal(typeof it.detail, 'string')
    assert.ok(typeof it.optional === 'boolean')
  }
  const names = out.items.map((it) => it.name)
  for (const required of ['node', 'ffmpeg', 'python', 'Pillow', 'BGM 资源']) {
    assert.ok(names.includes(required), `缺体检项：${required}（实际 ${names.join(',')}）`)
  }
  assert.ok(out.items.find((it) => it.name === 'node').ok)
  assert.equal(out.node.version, process.version)
})

test('CLI: video plan --dir --json 生成模板；重复调用不覆盖', () => {
  const dir = freshDir('cli-plan')
  const r1 = runCli(['plan', '--dir', dir, '--topic', 'CLI 测试', '--json'])
  assert.equal(r1.status, 0, r1.stderr)
  const out1 = JSON.parse(r1.stdout)
  assert.equal(out1.ok, true)
  assert.equal(out1.created, true)
  assert.ok(fs.existsSync(path.join(dir, 'storyboard.json')))

  // 改标题 → 再跑 plan，不覆盖
  const file = path.join(dir, 'storyboard.json')
  const story = JSON.parse(fs.readFileSync(file, 'utf8'))
  story.title = '我改过的标题'
  fs.writeFileSync(file, JSON.stringify(story, null, 2))
  const r2 = runCli(['plan', '--dir', dir, '--json'])
  assert.equal(r2.status, 0, r2.stderr)
  const out2 = JSON.parse(r2.stdout)
  assert.equal(out2.created, false)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).title, '我改过的标题')
})

test('CLI: review 未通过（未 render）exit 1；render 缺 --dir exit 2', async () => {
  const dir = freshDir('cli-review')
  fs.writeFileSync(path.join(dir, 'storyboard.json'), JSON.stringify(sb.planTemplate({ topic: 'x' })))
  const r = runCli(['review', '--dir', dir, '--json'])
  assert.equal(r.status, 1, r.stdout + r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.pass, false)

  const r2 = runCli(['render', '--json'])
  assert.equal(r2.status, 2)
  assert.match(r2.stderr, /--dir/)
})

test('CLI: publish 没有 B 模块时只提示「投稿模块未安装」，不投稿', () => {
  const dir = freshDir('cli-publish')
  // 开发期间 B 的 publish.mjs 可能还没装；已装时也不该被这条测试触发真发（没有 --go 且只检查提示/退出码）
  const r = runCli(['publish', '--dir', dir])
  if (fs.existsSync(path.resolve(import.meta.dirname, '..', 'tools', 'video', 'publish.mjs'))) {
    // 模块存在时由 B 的行为接管：这里只要求不能是"未安装"提示
    assert.doesNotMatch(r.stderr, /未安装/)
  } else {
    assert.equal(r.status, 2)
    assert.match(r.stderr, /投稿模块未安装/)
  }
})
