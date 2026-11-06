// 视频创作配置层 —— dsh-bili-faship（**配置唯一真相**，DESIGN §3/§4）
//
// 为什么把它放在 tools/lib/ 而不是宿主 lib/：
//   · 宿主半端（Electron 里的 lib/config.mjs）和独立 CLI（tools/bili-faship.mjs）都跑同一份代码，
//     `VIDEO_DEFAULTS` 只在这里定义一次，字段一改两边同时生效，不会出现"设置页存了、CLI 不认"；
//   · 宿主写配置后调用 resetVideoConfig() 让进程内缓存失效即可，不需要重启。
//
// 查找顺序：
//   配置内容 = VIDEO_DEFAULTS ← 旧 dsh-bili-whale 配置的 video 段（兼容） ← 新配置 { version, video } 段
//   配置文件 = $BILI_FASHIP_CONFIG → <DSH_HOME>/bili-faship.config.json
//   旧配置文件 = $BILI_WHALE_CONFIG → <DSH_HOME>/bili-whale.config.json（只取其中的 video 段）
//
// 用户文件形状：{ "version": 1, "video": { ... } }；也兼容"字段平铺在根上"的旧写法。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  configPath,
  legacyConfigPath,
  dshPath,
  videosDir,
  cacheDir,
  stickersDir,
} from './paths.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 插件根目录（package.json 所在目录）：内置资源（BGM/音效/字体）相对它定位。 */
export const ROOT = path.resolve(HERE, '..', '..')

/** 配置文件元信息（宿主 / CLI 展示用；真正读取走 readUserConfig()，便于测试覆盖 env）。 */
export const CONFIG_FILE = configPath

/** 旧 dsh-bili-whale 配置位置（只用于 video 段兜底）。 */
export const LEGACY_CONFIG_FILE = legacyConfigPath

/**
 * 视频创作的默认值（DESIGN §4 的默认值即本对象）。
 * 原则：默认值必须"不改也能跑"（全权设计：自审通过即可发布，但真发还要 allowGo + confirm 两道闸）。
 */
export const VIDEO_DEFAULTS = {
  enabled: true,
  outDir: '', // 空 = <DSH_HOME>/bili-faship/videos
  cadenceDays: 3,
  minDurationSec: 15,
  maxDurationSec: 180,
  voice: { voice: 'zh-CN-XiaoyiNeural', rate: '+8%', pitch: '+8Hz' },
  selfReview: {
    enabled: true,
    passScore: 80,
    minSubtitleCoverage: 0.9,
    loudnessRange: [-20, -12],
    requireAiLabel: true,
    requireRedlineCard: false,
    maxClipSec: 3,
  },
  publish: {
    enabled: true,
    dryRunByDefault: true,
    selfApprove: true,
    profile: 'ugcfx/bup',
    tid: 138, // 生活·日常
    partitionName: '生活·日常',
    copyright: 1, // 1 = 自制
    noReprint: true,
    tags: [], // 追加标签（投稿时合到 storyboard.publish.tags 后面）
    titlePrefix: '', // 可选：标题前缀
  },
  redlines: {
    requireAiLabel: true,
    forbidImpersonation: true,
    forbidSpam: true,
    forbidUncreditedClips: true,
    bannedWords: ['政治敏感', '赌博', '色情', '诈骗', '代实名', '刷量'],
  },
  persona: {
    name: '大肥鱼',
    ownerTitle: '主人',
    selfClaim: '我',
  },
  materials: {
    // 日记素材（只读；原作者本机的默认位置；换机器在设置页改）
    diary: [
      'D:/bilibili-scroll/bili_whale/whale-diary.md',
      'D:/bilibili-scroll/bili_whale/whale-diary-private.md',
    ],
    extraNotes: [],
  },
  // 外部工具/素材路径：留空 = 用默认解析链（DESIGN §3）
  paths: {
    stickers: '',
    cache: '',
    python: '',
    ffmpeg: '',
  },
  schedule: {
    enabled: true,
    window: { start: '21:00', end: '23:30' },
    minGapMinutes: 10,
    cooldownHours: 30,
  },
  // 真发总闸：allowGo 默认关；即使打开，工具/HTTP 还要求调用方显式 confirm:true
  autoPublish: { dryRun: true, allowGo: false },
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v.trim() : '')

/** 深合并（只合普通对象；数组/标量直接覆盖，保持配置语义直观）。 */
function merge(base, over) {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v
  }
  return out
}

/** 读一个 JSON 文件；不存在/损坏都返回 null（配置是"锦上添花"，坏文件不该让插件起不来）。 */
function readJsonFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/** 从一份用户配置里取 video 段：标准写法 { video } 优先，否则把根字段当平铺写法。 */
function videoSection(raw) {
  if (!isObj(raw)) return {}
  if (isObj(raw.video)) return raw.video
  // 平铺写法：version 是元信息，不属于任何一段
  const { version: _version, ...flat } = raw
  return flat
}

/**
 * 读用户配置（新文件优先、旧文件兜底；都只取各自的 video 段）。
 * 导出是为了让宿主"保存前读旧值"和测试复用同一套规则。
 */
export function readUserConfig() {
  const legacyFile = LEGACY_CONFIG_FILE
  // 旧文件只取 video 段（DESIGN §3 的兼容要求），且新旧文件是同一个时不要重复读
  const legacyRaw = legacyFile && path.resolve(legacyFile) !== path.resolve(CONFIG_FILE) ? readJsonFile(legacyFile) : null
  const legacy = isObj(legacyRaw) && isObj(legacyRaw.video) ? legacyRaw.video : {}
  return merge(legacy, videoSection(readJsonFile(CONFIG_FILE)))
}

let cache = null

/** 合并后的 video 配置（带缓存；宿主写配置后调用 resetVideoConfig()）。 */
export function videoConfig() {
  if (cache) return cache
  cache = merge(VIDEO_DEFAULTS, readUserConfig())
  return cache
}

/** 重置缓存（宿主保存配置后 / 测试切换 env 后调用）。 */
export function resetVideoConfig() {
  cache = null
}

/**
 * 成片根目录：配置 video.outDir → <DSH_HOME>/bili-faship/videos。
 * 用 path.resolve 把相对路径变成绝对路径（相对的是**当前进程 cwd**，CLI 里可预期）。
 */
export function videoRoot(config) {
  const cfg = config || videoConfig()
  const d = str(cfg.outDir)
  return d ? path.resolve(d) : videosDir()
}

/** 单条视频的工作目录：<root>/<slug>（slug 里的空格/路径符号替换掉，防穿越）。 */
export function videoDir(slug, config) {
  return path.join(videoRoot(config), String(slug).replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 80))
}

/**
 * 表情帧缓存目录：env WHALE_VIDEO_CACHE（最优先，运维临时改路径用）
 * → 配置 video.paths.cache → <DSH_HOME>/bili-faship/cache。
 */
export function cacheRoot(config) {
  const cfg = config || videoConfig()
  const env = str(process.env.WHALE_VIDEO_CACHE)
  if (env) return path.resolve(env)
  const p = str(cfg.paths?.cache)
  return p ? path.resolve(p) : cacheDir()
}

/**
 * 表情包目录：配置 video.paths.stickers → env WHALE_STICKER_DIR
 * → 本机已有的 <DSH_HOME>/bili-whale/stickers/packs/大肥鱼（存在时复用，不重复下载）
 * → <DSH_HOME>/bili-faship/stickers（插件自己的兜底目录）。
 */
export function stickerDir(config) {
  const cfg = config || videoConfig()
  const fromCfg = str(cfg.paths?.stickers)
  if (fromCfg) return path.resolve(fromCfg)
  const env = str(process.env.WHALE_STICKER_DIR)
  if (env) return path.resolve(env)
  const whale = dshPath('bili-whale', 'stickers', 'packs', '大肥鱼')
  try {
    if (fs.statSync(whale).isDirectory()) return whale
  } catch {
    /* 没有就落到插件自己的目录 */
  }
  return stickersDir()
}

/** Python 解释器：配置 video.paths.python → env WHALE_PYTHON → 'python'（DESIGN §3）。 */
export function pythonPath(config) {
  const cfg = config || videoConfig()
  return str(cfg.paths?.python) || str(process.env.WHALE_PYTHON) || 'python'
}

/** ffmpeg 路径的"用户显式指定"部分：配置 video.paths.ffmpeg → env FFMPEG → null（其余交给 ffmpeg.mjs 的解析链）。 */
export function ffmpegPathHint(config) {
  const cfg = config || videoConfig()
  return str(cfg.paths?.ffmpeg) || str(process.env.FFMPEG) || null
}

// 兼容旧导入名：publish.mjs 用 mergeVideoConfig 合并默认值
export { merge as mergeVideoConfig }
