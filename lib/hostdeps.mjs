/**
 * lib/hostdeps.mjs —— 从**宿主那棵树**里拿工具注册器（`defineTool`）。
 *
 * 为什么不能裸 import @deepseek-ai/dsh-tools（dsh-bili-scroll 2026-10-16 踩过的坑，这里照抄结论）：
 *   · 桌面版 profile 是 autoInstallPeers=false ⇒ profile 的 node_modules 里不一定有它；
 *   · 裸 import 一旦失败，**整条插件不激活**（宿主只留一句 "entry did not activate"）✗
 *   · dsh-tools 自己还有一堆 peer，光装它一个也救不回来。
 *
 * 策略（三条一起走）：
 *   ① 从宿主树里找（resources/app.asar、npm 全局、profile node_modules 都试）
 *   ② 找不到就裸 import 试试（有些启动方式会配 import 映射）
 *   ③ 还拿不到 → 用**本地等价实现**顶上：把简写 schema 编译成标准 JSON Schema，
 *      按 dsh-tools 的 register 约定（name/description/parameters/output.schema/render/execute）
 *      造出同一个形状。注册表只校验 output.schema，所以这样能正常工作 ✓
 *   **宁可少一层参数校验，也绝不能让插件整条不激活** ✓
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SELF_MODULES = path.join(HERE, '..', 'node_modules', '@deepseek-ai')
const log = []

/** 可能藏着宿主 @deepseek-ai 包的地方（按可能性从高到低） */
export function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)

  // ① Electron 主进程：resources/app.asar/dsh/node_modules/@deepseek-ai
  const resources = process.resourcesPath
  if (resources) {
    push(path.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai'))
    push(path.join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai'))
    push(path.join(resources, 'app', 'dsh', 'node_modules', '@deepseek-ai'))
  }

  // ② npm 全局安装的位置
  const appdata = process.env.APPDATA
  if (appdata) push(path.join(appdata, 'npm', 'node_modules', '@deepseek-ai'))

  // ③ 每个 profile 的 node_modules（别的插件可能把宿主包 hoist 到这一层）
  try {
    const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh')
    for (const p of fs.readdirSync(path.join(dshHome, 'profiles'))) {
      push(path.join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* 没有就算了 */ }

  // ④ 自己那棵树（package.json 里 optional peer 真装了的话）
  push(SELF_MODULES)
  return out
}

/** 按 package.json 的 exports['.'] 找入口文件，返回 file:// URL */
function entryUrlFor(root, name) {
  try {
    const dir = path.join(root, name)
    const pkgFile = path.join(dir, 'package.json')
    if (!fs.existsSync(pkgFile)) return null
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string' ? dot : (dot?.import || dot?.default || dot?.require || pkg.module || pkg.main)
    if (!rel) return null
    const file = path.join(dir, String(rel).replace(/^\.\//, ''))
    return fs.existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

/* ───────────── 本地兜底：schema 简写 → 标准 JSON Schema ─────────────
 * 与 dsh-tools 的 parameterSchemaSpecToJsonSchema 对齐（不含 additionalProperties，
 * 因为宿主的 assertSupportedJsonSchema 本来就接受这个形状）。
 * 我们只用最基础的 string/number/integer/boolean/array/object，够用且不会出错。
 */
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])

export function compileSchema(spec, where = 'schema') {
  if (!spec || typeof spec !== 'object') throw new Error(`${where} 不是对象`)
  const out = {}
  if (spec.type) {
    if (!SCALAR_TYPES.has(spec.type) && !['array', 'object'].includes(spec.type)) {
      throw new Error(`${where}.type 不支持：${spec.type}（只支持 string/number/integer/boolean/null/array/object）`)
    }
    out.type = spec.type
  }
  if (typeof spec.description === 'string') out.description = spec.description
  if (spec.enum !== undefined) {
    if (!Array.isArray(spec.enum)) throw new Error(`${where}.enum 必须是数组`)
    out.enum = spec.enum
  }
  for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern']) {
    if (spec[k] !== undefined) out[k] = spec[k]
  }
  if (spec.items !== undefined) {
    if (spec.type !== 'array') throw new Error(`${where}.items 只能用于 array`)
    out.items = compileSchema(spec.items, `${where}.items`)
  }
  if (spec.properties !== undefined) {
    if (spec.type !== 'object') throw new Error(`${where}.properties 只能用于 object`)
    out.properties = {}
    const required = []
    for (const [k, v] of Object.entries(spec.properties)) {
      out.properties[k] = compileSchema(v, `${where}.properties.${k}`)
      if (v && v.required === true) required.push(k)
    }
    if (required.length) out.required = required
  }
  if (spec.additionalProperties !== undefined) out.additionalProperties = Boolean(spec.additionalProperties)
  return out
}

/** 把 dsh-tools 的「隐式参数对象」简写编译成标准 JSON Schema */
export function compileParameters(spec) {
  const schema = { type: 'object', properties: {} }
  const required = []
  for (const [k, v] of Object.entries(spec || {})) {
    if (!v || typeof v !== 'object') throw new Error(`parameters.${k} 不是对象`)
    const child = compileSchema(v, `parameters.${k}`)
    schema.properties[k] = child
    if (v.required === true) required.push(k)
  }
  if (required.length) schema.required = required
  return schema
}

/** 本地等价 defineTool（拿不到宿主 dsh-tools 时用） */
export function localDefineTool(options) {
  const userRender = options.output?.render
  if (typeof userRender !== 'function') throw new Error(`defineTool(${options.name}): 缺少 output.render`)
  const parameters = compileParameters(options.parameters)
  const outputSchema = compileSchema(options.output.schema, 'output.schema')
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: { schema: outputSchema, render: userRender },
    ...(options.deferLoading === true ? { deferLoading: options.deferLoading } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args, exec) { return options.execute(args, exec) },
  }
}

/** 试从宿主树里 import 一个包；拿不到返回 null */
async function fromHostTree(name) {
  for (const root of candidateRoots()) {
    const url = entryUrlFor(root, name)
    if (!url) continue
    try {
      const mod = await import(url)
      log.push(`${name}：从宿主树取到（${url.replace(/^file:\/\//, '')}）`)
      return mod
    } catch (e) {
      log.push(`${name}：宿主树 ${root} 导入失败（${e?.code || ''} ${String(e?.message || '').slice(0, 120)}）`)
    }
  }
  return null
}

/**
 * 取回宿主半端要用的工具注册器。
 * @returns {Promise<{defineTool:Function, source:'host'|'bare'|'local', notes:string[]}>}
 */
export async function loadHostDeps() {
  let mod = await fromHostTree('dsh-tools')
  if (!mod) {
    try {
      mod = await import('@deepseek-ai/dsh-tools')
      log.push('dsh-tools：宿主树里没有，裸 import 成功')
    } catch (e) {
      log.push(`dsh-tools：裸 import 也失败（${e?.code || ''} ${String(e?.message || '').slice(0, 120)}）—— 用本地等价实现顶上`)
      mod = null
    }
  }
  if (mod?.defineTool) return { defineTool: mod.defineTool, source: 'host', notes: log }
  return { defineTool: localDefineTool, source: 'local', notes: log }
}
