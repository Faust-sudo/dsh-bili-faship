// 投稿模块（tools/video/publish.mjs）的纯逻辑测试。
//
// 原则（与 VIDEO-CAPABILITY.md 测试要求一致）：
//   · 不联网：所有网络请求走 mock transport，测试里任何真实 fetch 都算 bug
//   · 临时目录：视频目录 / videoRoot / HOME 全部用 mkdtemp，结束后删掉
//   · 假凭据：在隔离的 HOME 下写假 cookie，绝不读真实账号凭据
//   · 不真发：--go 流程全部用假 URL / 假响应走完，只断言请求形状与本地记账
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// —— 必须在 import publish.mjs 之前隔离 HOME：paths.mjs 在 import 时就把 HOME 解析好了 ——
// 插件版：配置只认 BILI_FASHIP_CONFIG / <DSH_HOME>/bili-faship.config.json；这里故意都不给，
// 让 publish 用 VIDEO_DEFAULTS + 测试自己注入的 config，绝不读真实用户的配置。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'faship-pub-home-'))
process.env.USERPROFILE = TMP_HOME
process.env.HOME = TMP_HOME
delete process.env.DSH_HOME
delete process.env.BILI_FASHIP_CONFIG
delete process.env.BILI_WHALE_CONFIG
const CRED_FILE = path.join(TMP_HOME, '.bili-ai', 'credentials.json')
const FAKE_CRED = {
  sessdata: 'FAKE-SESSDATA-never-print',
  bili_jct: '0123456789abcdef0123456789abcdef',
  buvid3: 'FAKE-BUVID3-never-print',
}
fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true })
fs.writeFileSync(CRED_FILE, JSON.stringify(FAKE_CRED))
process.on('exit', () => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch {}
})

const MODULE_PATH = fileURLToPath(new URL('../tools/video/publish.mjs', import.meta.url))
const { publishVideo, PublishError, __test } = await import(pathToFileURL(MODULE_PATH).href)

// publishVideo 会打印摘要 / JSON（CLI 需要）；测试里静音，避免刷屏（失败信息都在异常里）
console.log = () => {}

const AI_LABEL = '本视频含 AI 生成内容'
const BVID = 'BV1TEST00001'
const AID = 1122334455
const UPOS_URI = 'upos://ugcfx2lf/nABCDEF0123456789.mp4'
const UPOS_HOST = 'upos-test.bilivideo.com'
const UPOS_BASE_PATH = '/ugcfx2lf/nABCDEF0123456789.mp4'
const COVER_URL = 'https://archive.biliimg.com/bfs/archive/test-cover.jpg'

// ── 小工具 ──────────────────────────────────────────────────────────────────
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
const rm = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2))
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const jsonRes = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const textRes = (value, status = 200) => new Response(value, { status, headers: { 'content-type': 'text/plain' } })

/**
 * 造一个完整的「待投稿」目录 + videoRoot。
 * 默认全是合法内容；用 overrides 改单个环节来打闸门。
 */
function makeVideoDir(t, { slug = 'day0-test', publish = {}, review = {}, index = null, config = {} } = {}) {
  const dir = tmpDir('whale-pub-dir-')
  const root = tmpDir('whale-pub-root-')
  t.after(() => { rm(dir); rm(root) })
  const pub = {
    titleForPost: '我，一条只会刷 B 站的鱼，开始做视频了',
    description: `今天把账号交给一条鱼了。\n${AI_LABEL}，画面与配音都是 AI 合成的。`,
    tags: ['AI', '日常', '大肥鱼'],
    aiLabel: AI_LABEL,
    ...publish,
  }
  writeJson(path.join(dir, 'storyboard.json'), {
    version: 4,
    slug,
    title: '备用标题（storyboard.title）',
    // 红线：画面顶栏必须有 AI 标注（publish 会硬校验）
    topbar: { badge: 'Day 0', label: 'AI 接管中', right: AI_LABEL },
    publish: pub,
    citations: [],
  })
  writeJson(path.join(dir, 'meta.json'), {
    slug,
    title: '备用标题（meta.title）',
    durationSec: 33.2,
    aiLabel: AI_LABEL,
  })
  fs.writeFileSync(path.join(dir, 'video.mp4'), Buffer.alloc(20, 7)) // 20 字节：mock chunk_size=8 → 3 片
  fs.writeFileSync(path.join(dir, 'cover.jpg'), Buffer.alloc(12, 3))
  // review 的 evidence 记录"审的是哪一版视频"（publish 用它判 review 是否过期）
  const evidence = {
    videoMtimeMs: fs.statSync(path.join(dir, 'video.mp4')).mtimeMs,
    storyboardMtimeMs: fs.statSync(path.join(dir, 'storyboard.json')).mtimeMs,
    metaMtimeMs: fs.statSync(path.join(dir, 'meta.json')).mtimeMs,
    videoDurationSec: 33.2,
  }
  writeJson(path.join(dir, 'review.json'), { pass: true, score: 92, checks: [], reviewedAt: new Date().toISOString(), evidence, ...review })
  if (index !== null) {
    const file = path.join(root, 'index.json')
    fs.writeFileSync(file, typeof index === 'string' ? index : JSON.stringify(index, null, 2))
  }
  const cfg = {
    outDir: root,
    cadenceDays: 3,
    publish: { enabled: true, tid: 138, partitionName: '生活·日常', copyright: 1, noReprint: true },
    redlines: { requireAiLabel: true, bannedWords: ['刷量', '代实名'] },
    // 真发测试默认打开三重闸（模块层 now 也会校验）
    autoPublish: { dryRun: false, allowGo: true },
    ...config,
  }
  return { dir, root, cfg, slug, publishFile: path.join(dir, 'publish.json'), indexPath: path.join(root, 'index.json') }
}

/** 改过 storyboard/meta 之后刷新 review 的 evidence（模拟"改完再跑一次 review"；否则会被判 review 过期） */
function refreshReviewEvidence(dir) {
  const reviewPath = path.join(dir, 'review.json')
  const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'))
  review.reviewedAt = new Date().toISOString()
  review.evidence = {
    videoMtimeMs: fs.statSync(path.join(dir, 'video.mp4')).mtimeMs,
    storyboardMtimeMs: fs.statSync(path.join(dir, 'storyboard.json')).mtimeMs,
    metaMtimeMs: fs.statSync(path.join(dir, 'meta.json')).mtimeMs,
    videoDurationSec: review.evidence?.videoDurationSec ?? null,
  }
  fs.writeFileSync(reviewPath, JSON.stringify(review, null, 2))
}
const rejectWith = (code) => (err) => {
  assert.ok(err instanceof PublishError, `应当抛 PublishError，实际是 ${err?.name}: ${err?.message}`)
  assert.equal(err.code, code, `错误码应为 ${code}，实际 ${err.code}（${err.message}）`)
  return true
}

/** 捕获 console.log 输出（测试文件整体静音，这里临时换成收集器）。 */
async function captureLogs(fn) {
  const orig = console.log
  const lines = []
  console.log = (...args) => { lines.push(args.map((v) => String(v)).join(' ')) }
  try {
    return { result: await fn(), lines }
  } finally {
    console.log = orig
  }
}

/** 记录全部请求；按 B 站协议给假响应。riskAt 指定第几步回 412。 */
function createTransport({ riskAt = null } = {}) {
  const calls = []
  const stepOf = (u, method) => {
    if (u.hostname === 'member.bilibili.com') {
      if (u.pathname === '/preupload') return 'preupload'
      if (u.pathname === '/x/vu/web/cover/up') return 'cover'
      if (u.pathname === '/x/vu/web/add/v3') return 'add'
      return `member:${u.pathname}`
    }
    if (u.hostname === UPOS_HOST) {
      if (method === 'PUT') return 'chunk'
      if (u.searchParams.has('uploads')) return 'init'
      if (u.searchParams.has('uploadId')) return 'end'
      return `upos:${u.pathname}`
    }
    return `other:${u.hostname}${u.pathname}`
  }
  const transport = async (url, init = {}) => {
    const u = new URL(String(url))
    const method = String(init.method ?? 'GET').toUpperCase()
    const step = stepOf(u, method)
    calls.push({ step, url: String(url), method, host: u.hostname, pathname: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers ?? {}, body: init.body })
    if (riskAt && step === riskAt) {
      return jsonRes({ code: -412, message: '请求被拦截' }, 412)
    }
    switch (step) {
      case 'preupload':
        return jsonRes({ OK: 1, auth: 'FAKE-UPOS-AUTH', biz_id: 500001, chunk_size: 8, endpoint: `//${UPOS_HOST}`, upos_uri: UPOS_URI })
      case 'init':
        return jsonRes({ OK: 1, bucket: 'ugcfx2lf', key: '/nABCDEF0123456789.mp4', upload_id: 'up-test-1' })
      case 'chunk':
        return textRes('MULTIPART_PUT_SUCCESS')
      case 'end':
        return jsonRes({ OK: 1, location: 'ugcfx2lf/nABCDEF0123456789.mp4', bucket: 'ugcfx2lf', key: '/nABCDEF0123456789.mp4' })
      case 'cover':
        return jsonRes({ code: 0, message: '0', ttl: 1, data: { url: COVER_URL } })
      case 'add':
        return jsonRes({ code: 0, message: '0', ttl: 1, data: { aid: AID, bvid: BVID } })
      default:
        throw new Error(`测试 transport 没准备这个请求：${method} ${url}`)
    }
  }
  return { transport, calls }
}

// ── 闸门：自审 ──────────────────────────────────────────────────────────────
test('review 未过（pass:false）→ 拒绝，不写 publish.json', async (t) => {
  const fx = makeVideoDir(t, { review: { pass: false, score: 70 } })
  await assert.rejects(publishVideo({ dir: fx.dir, mode: 'dry', config: fx.cfg }), rejectWith('REVIEW_NOT_PASSED'))
  assert.equal(fs.existsSync(fx.publishFile), false)
})

test('review 缺失 → 拒绝', async (t) => {
  const fx = makeVideoDir(t)
  fs.rmSync(path.join(fx.dir, 'review.json'))
  await assert.rejects(publishVideo({ dir: fx.dir, mode: 'dry', config: fx.cfg }), rejectWith('REVIEW_NOT_PASSED'))
})

// ── 闸门：媒体文件 ──────────────────────────────────────────────────────────
test('视频/封面缺失或 0 字节 → 拒绝', async (t) => {
  const noVideo = makeVideoDir(t)
  fs.rmSync(path.join(noVideo.dir, 'video.mp4'))
  await assert.rejects(publishVideo({ dir: noVideo.dir, mode: 'dry', config: noVideo.cfg }), rejectWith('MISSING_MEDIA'))

  const emptyCover = makeVideoDir(t)
  fs.writeFileSync(path.join(emptyCover.dir, 'cover.jpg'), '')
  await assert.rejects(publishVideo({ dir: emptyCover.dir, mode: 'dry', config: emptyCover.cfg }), rejectWith('MISSING_MEDIA'))
})

// ── 闸门：红线（AI 标注 / 红线词） ──────────────────────────────────────────
test('简介缺「AI 生成」→ 拒绝', async (t) => {
  const fx = makeVideoDir(t, { publish: { description: '今天把账号交给一条鱼了，画面和配音都是合成的。' } })
  await assert.rejects(publishVideo({ dir: fx.dir, mode: 'dry', config: fx.cfg }), rejectWith('REDLINE_AI_LABEL'))
})

test('简介命中红线词 → 拒绝', async (t) => {
  const fx = makeVideoDir(t, { publish: { description: `这条是测试。${AI_LABEL}。顺便刷量。` } })
  await assert.rejects(publishVideo({ dir: fx.dir, mode: 'dry', config: fx.cfg }), (err) => {
    rejectWith('REDLINE_BANNED')(err)
    assert.match(err.message, /刷量/)
    return true
  })
})

// ── 闸门：字段 ──────────────────────────────────────────────────────────────
test('标题空 / 标题超 80 字 / 标签超 10 个 或单个超 20 字 → 拒绝', async (t) => {
  const emptyTitle = makeVideoDir(t, { publish: { titleForPost: '' } })
  // titleForPost 空了会回退 meta.title，所以把 storyboard/meta 的备用标题一起清掉
  writeJson(path.join(emptyTitle.dir, 'storyboard.json'), { version: 4, slug: emptyTitle.slug, title: '', publish: { titleForPost: '', description: `x${AI_LABEL}`, tags: ['AI'] } })
  writeJson(path.join(emptyTitle.dir, 'meta.json'), { slug: emptyTitle.slug })
  refreshReviewEvidence(emptyTitle.dir)
  await assert.rejects(publishVideo({ dir: emptyTitle.dir, mode: 'dry', config: emptyTitle.cfg }), rejectWith('INVALID_TITLE'))

  const longTitle = makeVideoDir(t, { publish: { titleForPost: '鱼'.repeat(81) } })
  await assert.rejects(publishVideo({ dir: longTitle.dir, mode: 'dry', config: longTitle.cfg }), rejectWith('INVALID_TITLE'))

  const manyTags = makeVideoDir(t, { publish: { tags: Array.from({ length: 11 }, (_, i) => `tag${i}`) } })
  await assert.rejects(publishVideo({ dir: manyTags.dir, mode: 'dry', config: manyTags.cfg }), rejectWith('INVALID_TAGS'))

  const longTag = makeVideoDir(t, { publish: { tags: ['a'.repeat(21)] } })
  await assert.rejects(publishVideo({ dir: longTag.dir, mode: 'dry', config: longTag.cfg }), rejectWith('INVALID_TAGS'))
})

// ── 闸门：频率 / 重复 / 索引损坏 / 发布开关 ─────────────────────────────────
test('距上次发布不足 cadenceDays（3 天）→ 拒绝，并给出下次可发时间', async (t) => {
  const last = Date.now() - 86400 * 1000 // 1 天前
  const fx = makeVideoDir(t, {
    index: {
      version: 1,
      videos: [{ slug: 'older-video', title: '上一条', bvid: 'BV1OLDER001', aid: 1001, publishedAt: __test.isoLocal(new Date(last)) }],
      lastPublishedAt: __test.isoLocal(new Date(last)),
    },
  })
  await assert.rejects(publishVideo({ dir: fx.dir, mode: 'dry', config: fx.cfg }), (err) => {
    rejectWith('CADENCE')(err)
    assert.match(err.message, /不足 3 天/)
    assert.match(err.message, /下次可发/)
    assert.ok(err.details?.nextDueAt, '应当带 nextDueAt')
    return true
  })
  assert.equal(fs.existsSync(fx.publishFile), false)
})

test('距上次发布已过 4 天 + 不同 slug → 可以过频率闸（dry 正常出包）', async (t) => {
  const last = Date.now() - 4 * 86400 * 1000
  const fx = makeVideoDir(t, {
    index: {
      version: 1,
      videos: [{ slug: 'older-video', title: '上一条', bvid: 'BV1OLDER001', aid: 1001, publishedAt: __test.isoLocal(new Date(last)) }],
      lastPublishedAt: __test.isoLocal(new Date(last)),
    },
  })
  const result = await publishVideo({ dir: fx.dir, mode: 'dry', config: fx.cfg })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'dry')
})

test('同一 slug 重复发布 → 拒绝（即使频率已过）', async (t) => {
  const last = Date.now() - 10 * 86400 * 1000
  const fx = makeVideoDir(t, {
    index: {
      version: 1,
      videos: [{ slug: 'day0-test', title: '同一条', bvid: 'BV1SAME0001', aid: 1002, publishedAt: __test.isoLocal(new Date(last)) }],
      lastPublishedAt: __test.isoLocal(new Date(last)),
    },
  })
  await assert.rejects(publishVideo({ dir: fx.dir, mode: 'dry', config: fx.cfg }), rejectWith('DUPLICATE_SLUG'))
})

test('index.json 损坏 → 拒绝发布（不静默当没有记录）', async (t) => {
  const fx = makeVideoDir(t, { index: '{ 这不是 json' })
  await assert.rejects(publishVideo({ dir: fx.dir, mode: 'dry', config: fx.cfg }), rejectWith('INDEX_CORRUPT'))
})

test('publish.enabled=false → 拒绝', async (t) => {
  const fx = makeVideoDir(t, { config: { publish: { enabled: false, tid: 138 } } })
  await assert.rejects(publishVideo({ dir: fx.dir, mode: 'dry', config: fx.cfg }), rejectWith('PUBLISH_DISABLED'))
})

// ── dry：不联网 + 投稿包字段 ─────────────────────────────────────────────────
test('dry：不调用 transport、生成 publish.json 且字段齐全', async (t) => {
  const fx = makeVideoDir(t)
  let calls = 0
  const transport = async () => { calls += 1; throw new Error('dry 模式不应该联网') }
  const result = await publishVideo({ dir: fx.dir, mode: 'dry', config: fx.cfg, transport, json: true })

  assert.equal(calls, 0, 'dry 模式必须零网络请求')
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'dry')
  const pkg = result.package
  assert.equal(pkg.title, '我，一条只会刷 B 站的鱼，开始做视频了')
  assert.ok(pkg.desc.includes(AI_LABEL))
  assert.deepEqual(pkg.tags, ['AI', '日常', '大肥鱼'])
  assert.equal(pkg.tid, 138)
  assert.equal(pkg.copyright, 1)
  assert.equal(pkg.no_reprint, 1)
  assert.equal(pkg.aiLabel, AI_LABEL)
  assert.equal(pkg.aiLabelInDesc, true)
  assert.equal(pkg.video, path.join(fx.dir, 'video.mp4'))
  assert.equal(pkg.cover, path.join(fx.dir, 'cover.jpg'))
  assert.equal(pkg.videoBytes, 20)
  assert.equal(pkg.coverBytes, 12)
  assert.equal(pkg.durationSec, 33.2)
  assert.equal(pkg.review.pass, true)
  // 预计请求体：投稿包的核心字段必须都在，且凭据只出现占位符
  assert.equal(pkg.request.method, 'POST')
  assert.match(pkg.request.url, /\/x\/vu\/web\/add\/v3/)
  const body = pkg.request.body
  assert.equal(body.title, pkg.title)
  assert.equal(body.desc, pkg.desc)
  assert.equal(body.tag, 'AI,日常,大肥鱼')
  assert.equal(body.copyright, 1)
  assert.equal(body.no_reprint, 1)
  assert.equal(body.tid, 138)
  assert.equal(body.videos[0].title, pkg.title)
  assert.equal(body.videos[0].filename, '<上传后 upos 文件名（无扩展名）>')
  assert.equal(body.csrf, '<bili_jct>')
  assert.equal(body.subtitle.open, 0)
  assert.equal(body.open_subtitle, true)
  // 落盘
  const onDisk = readJson(fx.publishFile)
  assert.equal(onDisk.mode, 'dry')
  assert.equal(onDisk.title, pkg.title)
  assert.equal(onDisk.request.body.tag, 'AI,日常,大肥鱼')
  // 不泄漏凭据、不动 index.json
  const serialized = JSON.stringify(result) + fs.readFileSync(fx.publishFile, 'utf8')
  for (const secret of Object.values(FAKE_CRED)) assert.ok(!serialized.includes(secret), `输出里不能出现凭据：${secret}`)
  assert.equal(fs.existsSync(fx.indexPath), false)
})

test('dry 覆盖 publish.json 时保留上一次真发的 bvid（previous）', async (t) => {
  const fx = makeVideoDir(t)
  writeJson(fx.publishFile, { version: 1, mode: 'go', bvid: 'BV1PREV0001', aid: 999, publishedAt: '2026-10-20T20:00:00+08:00', title: '旧标题' })
  const result = await publishVideo({ dir: fx.dir, mode: 'dry', config: fx.cfg })
  assert.equal(result.package.previous?.bvid, 'BV1PREV0001')
})

// ── 配置补充项：video.publish.tags / titlePrefix（DESIGN §4） ─────────────────
// 规则：storyboard 自己的内容优先，配置只做"追加"；合并后仍走原来的字段硬闸门。
test('dry：配置 publish.tags 追加到 storyboard 标签后面（去重、trim、空忽略）', async (t) => {
  const fx = makeVideoDir(t, {
    config: {
      publish: {
        enabled: true, tid: 138, partitionName: '生活·日常', copyright: 1, noReprint: true,
        tags: ['幕后', 'AI', '  ', 'AI '], // 'AI' 已在 storyboard 里 → 去重；空串 → 忽略
        titlePrefix: '',
      },
    },
  })
  const result = await publishVideo({ dir: fx.dir, mode: 'dry', config: fx.cfg })
  assert.equal(result.ok, true)
  // storyboard 的 3 个标签保持原顺序在前，配置只补它没有的
  assert.deepEqual(result.package.tags, ['AI', '日常', '大肥鱼', '幕后'])
  assert.equal(result.package.request.body.tag, 'AI,日常,大肥鱼,幕后')
  assert.deepEqual(readJson(fx.publishFile).tags, ['AI', '日常', '大肥鱼', '幕后'])
})

test('dry：配置 publish.titlePrefix 生效，且标题已带同前缀时不重复加', async (t) => {
  const config = {
    publish: {
      enabled: true, tid: 138, partitionName: '生活·日常', copyright: 1, noReprint: true,
      tags: [], titlePrefix: '【AI】',
    },
  }
  const plain = makeVideoDir(t, { config })
  const r1 = await publishVideo({ dir: plain.dir, mode: 'dry', config: plain.cfg })
  assert.equal(r1.package.title, '【AI】我，一条只会刷 B 站的鱼，开始做视频了')
  assert.equal(r1.package.request.body.title, '【AI】我，一条只会刷 B 站的鱼，开始做视频了')
  assert.equal(readJson(plain.publishFile).title, '【AI】我，一条只会刷 B 站的鱼，开始做视频了')

  // storyboard 标题自己已经带前缀 → 原样用，不叠成「【AI】【AI】…」
  const dup = makeVideoDir(t, { config })
  const story = readJson(path.join(dup.dir, 'storyboard.json'))
  story.publish.titleForPost = '【AI】我在标题里已经带前缀了'
  writeJson(path.join(dup.dir, 'storyboard.json'), story)
  refreshReviewEvidence(dup.dir)
  const r2 = await publishVideo({ dir: dup.dir, mode: 'dry', config: dup.cfg })
  assert.equal(r2.package.title, '【AI】我在标题里已经带前缀了')
})

test('dry：配置 tags 合并后超过 10 个 → 仍按原 INVALID_TAGS 拒绝', async (t) => {
  const extra = Array.from({ length: 9 }, (_, i) => `配置标签${i}`)
  const fx = makeVideoDir(t, {
    config: {
      publish: {
        enabled: true, tid: 138, partitionName: '生活·日常', copyright: 1, noReprint: true,
        tags: extra,
      },
    },
  })
  // storyboard 默认 3 个（AI/日常/大肥鱼）+ 配置 9 个 = 12 > 10 → 复用原硬闸门
  await assert.rejects(publishVideo({ dir: fx.dir, mode: 'dry', config: fx.cfg }), (err) => {
    rejectWith('INVALID_TAGS')(err)
    assert.match(err.message, /超过 10 个/)
    return true
  })
  assert.equal(fs.existsSync(fx.publishFile), false)
})

// ── 与 A 的 CLI 的兼容（它传 dry/go 布尔，并且自己打印） ─────────────────────
test('CLI 调用形状 dry:true/go:false → 走 dry、写投稿包，且本模块不重复打印', async (t) => {
  const fx = makeVideoDir(t)
  const { result, lines } = await captureLogs(() => publishVideo({
    dir: fx.dir, config: fx.cfg, dry: true, go: false, json: true,
  }))
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'dry')
  assert.match(result.message, /投稿包已生成/)
  assert.deepEqual(lines, [], '调用方自己打印时本模块不能再输出')
  assert.equal(readJson(fx.publishFile).mode, 'dry')
})

test('非法 mode → INVALID_MODE', async (t) => {
  const fx = makeVideoDir(t)
  await assert.rejects(publishVideo({ dir: fx.dir, mode: 'auto', config: fx.cfg }), rejectWith('INVALID_MODE'))
})

// ── 缺凭据 ──────────────────────────────────────────────────────────────────
test('go 模式缺凭据 → AUTH_MISSING，且不发任何网络请求', async (t) => {
  const fx = makeVideoDir(t)
  const backup = fs.readFileSync(CRED_FILE)
  fs.rmSync(CRED_FILE)
  t.after(() => fs.writeFileSync(CRED_FILE, backup))
  let calls = 0
  const transport = async () => { calls += 1; throw new Error('缺凭据时不应该发请求') }
  await assert.rejects(publishVideo({ dir: fx.dir, mode: 'go', config: fx.cfg, transport, confirm: true }), rejectWith('AUTH_MISSING'))
  assert.equal(calls, 0)
  assert.equal(fs.existsSync(fx.publishFile), false)
})

// ── go：mock transport 走完 preupload → 分片 → 结束 → 封面 → 提交 → 记账 ──
test('go：mock transport 走完投稿流程，写 publish.json + index.json（A 的 CLI 调用形状）', async (t) => {
  const fx = makeVideoDir(t)
  const { transport, calls } = createTransport()
  // A 的 commands/video.mjs 就是这么调的：{ dir, config, dry:!go, go, json }（不是 mode）
  const { result, lines } = await captureLogs(() => publishVideo({
    dir: fx.dir, config: fx.cfg, dry: false, go: true, confirm: true, json: true, transport,
  }))
  assert.deepEqual(lines, [], '调用方自己打印时，本模块不能再输出（否则 --json 会出现两份 JSON）')
  assert.match(result.message, /bvid=BV1TEST00001/)

  assert.equal(result.ok, true)
  assert.equal(result.mode, 'go')
  assert.equal(result.bvid, BVID)
  assert.equal(result.aid, AID)
  assert.ok(Number.isFinite(Date.parse(result.publishedAt)))

  // 请求顺序：preupload → init → 3 片 → end → cover → add
  assert.deepEqual(calls.map((c) => c.step), ['preupload', 'init', 'chunk', 'chunk', 'chunk', 'end', 'cover', 'add'])
  const preupload = calls[0]
  assert.equal(preupload.method, 'GET')
  assert.equal(preupload.query.name, 'video.mp4')
  assert.equal(preupload.query.size, '20')
  assert.equal(preupload.query.r, 'upos')
  assert.equal(preupload.query.profile, 'ugcfx/bup')
  assert.ok(String(preupload.headers.cookie).includes(`SESSDATA=${FAKE_CRED.sessdata}`))

  const init = calls[1]
  assert.equal(init.method, 'POST')
  assert.equal(init.query.uploads, '')
  assert.equal(init.query.filesize, '20')
  assert.equal(init.query.partsize, '8')
  assert.equal(init.query.biz_id, '500001')
  assert.equal(init.headers['X-Upos-Auth'], 'FAKE-UPOS-AUTH')

  const chunkCalls = calls.filter((c) => c.step === 'chunk')
  assert.equal(chunkCalls.length, 3, '20 字节 / 8 字节一片 = 3 片')
  chunkCalls.forEach((c, i) => {
    assert.equal(c.method, 'PUT')
    assert.equal(c.query.partNumber, String(i + 1))
    assert.equal(c.query.chunk, String(i))
    assert.equal(c.query.chunks, '3')
    assert.equal(c.query.uploadId, 'up-test-1')
    assert.equal(c.query.total, '20')
    assert.equal(c.query.start, String(i * 8))
    assert.equal(c.query.end, String(i * 8 + (i === 2 ? 4 : 8)))
    assert.equal(c.query.size, String(i === 2 ? 4 : 8))
    assert.equal(c.headers['X-Upos-Auth'], 'FAKE-UPOS-AUTH')
    assert.equal(Buffer.isBuffer(c.body) ? c.body.length : c.body?.length, i === 2 ? 4 : 8)
  })

  const end = calls[5]
  assert.equal(end.method, 'POST')
  assert.equal(end.query.name, 'video.mp4')
  assert.equal(end.query.uploadId, 'up-test-1')
  assert.equal(end.query.biz_id, '500001')
  const endBody = JSON.parse(String(end.body))
  assert.deepEqual(endBody.parts.map((p) => p.partNumber), [1, 2, 3])
  assert.ok(endBody.parts.every((p) => p.eTag === 'etag'))

  const cover = calls[6]
  assert.equal(cover.method, 'POST')
  const coverBody = cover.body instanceof URLSearchParams ? cover.body : new URLSearchParams(String(cover.body))
  assert.equal(coverBody.get('csrf'), FAKE_CRED.bili_jct)
  assert.ok(coverBody.get('cover').startsWith('data:image/jpeg;base64,'))

  const add = calls[7]
  assert.equal(add.method, 'POST')
  assert.match(add.url, /csrf=/)
  const addBody = JSON.parse(String(add.body))
  assert.equal(addBody.title, result.title)
  assert.equal(addBody.copyright, 1)
  assert.equal(addBody.no_reprint, 1)
  assert.equal(addBody.tid, 138)
  assert.equal(addBody.tag, 'AI,日常,大肥鱼')
  assert.ok(addBody.desc.includes(AI_LABEL))
  assert.equal(addBody.videos.length, 1)
  assert.equal(addBody.videos[0].filename, 'nABCDEF0123456789') // 去目录、去扩展名
  assert.equal(addBody.videos[0].cid, 500001) // biz_id
  assert.equal(addBody.videos[0].title, result.title)
  assert.equal(addBody.cover, COVER_URL)
  assert.equal(addBody.csrf, FAKE_CRED.bili_jct)
  assert.equal(addBody.open_subtitle, true)
  assert.equal(addBody.web_os, 3)
  assert.equal(addBody.subtitle.open, 0)

  // 本地记账：publish.json
  const record = readJson(fx.publishFile)
  assert.equal(record.mode, 'go')
  assert.equal(record.bvid, BVID)
  assert.equal(record.aid, AID)
  assert.equal(record.title, result.title)
  assert.equal(record.publishedAt, result.publishedAt)
  assert.equal(record.aiLabel, AI_LABEL)
  assert.equal(record.coverUrl, COVER_URL)
  // index.json：{version:1, videos:[...], lastPublishedAt}
  const index = readJson(fx.indexPath)
  assert.equal(index.version, 1)
  assert.equal(index.lastPublishedAt, record.publishedAt)
  assert.equal(index.videos.length, 1)
  assert.deepEqual(
    { slug: index.videos[0].slug, title: index.videos[0].title, bvid: index.videos[0].bvid, aid: index.videos[0].aid, publishedAt: index.videos[0].publishedAt },
    { slug: fx.slug, title: record.title, bvid: BVID, aid: AID, publishedAt: record.publishedAt },
  )
  // 凭据不落盘
  const disk = fs.readFileSync(fx.publishFile, 'utf8') + fs.readFileSync(fx.indexPath, 'utf8')
  for (const secret of Object.values(FAKE_CRED)) assert.ok(!disk.includes(secret), `落盘文件里不能出现凭据：${secret}`)
})

// ── 412：立即停止、不重试、不写发布记录 ─────────────────────────────────────
test('提交阶段 412 → 抛 RISK_BLOCKED、不重试、不写 publish.json/index.json', async (t) => {
  const fx = makeVideoDir(t)
  const { transport, calls } = createTransport({ riskAt: 'add' })
  await assert.rejects(publishVideo({ dir: fx.dir, mode: 'go', config: fx.cfg, transport, confirm: true, json: true }), (err) => {
    rejectWith('RISK_BLOCKED')(err)
    assert.match(err.message, /风控/)
    assert.match(err.message, /412/)
    assert.match(err.message, /平台原文/)
    assert.match(err.message, /请求被拦截/)
    return true
  })
  assert.equal(calls.filter((c) => c.step === 'add').length, 1, '412 后不得重试')
  assert.equal(fs.existsSync(fx.publishFile), false, '失败不写发布记录')
  assert.equal(fs.existsSync(fx.indexPath), false, '失败不动发布索引')
})

// ── 非 0 code：同样立即停止（带平台原文） ───────────────────────────────────
test('提交返回非 0 code → 抛 API_ERROR，不写发布记录', async (t) => {
  const fx = makeVideoDir(t)
  const { transport, calls } = createTransport()
  const wrapped = async (url, init) => {
    const u = new URL(String(url))
    if (u.hostname === 'member.bilibili.com' && u.pathname === '/x/vu/web/add/v3') {
      calls.push({ step: 'add-fail', url: String(url) })
      return jsonRes({ code: -400, message: '请求参数错误', ttl: 1 }, 200)
    }
    return transport(url, init)
  }
  await assert.rejects(publishVideo({ dir: fx.dir, mode: 'go', config: fx.cfg, transport: wrapped, confirm: true, json: true }), (err) => {
    rejectWith('API_ERROR')(err)
    assert.match(err.message, /请求参数错误/)
    return true
  })
  assert.equal(calls.filter((c) => c.step === 'add-fail').length, 1)
  assert.equal(fs.existsSync(fx.publishFile), false)
  assert.equal(fs.existsSync(fx.indexPath), false)
})

test('封面上传被平台拒绝 → COVER_FAILED，不提交稿件', async (t) => {
  const fx = makeVideoDir(t)
  const { transport } = createTransport()
  const wrapped = async (url, init) => {
    const u = new URL(String(url))
    if (u.hostname === 'member.bilibili.com' && u.pathname === '/x/vu/web/cover/up') {
      return jsonRes({ code: -400, message: '图片格式不对', ttl: 1 }, 200)
    }
    return transport(url, init)
  }
  await assert.rejects(publishVideo({ dir: fx.dir, mode: 'go', config: fx.cfg, transport: wrapped, confirm: true, json: true }), (err) => {
    rejectWith('COVER_FAILED')(err)
    assert.match(err.message, /图片格式不对/)
    return true
  })
  assert.equal(fs.existsSync(fx.publishFile), false)
  assert.equal(fs.existsSync(fx.indexPath), false)
})

// ── 纯函数级：协议构造细节（公开协议未实测的部分锁在这里） ──────────────────
test('upos 地址拼接兼容 upos:// 与已带 host 两种返回', () => {
  assert.equal(
    __test.uposBaseUrl({ endpoint: '//upos-cs-upcdntxa.bilivideo.com', upos_uri: 'upos://ugcfx2lf/n240728.mp4' }),
    'https://upos-cs-upcdntxa.bilivideo.com/ugcfx2lf/n240728.mp4',
  )
  assert.equal(
    __test.uposBaseUrl({ endpoint: '', upos_uri: '//upos-cs-upcdntxa.bilivideo.com/ugcfx2lf/n240728.mp4' }),
    'https://upos-cs-upcdntxa.bilivideo.com/ugcfx2lf/n240728.mp4',
  )
  assert.throws(() => __test.uposBaseUrl({ endpoint: '', upos_uri: '' }), (e) => e instanceof PublishError && e.code === 'UPLOAD_FAILED')
})

test('videos[].filename = upos_uri 去目录去扩展名；AI 标注匹配忽略空格', () => {
  assert.equal(__test.objectKeyFilename('upos://ugcfx2lf/n240728ad33h52yqhxbtw51cb06sq9gx.mp4'), 'n240728ad33h52yqhxbtw51cb06sq9gx')
  assert.equal(__test.objectKeyFilename('ugcfx2lf/abc.mkv'), 'abc')
  assert.equal(__test.normalizeDesc('本视频含 AI 生成内容'), '本视频含AI生成内容')
  assert.ok(__test.normalizeDesc('本视频含AI生成内容').includes('AI生成'))
  assert.equal(__test.charLen('🐟鱼'), 2)
})
