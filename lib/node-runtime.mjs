/**
 * lib/node-runtime.mjs —— 宿主半边统一从这里拿「真 node」。
 *
 * 宿主进程是 Electron，不能用 process.execPath 跑 CLI（会静默什么都不做 ✗）。
 * 解析一次、缓存住；失败把原因留给调用方显示（而不是让插件整条激活失败）。
 */
import { resolveRuntime } from './runtime.mjs'

const cache = new Map()

export function nodeRuntime(dshHome) {
  if (!cache.has(dshHome)) cache.set(dshHome, resolveRuntime(dshHome))
  return cache.get(dshHome)
}

/** 可执行文件绝对路径 */
export const resolveNodeRuntime = (dshHome) => nodeRuntime(dshHome).file

/** 运行环境（Electron 兜底时会带 ELECTRON_RUN_AS_NODE=1） */
export const nodeEnv = (dshHome) => nodeRuntime(dshHome).env

/** 不抛错的版本：拿不到就 {ok:false, error}，设置页能显示真因。 */
export function tryNodeRuntime(dshHome) {
  try {
    const rt = nodeRuntime(dshHome)
    return { ok: true, file: rt.file, env: rt.env }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}
