#!/usr/bin/env node
/**
 * video.mjs — 「视频管线」子命令实现（由 tools/bili-faship.mjs 作为主入口调用）。
 *
 *   node tools/bili-faship.mjs plan    --dir <dir> [--topic <主题>] [--json]
 *   node tools/bili-faship.mjs render  --dir <dir> [--json]
 *   node tools/bili-faship.mjs review  --dir <dir> [--json]
 *   node tools/bili-faship.mjs publish --dir <dir> [--dry|--go] [--json]
 *   node tools/bili-faship.mjs status  [--json]
 *   node tools/bili-faship.mjs deps    [--json]
 *
 * 设计约束（DESIGN §3/§4/§11）：
 *  · 投稿**不在本文件实现**：publish 只动态 import ../video/publish.mjs 并转发；
 *    模块不存在就提示「投稿模块未安装」，绝不自己调 B 站上传接口；
 *  · 配置/路径的唯一真相是 ../lib/video-config.mjs + ../lib/paths.mjs（不再读 dsh-bili-whale 的 config.mjs），
 *    persona 等人设信息从 videoConfig().persona 取；
 *  · 没有"看视频内容"这类旧命令；未知子命令 → 报错 + 帮助（exit 2），不静默透传；
 *  · 所有失败：打印可读原因 + 非 0 退出码。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { videoConfig, videoRoot, videoDir } from '../lib/video-config.mjs'
import { configPath } from '../lib/paths.mjs'
import { collectDeps } from '../lib/deps.mjs'
import { writePlan, readStoryboard, readJson, formatProblemList, storyboardPath, slugify, today } from '../video/storyboard.mjs'
import { renderVideo } from '../video/render.mjs'
import { reviewVideo, readReview } from '../video/review.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOOLS = path.dirname(HERE)
const PUBLISH_MODULE = path.join(TOOLS, 'video', 'publish.mjs')

export const SUBCOMMANDS = ['plan', 'render', 'review', 'publish', 'status', 'deps', 'help']

/** 帮助文案：带上当前生效的配置/路径，排查"到底读的哪份配置"时最有用。 */
function helpText() {
  let rootNow = ''
  try { rootNow = videoRoot() } catch { rootNow = '(配置读取失败)' }
  return `视频创作（全权）：plan/render/review/publish/status/deps

用法:
  node tools/bili-faship.mjs plan    --dir <dir> [--topic <主题>] [--json] [--width 320 --height 180 --fps 15]
      生成 <dir>/storyboard.json（已存在则只校验、不覆盖）。
      省略 --dir 时，按 --topic 生成目录名并落到 <视频根>/<slug>。
      --width/--height/--fps 只影响新模板（端到端冒烟用 320x180，正式片默认 1920x1080）。

  node tools/bili-faship.mjs render  --dir <dir> [--json]
      TTS → 时间轴/字幕 → 逐帧渲染 → 混音 → <dir>/video.mp4 等。
      失败非 0；不会留半成品。

  node tools/bili-faship.mjs review  --dir <dir> [--json]
      代码自审：schema/时长/响度/字幕覆盖/AI 标注/引用标注/红线词。
      写 <dir>/review.json；exit 0 = pass，1 = fail。自审是发布前置条件。

  node tools/bili-faship.mjs publish --dir <dir> [--dry|--go] [--json]
      默认 --dry 只生成投稿包、不联网；--go 才真发（自审 PASS + 频率闸）。

  node tools/bili-faship.mjs status  [--json]
      最近发布 / 下次到期 / 待发（自审 pass 未发）。

  node tools/bili-faship.mjs deps    [--json]
      依赖体检：node / ffmpeg / Python+Pillow / BGM 资源 / 字体 / 表情包 / cookie / 日记 / 目录。
      硬依赖缺失 → exit 1。

  node tools/bili-faship.mjs help
      本帮助。

当前配置:
  配置文件：${configPath}
  成片根目录：${rootNow}

安全约定:
  · 开发/测试期间不要真投稿；--go 只在主人明确同意后使用
  · 自审 review.pass 是硬条件，publish 模块自己也会复查
  · 真发还要设置里 autoPublish.allowGo=true 且调用方显式 confirm
`
}

/** 极简参数解析：--key value / --key（布尔 flag）。 */
export function parseArgs(argv = []) {
  const opt = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i])
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const v = argv[i + 1]
      if (v === undefined || String(v).startsWith('--')) opt[key] = true
      else { opt[key] = v; i += 1 }
    } else positional.push(a)
  }
  return { opt, positional }
}

// ---------------------------------------------------------------------------
// status（数据源：<videoRoot>/index.json，格式由 Lead 定，宿主/CLI 共用）
// ---------------------------------------------------------------------------

/**
 * 读 <root>/index.json。
 *  · 不存在 = 从未发布（state:'missing'，当作 due）；
 *  · 存在但 JSON 坏了/格式不对 = **报错**（不能当成"从未发布"）。
 */
export function loadPublishIndex(root) {
  const file = path.join(root, 'index.json')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { state: 'missing', file, index: { version: 1, videos: [], lastPublishedAt: null } }
    throw new Error(`读取投稿索引失败：${file}（${e.message}）`)
  }
  let index
  try {
    index = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (e) {
    throw new Error(`投稿索引损坏（不要当成"从未发布"）：${file}：${e.message}`)
  }
  if (!index || typeof index !== 'object' || !Array.isArray(index.videos)) {
    throw new Error(`投稿索引格式不对：${file}（应形如 { version, videos: [], lastPublishedAt }）`)
  }
  return { state: 'ok', file, index }
}

function parseTime(v, where) {
  const t = Date.parse(String(v))
  if (Number.isNaN(t)) throw new Error(`${where} 不是合法时间：${JSON.stringify(v)}`)
  return t
}

function safeReadJson(file) {
  try {
    return readJson(file)
  } catch {
    return null
  }
}

function scanVideoDirs(root) {
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const dir = path.join(root, e.name)
    if (!fs.existsSync(storyboardPath(dir))) continue
    dirs.push(dir)
  }
  return dirs
}

/**
 * 创作/发布状态。
 * @param {{root?:string, config?:object, now?:Date, dirs?:string[]}} opts
 * @returns {{
 *   root:string, indexState:'ok'|'missing', indexFile:string,
 *   last:({slug,title,publishedAt,bvid,aid?}|null), lastPublishedAt:string|null,
 *   nextDueAt:string|null, cadenceDays:number, due:boolean,
 *   pending:Array<{slug:string,title:string,dir:string,reviewedAt?:string}>
 * }}
 */
export function videoStatus(opts = {}) {
  const cfg = opts.config || videoConfig()
  const root = path.resolve(opts.root || videoRoot())
  const now = opts.now instanceof Date ? opts.now : new Date()
  const cadenceDays = Number(cfg.cadenceDays ?? 3)
  const { state, file, index } = loadPublishIndex(root)

  const videos = index.videos.filter((v) => v && typeof v === 'object' && typeof v.slug === 'string')
  const publishedSlugs = new Set(videos.map((v) => v.slug))
  const sorted = videos.slice().sort((a, b) => parseTime(a.publishedAt ?? 0, `index.videos ${a.slug}.publishedAt`) - parseTime(b.publishedAt ?? 0, `index.videos ${b.slug}.publishedAt`))
  const last = sorted.length ? sorted[sorted.length - 1] : null
  const lastPublishedAt = index.lastPublishedAt ?? last?.publishedAt ?? null
  let nextDueAt = null
  let due = true
  if (lastPublishedAt) {
    const lastMs = parseTime(lastPublishedAt, 'index.lastPublishedAt')
    nextDueAt = new Date(lastMs + cadenceDays * 86400000).toISOString()
    due = now.getTime() >= Date.parse(nextDueAt)
  }

  const scanDirs = Array.isArray(opts.dirs) ? opts.dirs.map((d) => path.resolve(d)) : scanVideoDirs(root)
  const pending = []
  for (const dir of scanDirs) {
    let story = null
    try {
      story = readStoryboard(dir).story
    } catch {
      story = safeReadJson(storyboardPath(dir))
    }
    const slug = String(story?.slug || path.basename(dir))
    if (publishedSlugs.has(slug)) continue
    const publish = safeReadJson(path.join(dir, 'publish.json'))
    if (publish && publish.bvid) continue
    const review = readReview(dir)
    if (!review || review.pass !== true) continue
    const meta = safeReadJson(path.join(dir, 'meta.json'))
    pending.push({
      slug,
      title: String(story?.title || meta?.title || publish?.title || slug),
      dir,
      reviewedAt: review.reviewedAt || null,
    })
  }

  return {
    root,
    indexState: state,
    indexFile: file,
    last: last
      ? {
          slug: last.slug,
          title: String(last.title ?? ''),
          bvid: last.bvid ?? null,
          aid: last.aid ?? null,
          publishedAt: last.publishedAt ?? null,
        }
      : null,
    lastPublishedAt,
    nextDueAt,
    cadenceDays,
    due,
    pending,
  }
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------

function cmdPlan(opt, asJson) {
  const topic = typeof opt.topic === 'string' ? opt.topic : ''
  const cfg = videoConfig()
  // 人设从插件配置取（DESIGN §4 persona），不再依赖 dsh-bili-whale 的 config.mjs
  const persona = cfg.persona && typeof cfg.persona === 'object' ? cfg.persona : {}
  let dir
  if (typeof opt.dir === 'string' && opt.dir) dir = path.resolve(opt.dir)
  else {
    const slug = slugify(topic || `video-${today()}`, `video-${today()}`)
    dir = videoDir(slug, cfg)
  }
  const num = (v) => (v !== undefined && v !== true && Number.isFinite(Number(v)) ? Number(v) : undefined)
  const result = writePlan(dir, {
    topic: topic || undefined,
    persona,
    width: num(opt.width),
    height: num(opt.height),
    fps: num(opt.fps),
  })
  if (asJson) {
    console.log(JSON.stringify({
      ok: result.result.ok,
      created: result.created,
      dir: result.dir,
      file: result.file,
      errors: result.result.errors,
      warnings: result.result.warnings,
    }, null, 2))
    return result.result.ok ? 0 : 1
  }
  console.log(`[video plan] ${result.created ? '已生成模板' : '已存在，只校验未覆盖'}：${result.file}`)
  if (result.result.warnings.length) console.log(formatProblemList([], result.result.warnings))
  if (!result.result.ok) {
    console.error(`✗ storyboard 校验失败：\n${formatProblemList(result.result.errors)}`)
    return 1
  }
  if (result.created) {
    console.log('下一步：改 scenes 里的 narration/card（可用表情/卡片种类见 storyboard 里的 _hints），然后：')
    console.log(`  node tools/bili-faship.mjs render --dir ${result.dir}`)
    console.log(`  node tools/bili-faship.mjs review --dir ${result.dir}`)
  } else {
    console.log('✓ 校验通过（不会覆盖已有文件）')
  }
  return 0
}

async function cmdRender(opt, asJson) {
  const dir = typeof opt.dir === 'string' ? opt.dir : ''
  if (!dir) {
    console.error('render 需要 --dir <视频目录>（先 plan --dir <dir>）')
    return 2
  }
  const cfg = videoConfig()
  if (asJson) console.error(`[video render] 渲染中：${path.resolve(dir)}（TTS/逐帧渲染可能要几分钟）…`)
  try {
    const result = await renderVideo({ dir, config: cfg })
    if (asJson) {
      console.log(JSON.stringify({
        ok: true,
        dir: result.dir,
        video: result.video,
        cover: result.cover,
        subtitles: result.subtitles,
        timing: result.timing,
        meta: result.meta,
        durationSec: result.durationSec,
        warnings: result.warnings,
      }, null, 2))
    } else {
      console.log(`✓ 成片：${result.video}`)
      console.log(`  封面：${result.cover}`)
      console.log(`  字幕：${result.subtitles}`)
      console.log(`  时长：${Number(result.durationSec).toFixed(1)}s`)
      for (const w of result.warnings || []) console.log(`  提醒：${w}`)
      console.log(`下一步自审：node tools/bili-faship.mjs review --dir ${result.dir}`)
    }
    return 0
  } catch (e) {
    console.error(`✗ 渲染失败：${e.message}`)
    return 1
  }
}

async function cmdReview(opt, asJson) {
  const dir = typeof opt.dir === 'string' ? opt.dir : ''
  if (!dir) {
    console.error('review 需要 --dir <视频目录>')
    return 2
  }
  try {
    const result = await reviewVideo({ dir, config: videoConfig() })
    if (asJson) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`[video review] ${result.pass ? '✓ PASS' : '✗ FAIL'} · 评分 ${result.score} · ${result.reviewPath}`)
      for (const c of result.checks) {
        const mark = c.ok ? '✓' : '✗'
        console.log(`  ${mark} ${c.id}${c.hard ? '' : '（软）'}：${c.detail}`)
      }
    }
    return result.pass ? 0 : 1
  } catch (e) {
    console.error(`✗ 自审失败：${e.message}`)
    return 1
  }
}

async function cmdPublish(opt, asJson) {
  const dir = typeof opt.dir === 'string' ? opt.dir : ''
  if (!dir) {
    console.error('publish 需要 --dir <视频目录>')
    return 2
  }
  if (!fs.existsSync(PUBLISH_MODULE)) {
    console.error('投稿模块未安装（缺 tools/video/publish.mjs）。本命令只负责转发，不会自己投稿。')
    return 2
  }
  const go = opt.go === true && opt.dry !== true
  try {
    const mod = await import(pathToFileURL(PUBLISH_MODULE).href)
    const fn = mod.publishVideo || mod.publish || mod.default
    if (typeof fn !== 'function') {
      console.error('投稿模块未安装（publish.mjs 没有导出 publishVideo/publish）')
      return 2
    }
    const result = await fn({
      dir: path.resolve(dir),
      config: videoConfig(),
      dry: !go,
      go,
      json: asJson,
    })
    if (asJson) console.log(JSON.stringify(result ?? null, null, 2))
    else if (result && typeof result === 'object') console.log(result.message || `发布流程结束：${JSON.stringify(result).slice(0, 500)}`)
    if (typeof result?.exitCode === 'number') return result.exitCode
    return result?.pass === false || result?.ok === false ? 1 : 0
  } catch (e) {
    console.error(`✗ 发布失败：${e.message}`)
    return 1
  }
}

function cmdStatus(opt, asJson) {
  try {
    const status = videoStatus({})
    if (asJson) {
      console.log(JSON.stringify(status, null, 2))
      return 0
    }
    console.log(`[video status] 视频根目录：${status.root}`)
    if (status.indexState === 'missing') console.log('  投稿索引：不存在（从未发布 → 现在可以发）')
    else console.log(`  投稿索引：${status.indexFile}`)
    console.log(status.last
      ? `  上次发布：${status.last.title || status.last.slug}（${status.last.slug}）· ${status.last.publishedAt || '?'}${status.last.bvid ? ` · ${status.last.bvid}` : ''}`
      : '  上次发布：无')
    if (status.nextDueAt) {
      console.log(`  下次到期：${status.nextDueAt}（每 ${status.cadenceDays} 天一条）`)
      console.log(`  现在：${status.due ? '✓ 可以发' : '⏳ 还没到期'}`)
    } else {
      console.log(`  下次到期：现在（每 ${status.cadenceDays} 天一条）`)
      console.log('  现在：✓ 可以发')
    }
    console.log(`  待发（自审 pass 未发）：${status.pending.length} 条`)
    for (const p of status.pending) console.log(`    · ${p.slug} — ${p.title}${p.reviewedAt ? `（${p.reviewedAt}）` : ''}`)
    return 0
  } catch (e) {
    console.error(`✗ 读状态失败：${e.message}`)
    return 1
  }
}

async function cmdDeps(opt, asJson) {
  try {
    const result = collectDeps()
    if (asJson) {
      console.log(JSON.stringify(result, null, 2))
      return result.ok ? 0 : 1
    }
    console.log(`[video deps] ${result.ok ? '✓ 硬依赖齐全' : '✗ 有硬依赖缺失'}`)
    for (const it of result.items) {
      const mark = it.ok ? '✓' : (it.optional ? '⚠' : '✗')
      console.log(`  ${mark} ${it.name}${it.optional ? '（可选）' : ''}：${it.detail}`)
      if (!it.ok && it.fix) console.log(`      → ${it.fix}`)
    }
    return result.ok ? 0 : 1
  } catch (e) {
    console.error(`✗ 依赖体检失败：${e.message}`)
    return 1
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 执行一个子命令。供 tools/bili-faship.mjs 调用，也可直接 `node tools/commands/video.mjs ...`。
 * @param {string[]} argv 不含 node/脚本名
 * @returns {Promise<number>} 退出码
 */
export async function main(argv = []) {
  const { opt, positional } = parseArgs(argv)
  const sub = positional[0]
  if (!sub || sub === 'help' || opt.help === true || opt.h === true) {
    console.log(helpText())
    return 0
  }
  const asJson = opt.json === true
  if (!SUBCOMMANDS.includes(sub)) {
    // 独立插件不再有"旧命令透传"：拼错了就明确报错，不猜用户想跑什么
    console.error(`✗ 未知子命令：${sub}（可用：${SUBCOMMANDS.join(' / ')}）\n`)
    console.log(helpText())
    return 2
  }
  switch (sub) {
    case 'plan':
      return cmdPlan(opt, asJson)
    case 'render':
      return cmdRender(opt, asJson)
    case 'review':
      return cmdReview(opt, asJson)
    case 'publish':
      return cmdPublish(opt, asJson)
    case 'status':
      return cmdStatus(opt, asJson)
    case 'deps':
      return cmdDeps(opt, asJson)
    default:
      console.log(helpText())
      return 0
  }
}

const isMain = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  } catch {
    return false
  }
})()

if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  }).catch((e) => {
    console.error(`✗ 未捕获错误：${e?.stack || e?.message || e}`)
    process.exitCode = 1
  })
}
