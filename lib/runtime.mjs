/**
 * lib/runtime.mjs —— 找「真能跑 JS 的 node」，并给它一套能跑的环境。
 *
 * 为什么不能直接用 process.execPath（抄 dsh-bili-whale 2026-10-19 的教训）：
 *   桌面版 DSH 是 Electron，`process.execPath` = DeepSeek Harness.exe ✗
 *   用 Electron 二进制跑 .mjs 会静默 exit 0（看着像成功，其实一行 JS 都没跑）✗
 *   所以这里带一个「探针」：真跑一段写文件的小脚本，能跑通才认它 ✓
 *
 * 查找顺序：DSH_NODE → DSH_DESKTOP_NODE_EXECUTABLE → $DSH_HOME/dsh-runtimes/*
 *          → PATH 里的 node → 平台常见位置 →（Electron 兜底）自己 + ELECTRON_RUN_AS_NODE=1
 *
 * 这段逻辑与 dsh-bili-whale/tools/lib/runtime.mjs 等价；搬进本插件是为了**代码零依赖**。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// 用「写文件」验证运行时：Electron 进程可能 exit 0 却没跑 JS。
export function probeRuntime(file, env) {
  let dir
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faship-node-'))
    const proof = path.join(dir, 'proof')
    const r = spawnSync(file, ['-e', 'require("fs").writeFileSync(process.argv[1],process.versions.node)', proof],
      { env, stdio: 'ignore', windowsHide: true, timeout: 10000 })
    return !r.error && r.status === 0 && /^\d+\./.test(fs.readFileSync(proof, 'utf8'))
  } catch { return false }
  finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }) }
}

export function resolveRuntime(dshHome, options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? (env.USERPROFILE || env.HOME || os.homedir())
  const electron = options.electron ?? Boolean(process.versions.electron)
  const current = options.execPath ?? process.execPath
  const probe = options.probe ?? probeRuntime
  const bin = platform === 'win32' ? 'node.exe' : 'node'
  const cands = [env.DSH_NODE, env.DSH_DESKTOP_NODE_EXECUTABLE]
  for (const root of new Set([path.join(dshHome, 'dsh-runtimes'), path.join(home, '.dsh', 'dsh-runtimes')])) {
    try { for (const d of fs.readdirSync(root)) cands.push(path.join(root, d, 'dependencies', 'node', 'bin', bin)) } catch { /* 没装就算了 */ }
  }
  const sep = platform === 'win32' ? ';' : ':'
  for (const dir of String(env.PATH ?? '').split(sep)) {
    if (dir) cands.push(path.join(dir.replace(/^"|"$/g, ''), bin))
  }
  if (platform === 'darwin') {
    cands.push('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node',
      '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node')
  }
  if (platform === 'win32' && env.ProgramFiles) cands.push(path.join(env.ProgramFiles, 'nodejs', bin))
  if (options.allowCurrent && !electron) cands.push(current)
  for (const file of new Set(cands.filter(Boolean))) {
    try { if (fs.statSync(file).isFile() && probe(file, env)) return { file, env: { ...env } } } catch { /* 换下一个 */ }
  }
  if (electron) {
    const nodeEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }
    if (probe(current, nodeEnv)) return { file: current, env: nodeEnv }
  }
  throw Error('[bili-faship] 找不到可执行脚本的 node 运行时，请设置 DSH_NODE 为真实 node 的绝对路径')
}
