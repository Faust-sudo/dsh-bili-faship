/**
 * 统一的路径解析（DSH home / 插件家目录 / 凭据），插件宿主与 CLI 共用的**唯一真相**。
 *
 * 为什么需要它（DESIGN §3）：
 *   · 宿主半边（Electron 里的 index.js/lib）和工具链（tools/ 下的 CLI）必须对
 *     "配置在哪、成片在哪、日志在哪"有一致的答案，否则同一份设置会被写成两份；
 *   · DSH_HOME 可能被自定义（多 profile、便携安装、CI、测试的临时 home），
 *     所以**任何模块都不许自己拼 '.dsh'**，一律从这里取。
 *
 * 解析顺序（与宿主 `lib/index.js` 保持完全一致）：
 *   HOME     = USERPROFILE → HOME → os.homedir()
 *   DSH_HOME = DSH_HOME → <HOME>/.dsh
 *
 * 插件家目录 = <DSH_HOME>/bili-faship：
 *   配置、任务日志（jobs/）、调度状态（schedule.json）、最后一次汇报（last-report.md）、
 *   默认成片根（videos/）、表情帧缓存（cache/）都在这下面。
 */
import os from 'node:os'
import path from 'node:path'

/** 用户主目录（Windows 优先 USERPROFILE，保持与宿主/原实现一致）。 */
export const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'

/** DSH home：与宿主半边完全一致的解析顺序。 */
export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')

/** 拼一个位于 DSH home 下的路径。 */
export const dshPath = (...parts) => path.join(DSH_HOME, ...parts)

/** 拼一个位于用户主目录下的路径（.bili-ai 等凭据/状态目录用）。 */
export const homePath = (...parts) => path.join(HOME, ...parts)

/** 插件家目录：<DSH_HOME>/bili-faship（不存在时由需要落盘的模块自己 mkdir）。 */
export const FASHIP_HOME = dshPath('bili-faship')

/** 拼一个位于插件家目录下的路径。 */
export const fashipHome = (...parts) => path.join(FASHIP_HOME, ...parts)

/**
 * 插件配置文件：BILI_FASHIP_CONFIG 优先，否则 <DSH_HOME>/bili-faship.config.json。
 * 旧 dsh-bili-whale 的配置文件只用于兜底（由 video-config.mjs 只取其中的 video 段）。
 */
export const configPath = process.env.BILI_FASHIP_CONFIG || dshPath('bili-faship.config.json')

/** 旧插件（dsh-bili-whale）的配置文件位置；只在没有新配置字段时提供 video 段兜底。 */
export const legacyConfigPath = process.env.BILI_WHALE_CONFIG || dshPath('bili-whale.config.json')

/** 成片根目录的**默认值**；真正生效的路径是 video-config.mjs 的 videoRoot()（会先看 video.outDir）。 */
export const videosDir = () => fashipHome('videos')

/** 表情帧缓存默认目录；env WHALE_VIDEO_CACHE / 配置 video.paths.cache 优先（见 video-config.mjs）。 */
export const cacheDir = () => fashipHome('cache')

/** 表情包兜底目录（本机没有 bili-whale 表情包时才用它）。 */
export const stickersDir = () => fashipHome('stickers')

/** 长任务日志：<DSH_HOME>/bili-faship/jobs/<jobId>.log + jobs.json（由宿主 lib/jobs.mjs 落盘）。 */
export const jobsDir = () => fashipHome('jobs')
export const jobsFile = () => fashipHome('jobs.json')

/** 生物钟状态（由宿主 lib/scheduler.mjs 落盘）。 */
export const schedulePath = () => fashipHome('schedule.json')

/** 最后一次叫醒的汇报。 */
export const reportPath = () => fashipHome('last-report.md')

/** 叫醒会话的 cwd：<DSH_HOME>/faship-work（**不许**用主目录，避免 agent 在主目录里乱写）。 */
export const workCwd = () => dshPath('faship-work')

/** 凭据按操作系统用户存放，与 DSH_HOME 无关（DESIGN §3：cookie 固定 ~/.bili-ai/credentials.json）。 */
export const credentialsPath = homePath('.bili-ai', 'credentials.json')
