/**
 * tests/package.test.mjs —— 包清单 / 挂载声明 / 契约字符串的静态自检
 * ============================================================================
 * 这些测试**不启动 DSH、不联网**，只读仓库里的文件，防的是这几类「一装就废」的问题：
 *
 *   1. package.json 的 name / exports / files 与实际文件对不上（打包漏文件 / 入口写错）；
 *   2. cordis.patch.yml 的 insert id/name 与包名不一致（表现为「装上了但设置页 404」）；
 *   3. DESIGN §5 的 HTTP 路由在 index.js/lib 里根本没实现（设置页点了没反应）；
 *   4. client.js 的自注册 id 不等于包名（设置页整块不出现）；
 *   5. 忘了把 selfcheck / 文档列进 files（发布出去的用户拿不到）。
 *
 * 跑法：node --test tests/package.test.mjs
 * ============================================================================
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PKG_PATH = path.join(ROOT, 'package.json')
const PKG = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'))

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))

/** 模板里写的是 `<plugin>/api/*`；DESIGN §5 的路由清单在这里集中一份。 */
const API_BASE = '/dsh-bili-faship/api'
const API_ROUTES = ['/settings', '/status', '/videos', '/deps', '/cookie', '/jobs', '/wake', '/report', '/media']

/** 读宿主侧全部源码（index.js + lib/ 下的 .mjs），拼成一段文本给路由断言用。 */
function hostSource() {
  const parts = []
  if (exists('index.js')) parts.push(read('index.js'))
  const walk = (dir) => {
    let entries = []
    try { entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const rel = path.posix.join(dir, e.name)
      if (e.isDirectory()) walk(rel)
      else if (/\.(mjs|js|cjs)$/.test(e.name)) parts.push(read(rel))
    }
  }
  walk('lib')
  return parts.join('\n')
}

// ── 1. package.json 基本形状 ────────────────────────────────────────────────
test('package.json：name / version / type / main 合法', () => {
  assert.equal(PKG.name, 'dsh-bili-faship', '包名必须叫 dsh-bili-faship（安装后 bundle 依赖它）')
  assert.match(String(PKG.version), /^\d+\.\d+\.\d+/, 'version 必须是 x.y.z')
  assert.equal(PKG.type, 'module', '宿主入口是 ESM，type 必须是 module')
  assert.equal(PKG.main, 'index.js', 'main 必须指向 index.js')
  assert.equal(PKG.license, 'MIT')
})

test('package.json：engines 声明 dsh 与 node', () => {
  assert.ok(PKG.engines && typeof PKG.engines === 'object', '必须有 engines')
  assert.ok(PKG.engines.dsh, '必须声明 engines.dsh（版本不满足时 DSH 会静默跳过插件）')
  assert.ok(PKG.engines.node, '必须声明 engines.node')
})

test('package.json：exports 指向真实文件', () => {
  assert.ok(PKG.exports && typeof PKG.exports === 'object', '必须有 exports')
  for (const [key, target] of Object.entries(PKG.exports)) {
    const rel = String(target).replace(/^\.\//, '')
    assert.ok(exists(rel), `exports["${key}"] 指向的 ${rel} 不存在`)
  }
  assert.equal(PKG.exports['.'], './index.js', 'exports["."] 必须是宿主入口 index.js')
  assert.equal(PKG.exports['./client'], './client.js', 'exports["./client"] 必须是设置页半端')
})

test('package.json：files 里列的每一样都真实存在（打不出去的包等于没写）', () => {
  const files = PKG.files || []
  assert.ok(files.length > 0, 'files 不能为空')
  for (const rel of files) {
    assert.ok(exists(rel), `files 里的 ${rel} 不存在（打包会漏掉 / npm pack 报错）`)
  }
  // 关键交付物一个都不能少
  for (const need of ['index.js', 'client.js', 'lib', 'tools', 'docs', 'prompts', 'cordis.patch.yml', 'README.md', 'selfcheck.mjs', 'tests']) {
    assert.ok(files.includes(need), `files 里缺少关键交付物：${need}`)
  }
})

test('package.json：dsh.bundle.patch 与 dsh.client 声明完整', () => {
  assert.equal(PKG.dsh?.bundle?.patch, './cordis.patch.yml', 'dsh.bundle.patch 必须指向 cordis.patch.yml')
  assert.equal(PKG.dsh?.client?.platform, 'web', '设置页半端跑在 web 平台')
  assert.ok(Array.isArray(PKG.dsh?.client?.inject) && PKG.dsh.client.inject.length > 0, 'dsh.client.inject 不能为空')
  assert.ok(PKG.scripts && PKG.scripts.selfcheck, 'scripts.selfcheck 必须存在')
  assert.ok(PKG.scripts.test, 'scripts.test 必须存在')
})

// ── 2. cordis.patch.yml：挂载声明能被简单解析 ──────────────────────────────
test('cordis.patch.yml：有 insert 段，id/name 与包名一致', () => {
  const yml = read('cordis.patch.yml')
  assert.match(yml, /(^|\n)\s*-\s*insert:/, 'patch 必须包含 `- insert:` 段')

  const insertBlock = yml.slice(yml.indexOf('- insert:'))
  const id = (/^\s*(?:-\s*)?id:\s*(\S+)\s*$/m.exec(insertBlock) || [])[1]
  const name = (/^\s*(?:-\s*)?name:\s*(\S+)\s*$/m.exec(insertBlock) || [])[1]
  assert.ok(id, 'insert 段里必须能解析出 id')
  assert.ok(name, 'insert 段里必须能解析出 name')
  assert.equal(name, PKG.name, `cordis.patch.yml 的 name（${name}）必须等于包名（${PKG.name}），否则设置页 404`)
  assert.match(id, /^[a-z0-9][a-z0-9-]*$/, `insert id 不合法：${id}`)
})

// ── 3. 设置页半端：自注册 id 与导出 ────────────────────────────────────────
test('client.js：window.__ModuleLoader__.load 的 id 必须等于包名', () => {
  const src = read('client.js')
  const m = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{[^}]*?\bid\s*:\s*['"]([^'"]+)['"]/s.exec(src)
  assert.ok(m, 'client.js 里找不到 window.__ModuleLoader__.load({ id: ... }) 自注册')
  assert.equal(m[1], PKG.name, `client.js 的 id（${m[1]}）必须等于 package.json 的 name（${PKG.name}）`)
  assert.match(src, /factory\s*:/, 'load({...}) 里必须有 factory')
  assert.match(src, /require\(\s*['"]react['"]\s*\)/, "client.js 必须 require('react')")
})

test('client.js：导出 apply / inject，且 inject 含 slots', () => {
  const src = read('client.js')
  assert.match(src, /exports\.apply\s*=/, '必须导出 apply(ctx)')
  assert.match(src, /exports\.inject\s*=/, '必须导出 inject')
  assert.match(src, /['"]slots['"]/, "inject 里必须包含 'slots'")
  assert.match(src, /settings\.section/, '必须注册到 settings.section slot')
  assert.match(src, /视频工坊/, '设置页 label 必须是「视频工坊」')
})

// ── 4. DESIGN §5 的 HTTP 路由：至少在 index.js/lib 里出现 ─────────────────
test('宿主路由：API base 与 §5 的每个路由都在 index.js/lib 中出现', () => {
  const src = hostSource()
  assert.ok(src.length > 0, 'index.js / lib/** 里没有读到源码（宿主半端还没写？）')
  assert.ok(src.includes(API_BASE), `宿主源码里找不到 API base：${API_BASE}`)

  const missing = []
  for (const route of API_ROUTES) {
    // 路由可能写成 '/settings'，也可能写成 `${BASE}/settings`；只要出现带引号的路径就算
    const quoted = new RegExp(`['"\`][^'"\`]*\\${route}['"\`]`)
    if (!quoted.test(src)) missing.push(route)
  }
  assert.deepEqual(missing, [], `这些 DESIGN §5 路由在宿主源码里没找到：${missing.join(', ')}`)
})

test('宿主路由：/media 白名单与路径穿越防护有实现迹象', () => {
  const src = hostSource()
  for (const file of ['video.mp4', 'cover.jpg', 'subtitles.srt', 'review.json', 'storyboard.json', 'meta.json']) {
    assert.ok(src.includes(file), `/media 白名单里缺少 ${file}`)
  }
  // 防路径穿越：至少出现一次「解析后必须在 videoRoot 内」的判断关键字
  assert.match(src, /startsWith|relative|resolve/, '/media 应有「解析后必须落在 videoRoot 内」的校验')
})

test('宿主：publish-go 的三重闸门字样在源码中出现', () => {
  const src = hostSource()
  assert.match(src, /allowGo/, '必须出现 autoPublish.allowGo 判断')
  assert.match(src, /confirm/, '必须出现 confirm 显式确认判断')
  assert.match(src, /publish-go|publish_go|publishGo/, '必须出现 publish-go 动作')
})

// ── 5. 交付物齐不齐 ────────────────────────────────────────────────────────
test('文档与自检文件齐全', () => {
  for (const rel of [
    'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE.md', 'VIDEO-CAPABILITY.md',
    'docs/PLUGIN.md', 'docs/video-storyboard.md', 'docs/video-publish.md',
    'prompts/charter.md', 'prompts/wake.md', 'selfcheck.mjs',
  ]) {
    assert.ok(exists(rel), `缺少交付文件：${rel}`)
  }
})

test('README 讲到了安装 / 回滚 / 601 / 红线 / 数据位置', () => {
  const readme = read('README.md')
  for (const keyword of ['安装', '回滚', '601', '红线', '数据在哪', '视频工坊', 'faship_']) {
    assert.ok(readme.includes(keyword), `README 缺少必要章节/关键词：${keyword}`)
  }
})
