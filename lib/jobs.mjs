/**
 * lib/jobs.mjs —— 长任务队列（渲染 / 真投稿）。
 *
 * 为什么要有它：
 *   · render 一条 35–45 秒的 1080p 片要 3–4 分钟，塞进一次工具调用里等，很容易撞超时；
 *   · publish --go 要等冷却（两次写之间 125 秒），更不该阻塞 UI；
 *   · 设置页/工具都想知道"现在在跑什么、跑到哪了、上次为什么失败"。
 *
 * 做法（简单、可恢复）：
 *   · 子进程跑 CLI（tools/bili-faship.mjs <action> --json），stdout/stderr 直接重定向到日志文件
 *   · 状态写 $DSH_HOME/bili-faship/jobs.json（只留最近 50 条）
 *   · 同一时刻只允许一个「重任务」（render / publish-go）；plan/review/publish-dry 走同步调用
 *   · 宿主重启后，上次遗留的 running 记录一律标 interrupted —— 不假装还在跑
 *   · 绝不给路径拼参数：动作白名单 + 目录必须在 videoRoot() 之内
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { videoConfig, videoRoot, videoDir } from './config.mjs'
import { jobsDir, jobsStateFile } from './dirs.mjs'
import { resolveNodeRuntime, nodeEnv } from './node-runtime.mjs'
import { DSH_HOME } from '../tools/lib/paths.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'tools', 'bili-faship.mjs')
const MAX_JOBS = 50
const MAX_LOG_TAIL = 4000

/** 动作白名单：只允许这五种，参数由代码拼，不接受调用方传任意 argv */
export const ACTIONS = ['plan', 'render', 'review', 'publish-dry', 'publish-go']
const ASYNC_ACTIONS = new Set(['render', 'publish-go'])

let state = { version: 1, jobs: [] }
let active = null // { id, child, startedAt }
let stopped = false

function log(...args) {
  try { console.log('[bili-faship jobs]', ...args) } catch { /* 忽略 */ }
}

function isWithin(root, target) {
  const r = path.resolve(root)
  const t = path.resolve(target)
  return t === r || t.startsWith(r + path.sep)
}

function newId(action) {
  const t = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${action}-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(jobsStateFile(), 'utf8'))
    if (raw && Array.isArray(raw.jobs)) state = { version: 1, jobs: raw.jobs }
  } catch { /* 没有 / 坏了 → 从空开始，但坏文件要保留证据 */ }
  // 上次进程死了还标着 running 的 → interrupted
  let changed = false
  for (const j of state.jobs) {
    if (j.status === 'running') {
      j.status = 'interrupted'
      j.finishedAt = j.finishedAt || new Date().toISOString()
      j.note = '宿主重启/退出，任务状态未知（输出可能还在日志里，也可能已经中断）'
      changed = true
    }
  }
  if (changed) writeState()
}

function writeState() {
  try {
    fs.mkdirSync(path.dirname(jobsStateFile()), { recursive: true })
    const trimmed = { version: 1, jobs: state.jobs.slice(-MAX_JOBS) }
    const tmp = `${jobsStateFile()}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(trimmed, null, 2)}\n`)
    fs.renameSync(tmp, jobsStateFile())
    state = trimmed
  } catch (e) { log('写 jobs.json 失败：' + e.message) }
}

function readTail(file, n = MAX_LOG_TAIL) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return text.length > n ? text.slice(-n) : text
  } catch { return '' }
}

/** 启动时调用一次：读状态 + 清理遗留 running（幂等：重复调用不会把正在跑的任务判死） */
let initialized = false
export function initJobs() {
  if (initialized) return { jobs: state.jobs.length }
  initialized = true
  loadState()
  return { jobs: state.jobs.length }
}

/** 当前是否有重任务在跑 */
export function activeJob() {
  if (active) return state.jobs.find((j) => j.id === active.id) || null
  return state.jobs.find((j) => j.status === 'running') || null
}

export function listJobs() {
  return state.jobs.slice().reverse().map((j) => ({ ...j }))
}

export function getJob(id) {
  const j = state.jobs.find((x) => x.id === id)
  if (!j) return null
  return { ...j, log: j.logFile ? readTail(j.logFile) : '' }
}

/** 把调用方给的 dir 收敛成 videoRoot 下的绝对路径 */
export function resolveDir(dir) {
  const root = videoRoot()
  if (!dir) throw new Error('需要视频目录（先 plan 一条）')
  const abs = path.isAbsolute(String(dir)) ? path.resolve(String(dir)) : path.resolve(root, String(dir))
  if (!isWithin(root, abs)) throw new Error(`目录必须在视频根目录内：${root}`)
  return abs
}

/** 动作 → CLI 参数（唯一允许的参数拼接点） */
function commandFor(action, { dir, topic, width, height, fps } = {}) {
  switch (action) {
    case 'plan': {
      const args = ['plan', '--json']
      if (dir) args.push('--dir', dir)
      if (topic) args.push('--topic', String(topic).slice(0, 200))
      for (const k of ['width', 'height', 'fps']) {
        const v = { width, height, fps }[k]
        if (v !== undefined && Number.isFinite(Number(v))) args.push(`--${k}`, String(Number(v)))
      }
      return args
    }
    case 'render': return ['render', '--dir', dir, '--json']
    case 'review': return ['review', '--dir', dir, '--json']
    case 'publish-dry': return ['publish', '--dir', dir, '--dry', '--json']
    case 'publish-go': return ['publish', '--dir', dir, '--go', '--json']
    default: throw new Error(`未知动作：${action}`)
  }
}

function childEnv() {
  try { return { ...nodeEnv(DSH_HOME), DSH_HOME } } catch { return { ...process.env, DSH_HOME } }
}

/**
 * 同步跑一个短命令（plan / review / publish-dry）。
 * @returns {Promise<{ok:boolean, code:number|null, json:any, stdout:string, stderr:string}>}
 */
export function runSync(action, opts = {}) {
  const args = commandFor(action, opts)
  const timeout = opts.timeoutMs ?? (action === 'review' ? 120_000 : 90_000)
  return new Promise((resolve) => {
    let nodeFile
    try { nodeFile = resolveNodeRuntime(DSH_HOME) } catch (e) {
      resolve({ ok: false, code: null, json: null, stdout: '', stderr: String(e?.message ?? e) })
      return
    }
    execFile(nodeFile, [CLI, ...args], {
      cwd: path.resolve(ROOT),
      env: childEnv(),
      timeout,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      const out = String(stdout || '')
      let json = null
      try { json = JSON.parse(out.trim()) } catch {
        // 有些命令会混一行提示；从最后一个 '{' 开始试
        const i = out.lastIndexOf('\n{')
        if (i >= 0) { try { json = JSON.parse(out.slice(i + 1).trim()) } catch { /* 就当没有 */ } }
      }
      const code = err && typeof err.code === 'number' ? err.code : (err ? null : 0)
      resolve({ ok: !err, code, json, stdout: out, stderr: String(stderr || err?.message || '') })
    })
  })
}

/**
 * 起一个后台任务（render / publish-go）。
 * @returns {{ok:boolean, job?:object, error?:string}}
 */
export function startJob(action, opts = {}) {
  if (!ASYNC_ACTIONS.has(action)) return { ok: false, error: `动作 ${action} 不是后台任务（用 runSync）` }
  if (stopped) return { ok: false, error: '插件正在卸载' }
  const dir = opts.dir ? resolveDir(opts.dir) : ''
  if (action !== 'plan' && !dir) return { ok: false, error: '需要视频目录' }
  const running = activeJob()
  if (running) return { ok: false, error: `已有任务在跑：${running.action}（${running.id}）`, job: running }

  let nodeFile
  try { nodeFile = resolveNodeRuntime(DSH_HOME) } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
  const id = newId(action)
  const logFile = path.join(jobsDir(), `${id}.log`)
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const args = commandFor(action, { ...opts, dir })

  const job = {
    id, action, dir, status: 'running',
    startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
    logFile, pid: null, note: null,
  }
  let fd
  try {
    fd = fs.openSync(logFile, 'a')
    const child = spawn(nodeFile, [CLI, ...args], {
      cwd: path.resolve(ROOT),
      env: childEnv(),
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    })
    job.pid = child.pid ?? null
    state.jobs.push(job)
    active = { id, child, startedAt: Date.now() }
    writeState()
    log(`启动 ${action} ${id}（pid=${job.pid}）`)
    child.on('exit', (code, signal) => {
      try { fs.closeSync(fd) } catch { /* 忽略 */ }
      const j = state.jobs.find((x) => x.id === id)
      if (!j) { active = null; return }
      if (j.status === 'running') {
        j.status = code === 0 ? 'done' : 'failed'
        j.exitCode = code
        j.finishedAt = new Date().toISOString()
        if (signal) j.note = `被信号 ${signal} 结束`
        writeState()
        log(`${action} ${id} 结束：${j.status}（exit=${code}）`)
      }
      if (active?.id === id) active = null
    })
    child.on('error', (e) => {
      const j = state.jobs.find((x) => x.id === id)
      if (j) { j.status = 'failed'; j.note = String(e?.message ?? e); j.finishedAt = new Date().toISOString(); writeState() }
      if (active?.id === id) active = null
    })
    return { ok: true, job: { ...job } }
  } catch (e) {
    try { if (fd !== undefined) fs.closeSync(fd) } catch { /* 忽略 */ }
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 插件卸载：不杀正在渲染的进程（杀在半路只会留半成品），只关闭状态机 */
export function disposeJobs() {
  stopped = true
  active = null
}

export { MAX_LOG_TAIL, videoDir }
