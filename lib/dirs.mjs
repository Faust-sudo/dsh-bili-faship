/**
 * lib/dirs.mjs —— 宿主半端的数据目录。
 *
 * 唯一真相在 tools/lib/paths.mjs（宿主与 CLI 共用）。这里只做一层**稳定的命名**，
 * 免得宿主各处出现 'jobs.json'、'schedule.json' 这种字面量拼错。全部落在 <DSH_HOME>/bili-faship 下。
 *
 * 视频根目录不在这里算 —— 它由配置 video.outDir 决定，见 lib/config.mjs 的 videoRoot()。
 */
import path from 'node:path'
import {
  DSH_HOME,
  dshPath,
  fashipHome,
  jobsDir as pathsJobsDir,
  jobsFile,
  schedulePath,
  reportPath,
  workCwd,
} from '../tools/lib/paths.mjs'

/** <DSH_HOME>/bili-faship */
export const FASHIP_HOME = fashipHome()

/** 拼插件家目录下的路径 */
export const fashipHomePath = (...p) => path.join(FASHIP_HOME, ...p)

/** 任务日志目录 / 状态文件 */
export const jobsDir = pathsJobsDir
export const jobsStateFile = jobsFile

/** 生物钟状态 */
export const scheduleFile = schedulePath

/** 工单账本 + 准入记录（v0.2，DESIGN §10.2） */
export const ticketsFile = () => fashipHome('tickets.json')

/** 最后一次汇报（agent 自己写） */
export const reportFile = reportPath

/** 插件运行日志（可选，出问题好排查） */
export const pluginLogFile = () => fashipHome('plugin.log')

/** 叫醒会话的 cwd（**专用小目录**，绝不能用主目录 —— 见 dsh-bili-whale Issue #6） */
export const workDir = workCwd

export { DSH_HOME, dshPath, fashipHome }
