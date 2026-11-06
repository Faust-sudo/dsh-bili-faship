/**
 * dsh-bili-faship —— 浏览器半端：DSH「设置」里的 **视频工坊** section
 * ============================================================================
 * 契约（DESIGN.md §8，唯一真相，不许在这里偷偷改）：
 *
 *   · 自注册脚本（不是 ESM）：
 *       window.__ModuleLoader__.load({ id: 'dsh-bili-faship', factory: (require) => {...} })
 *   · `require('react')`；导出 `inject = ['slots']` 与 `apply(ctx)`；
 *       ctx.effect(() => ctx.slots.inject('settings.section', () =>
 *         ctx.slots.register({ name:'settings.section', id:'bili-faship', order:7,
 *                              label: () => '视频工坊' }, Section)))
 *   · API base `/dsh-bili-faship/api`（§5）：/settings /status /videos /deps /cookie
 *     /jobs /wake /media。**每个请求都检查 res.ok**，失败必须把错误显示出来，
 *     绝不静默把 500 的 {ok:false,error} 当成「已保存」。
 *   · 表单是**数据驱动**的：FIELDS 是唯一真相（group/path/label/hint/kind）。
 *     保存时提交**整份** `{ config }`（load 回来只改几个键）⇒ 未显示的字段原样保留。
 *   · 安全（§1 / §8）：
 *       - autoPublish.allowGo 是危险开关，**打开前必须 confirm**；没有 confirm 就保持关闭；
 *       - 设置页**不提供**「一键真发」按钮（真发始终要调用方再显式 confirm）；
 *       - 凭据（SESSDATA / bili_jct / buvid3）**只写不读**：写入成功就清空输入框，
 *         任何提示里都不带旧值，也永远不 fetch 回来回显；
 *       - /media 的封面、播放、review.json 都按 §5 的 `?dir=<slug>&file=<白名单文件>` 走。
 *   · 样式：只注入一个 <style>，所有类名 `bf-` 前缀，颜色只用 DSH 主题变量 `--dsw-alias-*`。
 *
 * 数据流：Section ⇄ 同源 fetch ⇄ 宿主半端（index.js/lib）⇄ <DSH_HOME>/bili-faship.config.json
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-faship',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const { createElement: h, useEffect, useRef, useState } = React

    const API = '/dsh-bili-faship/api'
    const NS = 'bili-faship'
    const ORDER = 7
    const LABEL = '视频工坊'

    // ── 样式：只注入一个 <style id=...>；类名 bf-；颜色只用 --dsw-alias-* ──────
    const CSS_TAG = 'dsh-bili-faship/settings.css'
    const CSS = [
      '.bf{display:flex;flex-direction:column;gap:2px;max-width:880px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:20px}',
      '.bf-title{margin:0 0 2px;font-size:16px;font-weight:600;line-height:24px}',
      '.bf-intro{margin:0 0 8px;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.bf-sec{display:flex;flex-direction:column;margin-top:10px}',
      '.bf-group{margin:14px 0 2px;font-size:13px;font-weight:600;line-height:20px}',
      '.bf-rows{display:flex;flex-direction:column}',
      '.bf-row{display:flex;justify-content:space-between;align-items:flex-start;gap:10px 20px;padding:9px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));flex-wrap:wrap}',
      '.bf-row:last-child{border-bottom:none}',
      '.bf-row>div:first-child{flex:1;min-width:200px}',
      '.bf-row[data-danger]{border:1px solid rgba(229,72,77,.45);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 45%,transparent);border-radius:10px;padding:10px 12px;margin:8px 0;background:rgba(229,72,77,.07);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 8%,transparent)}',
      '.bf-label{font-size:13px;line-height:19px}',
      '.bf-hint{margin-top:3px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.bf-input,.bf-select{background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.32));border-radius:6px;color:var(--dsw-alias-label-primary,inherit);font-size:12.5px;height:28px;padding:0 8px;min-width:180px;outline:none;font-family:inherit}',
      '.bf-input:focus-visible,.bf-select:focus-visible{border-color:var(--dsw-alias-brand-primary,#4c8dff)}',
      '.bf-input[disabled],.bf-select[disabled]{opacity:.6;cursor:default}',
      '.bf-input.bf-wide{min-width:320px}',
      '.bf-input.bf-num{min-width:110px;width:110px;text-align:right}',
      '.bf-input[type=range]{min-width:200px;height:20px;padding:0;accent-color:var(--dsw-alias-brand-primary,#4c8dff)}',
      '.bf-range-wrap{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.bf-range-val{font-variant-numeric:tabular-nums;min-width:52px;text-align:right;font-size:12px;color:var(--dsw-alias-label-secondary,#c9ccd1)}',
      '.bf-switch{accent-color:var(--dsw-alias-brand-primary,#4c8dff);width:16px;height:16px;cursor:pointer;flex:none;margin-top:2px}',
      '.bf-switch:disabled{cursor:default;opacity:.55}',
      '.bf-card{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:12px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));display:flex;flex-direction:column;gap:8px;margin:8px 0 2px}',
      '.bf-badges{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
      '.bf-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:16px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.16));color:var(--dsw-alias-label-secondary,#c9ccd1);text-decoration:none}',
      '.bf-badge[data-tone=good]{color:var(--dsw-alias-state-success-primary,#22c55e)}',
      '.bf-badge[data-tone=warn]{color:var(--dsw-alias-state-warning-primary,#d29922)}',
      '.bf-badge[data-tone=bad]{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.bf-badge[data-danger]{background:rgba(229,72,77,.16);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 18%,transparent);color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.bf-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:4px 20px}',
      '.bf-kv>div{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#c9ccd1);word-break:break-all}',
      '.bf-kv b{font-weight:600;color:var(--dsw-alias-label-primary,inherit)}',
      '.bf-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0 0;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}',
      '.bf-grow{flex:1;min-width:0}',
      '.bf-btn{background:var(--dsw-alias-brand-primary,#4c8dff);color:#fff;border:none;border-radius:6px;font-size:12.5px;height:30px;padding:0 14px;cursor:pointer;font-family:inherit;white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}',
      '.bf-btn:hover{filter:brightness(1.07)}',
      '.bf-btn[disabled]{opacity:.5;cursor:default;filter:none}',
      '.bf-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));color:var(--dsw-alias-label-primary,inherit)}',
      '.bf-btn2:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.bf-btn-warn{border-color:rgba(210,153,34,.55);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d29922) 55%,transparent);color:var(--dsw-alias-state-warning-primary,#d29922)}',
      '.bf-dirty{font-size:12px;color:var(--dsw-alias-state-warning-primary,#d29922)}',
      '.bf-err{font-size:12px;line-height:18px;white-space:pre-line;color:var(--dsw-alias-state-error-primary,#e5484d);background:rgba(229,72,77,.08);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 9%,transparent);border:1px solid rgba(229,72,77,.35);border-radius:8px;padding:8px 10px;margin:8px 0}',
      '.bf-warn{font-size:12px;line-height:18px;white-space:pre-line;color:var(--dsw-alias-state-warning-primary,#d29922);background:rgba(210,153,34,.09);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d29922) 10%,transparent);border-radius:8px;padding:8px 10px;margin:8px 0}',
      '.bf-out{white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#c9ccd1);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));border-radius:8px;padding:10px 12px;max-height:300px;overflow:auto;margin:8px 0}',
      '.bf-cred{display:flex;flex-direction:column;gap:8px;min-width:260px;flex:1;max-width:380px}',
      '.bf-videos{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;margin-top:8px}',
      '.bf-video{display:flex;flex-direction:column;border-radius:12px;overflow:hidden;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06))}',
      '.bf-video[data-selected]{border-color:var(--dsw-alias-brand-primary,#4c8dff);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary,#4c8dff)}',
      '.bf-cover{display:block;width:100%;aspect-ratio:16/9;height:auto;object-fit:cover;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}',
      '.bf-cover-none{display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.bf-video-body{display:flex;flex-direction:column;gap:6px;padding:9px 11px;min-width:0}',
      '.bf-video-title{font-size:13px;line-height:18px;font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.bf-video-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px}',
      '.bf-video-actions .bf-btn,.bf-video-actions .bf-btn2{height:26px;padding:0 10px;font-size:12px}',
      '.bf-review{margin-top:4px;border-top:.5px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.25));padding-top:6px;display:flex;flex-direction:column;gap:4px}',
      '.bf-checks{display:flex;flex-direction:column;gap:2px;max-height:220px;overflow:auto}',
      '.bf-check{font-size:11.5px;line-height:16px;color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.bf-check[data-ok]{color:var(--dsw-alias-label-secondary,#c9ccd1)}',
      '.bf-pre{margin:4px 0 0;padding:8px 9px;border-radius:8px;max-height:180px;overflow:auto;font-size:11px;line-height:15px;white-space:pre-wrap;word-break:break-all;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.18));color:var(--dsw-alias-label-secondary,#c9ccd1)}',
      '.bf-foot{display:flex;flex-direction:column;gap:2px;margin-top:14px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}',
      '.bf-lock{margin-left:6px}',
      '.bf-badge-danger{margin-left:6px}',
    ].join('')

    // ── HTTP：所有请求都检查 res.ok（DESIGN §5；失败必须显示，不许静默）────────
    const httpHint = (status) => (
      status === 401 ? '（未登录 / 没权限）'
        : status === 403 ? '（被宿主信任栅栏拦了）'
          : status === 404 ? '（路由不存在：插件可能没装好 / 没重启）'
            : status === 409 ? '（有同类任务在跑）'
              : status === 503 ? '（宿主还没准备好）'
                : ''
    )
    // 从失败 payload 里取人能看的原因：/settings 校验失败是 {ok:false, errors:[...]}（没有 error 字段）
    const payloadError = (payload) => {
      if (!payload) return ''
      if (payload.error) return String(payload.error)
      if (Array.isArray(payload.errors) && payload.errors.length) {
        return payload.errors.map((x) => '· ' + String(x)).join('\n')
      }
      return ''
    }
    const asJson = async (res) => {
      const payload = await res.json().catch(() => null)
      if (!res.ok) {
        const detail = payloadError(payload)
        if (detail) throw new Error(detail + '（HTTP ' + res.status + '）')
        throw new Error('HTTP ' + res.status + httpHint(res.status))
      }
      // 契约里失败是 { ok:false, error }；有些宿主会 200 带 ok:false，也要当失败。
      if (payload && payload.ok === false) throw new Error(payloadError(payload) || '请求失败（宿主返回 ok:false）')
      return payload
    }
    const jget = async (p) => asJson(await fetch(API + p, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body || {}),
    }))
    /**
     * 宽松读（只看 HTTP 是否 ok）—— 用于 /deps、/status：
     * 它们的 payload 里 ok:false 表示「有硬依赖不可用 / 索引坏了」，但数据本身还要展示
     * （DESIGN §5：/deps 的 ok 只由必需项决定）。错误会由组件当警告显示，不吞掉。
     */
    const jgetLoose = async (p) => {
      const res = await fetch(API + p, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        const detail = payloadError(payload)
        throw new Error(detail ? detail + '（HTTP ' + res.status + '）' : 'HTTP ' + res.status + httpHint(res.status))
      }
      return res.json().catch(() => null)
    }

    // ── 通用小工具 ──────────────────────────────────────────────────────────
    const msgOf = (e) => {
      if (e == null) return '未知错误'
      if (typeof e === 'string') return e
      return String(e.message || e.error || e)
    }
    // 危险操作二次确认：宿主环境拿不到 confirm 时**默认拒绝**（fail-closed，绝不静默打开）
    const askConfirm = (text) => {
      try {
        if (typeof window === 'undefined' || typeof window.confirm !== 'function') return false
        return window.confirm(String(text || '确定？')) === true
      } catch { return false }
    }
    const getPath = (obj, path) => (path || []).reduce((o, k) => (o == null ? undefined : o[k]), obj)
    const setPath = (obj, path, value) => {
      let cur = obj
      for (let i = 0; i < path.length - 1; i += 1) {
        const k = path[i]
        if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = typeof path[i + 1] === 'number' ? [] : {}
        cur = cur[k]
      }
      cur[path[path.length - 1]] = value
    }
    // list 字段：显示文本与数组分离（否则中文逗号/末尾逗号会被 join 吞掉，见 whale 的教训）
    const listToText = (v) => (Array.isArray(v) ? v.join('，') : (v == null ? '' : String(v)))
    const parseList = (text) => String(text == null ? '' : text)
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
    const saveBody = (config) => ({ config })   // §5：保存提交整份配置
    /** POST /settings：body 按 DESIGN §5 发 `{ config }`（宿主也接受裸 `{...}`；整份配置提交）。 */
    const postSave = async (config) => jpost('/settings', saveBody(config))
    const fieldKey = (f) => f.path.map(String).join('.')
    // /media 的 dir：DESIGN §5 写的是 <slug>，但宿主 resolveDir 对绝对路径/相对 slug 都支持；
    // 这里优先用 /videos 返回的绝对 dir（避免 story.slug 与目录名不一致时读不到文件），没有再用 slug。
    const mediaDir = (v) => String((v && (v.dir || v.slug)) || '')
    const mediaUrl = (v, file) => API + '/media?dir=' + encodeURIComponent(mediaDir(v))
      + '&file=' + encodeURIComponent(String(file || ''))
    const bvUrl = (bvid) => (/^BV[0-9A-Za-z]+$/.test(String(bvid || '')) ? 'https://www.bilibili.com/video/' + bvid : '')

    const pad2 = (n) => String(n).padStart(2, '0')
    const fmtTime = (iso) => {
      const t = Date.parse(String(iso || ''))
      if (!Number.isFinite(t)) return '—'
      const d = new Date(t)
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
        + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    }
    const fmtAgo = (iso) => {
      const t = Date.parse(String(iso || ''))
      if (!Number.isFinite(t)) return '从未'
      const ms = Date.now() - t
      if (ms < 0) return fmtTime(iso)
      const min = Math.floor(ms / 60000)
      if (min < 1) return '刚刚'
      if (min < 60) return min + ' 分钟前'
      const hr = Math.floor(min / 60)
      if (hr < 48) return hr + ' 小时前'
      return Math.floor(hr / 24) + ' 天前'
    }
    const SCHEDULE_REASONS = {
      due: '到点了',
      'not-due': '还没到期',
      'out-of-window': '不在叫醒窗口内',
      cooldown: '叫醒冷却中',
      disabled: '已关闭',
      'schedule-off': '生物钟关着',
      'already-woke-today': '今天已经叫醒过',
      'job-running': '有任务在跑',
    }
    const scheduleReason = (code) => SCHEDULE_REASONS[String(code || '')] || (code ? String(code) : '未知')
    // /status 的 indexState：missing | ok | error（DESIGN §5）
    const INDEX_STATE_TEXT = { ok: '正常', missing: '缺失', error: '损坏' }
    const indexStateText = (v) => INDEX_STATE_TEXT[String(v || '')] || String(v || '未知')
    const JOB_LABELS = { plan: '写分镜', render: '渲染', review: '自审', 'publish-dry': 'dry 投稿包' }
    const jobLabel = (action) => JOB_LABELS[String(action || '')] || (action ? String(action) : '任务')

    /**
     * 唯一真相：设置页字段清单（DESIGN §4 全部配置项；加字段只改这里）。
     * kind: text | number | switch | select | list | range
     * 额外字段：readOnly（红线，只读展示）| danger（危险开关，打开前 confirm）
     */
    const FIELDS = [
      // ── 节奏（§4 enabled / cadenceDays / min/maxDurationSec / schedule）──
      { group: '节奏', path: ['enabled'], label: '总开关', kind: 'switch',
        hint: '关 = 不叫醒、不渲染；「现在做一条」等手动按钮仍然可用' },
      { group: '节奏', path: ['cadenceDays'], label: '几天一条', kind: 'number', min: 1, max: 30, step: 1,
        hint: '1–30 天；到点才会自己叫醒（还要同时满足叫醒窗口）' },
      { group: '节奏', path: ['minDurationSec'], label: '成片最短（秒）', kind: 'number', min: 5, max: 600,
        hint: '成片时长下限，5–600 秒' },
      { group: '节奏', path: ['maxDurationSec'], label: '成片最长（秒）', kind: 'number', min: 5, max: 900,
        hint: '成片时长上限 ≤900 秒，且不能小于最短' },
      { group: '节奏', path: ['schedule', 'enabled'], label: '生物钟叫醒', kind: 'switch',
        hint: '关 = 只手动做；开 = 每天在窗口内到点叫醒一次 agent' },
      { group: '节奏', path: ['schedule', 'window', 'start'], label: '叫醒窗口开始', kind: 'text', placeholder: '21:00',
        hint: 'HH:MM（24 小时制）' },
      { group: '节奏', path: ['schedule', 'window', 'end'], label: '叫醒窗口结束', kind: 'text', placeholder: '23:30',
        hint: 'HH:MM；可以跨午夜（比如 01:30）' },
      { group: '节奏', path: ['schedule', 'minGapMinutes'], label: '失败重试间隔（分钟）', kind: 'number', min: 1, max: 240, step: 1,
        hint: '叫醒失败后至少隔这么久再试（1–240）' },
      { group: '节奏', path: ['schedule', 'cooldownHours'], label: '叫醒后冷却（小时）', kind: 'number', min: 1, max: 240, step: 1,
        hint: '成功叫醒后的硬冷却（默认 30，1–240），避免一天里重复投递' },

      // ── 发布与红线（§4 publish / autoPublish / redlines）──
      { group: '发布与红线', path: ['publish', 'enabled'], label: '允许投稿', kind: 'switch',
        hint: '关 = 只渲染和自审，不生成投稿包' },
      { group: '发布与红线', path: ['publish', 'dryRunByDefault'], label: '默认只出 dry 投稿包', kind: 'switch',
        hint: '保持开：agent 默认不会真投稿' },
      { group: '发布与红线', path: ['publish', 'selfApprove'], label: '自审通过即视为批准', kind: 'switch',
        hint: '关 = 每次投稿前都等你确认（更安全但更麻烦）' },
      { group: '发布与红线', path: ['publish', 'profile'], label: '投稿 profile', kind: 'text', wide: true,
        hint: '默认 ugcfx/bup（B 站网页投稿的物化参数）' },
      { group: '发布与红线', path: ['publish', 'tid'], label: '分区 tid', kind: 'number', min: 1, max: 99999, step: 1,
        hint: '正整数；默认 138（生活·日常）' },
      { group: '发布与红线', path: ['publish', 'partitionName'], label: '分区名（展示）', kind: 'text',
        hint: '例如 生活·日常' },
      { group: '发布与红线', path: ['publish', 'copyright'], label: '版权类型', kind: 'number', min: 1, max: 2, step: 1,
        hint: '1 = 自制；2 = 转载' },
      { group: '发布与红线', path: ['publish', 'noReprint'], label: '禁止转载', kind: 'switch', hint: '默认开' },
      { group: '发布与红线', path: ['publish', 'tags'], label: '追加标签', kind: 'list',
        hint: '逗号分隔（最多 10 个、每个 ≤20 字）；投稿时追加在分区推荐标签之后' },
      { group: '发布与红线', path: ['publish', 'titlePrefix'], label: '标题前缀（可空）', kind: 'text',
        hint: '≤40 字；留空不加前缀' },
      { group: '发布与红线', path: ['autoPublish', 'dryRun'], label: '真发也默认 dry', kind: 'switch',
        hint: '二次保险：即使 allowGo 打开，调用方也要显式要求真发才发' },
      { group: '发布与红线', path: ['autoPublish', 'allowGo'], label: '允许真发（--go）', kind: 'switch', danger: true,
        confirm: '真发开关：打开后，任何一次带 confirm 的真发调用都会把视频真的投稿到 B 站，删不掉、可能造成真实影响。\n\n确定要允许吗？（建议只在真要发的时候打开，发完再关）',
        hint: '默认关。打开前会二次确认；设置页没有「一键真发」按钮，真发始终要调用方再显式 confirm' },
      { group: '发布与红线', path: ['redlines', 'requireAiLabel'], label: 'AI 生成标注（红线）', kind: 'switch', readOnly: true,
        hint: '画面 topbar + 简介必须含「AI 生成」；代码强制，关不掉' },
      { group: '发布与红线', path: ['redlines', 'forbidImpersonation'], label: '不冒充真人（红线）', kind: 'switch', readOnly: true,
        hint: '「我是真人」类表述直接 FAIL；代码强制' },
      { group: '发布与红线', path: ['redlines', 'forbidSpam'], label: '不刷量 / 不群发（红线）', kind: 'switch', readOnly: true,
        hint: '撞 412/429/601 立即停，不自动重试、不绕验证码；代码强制' },
      { group: '发布与红线', path: ['redlines', 'forbidUncreditedClips'], label: '不搬运未标注片段（红线）', kind: 'switch', readOnly: true,
        hint: '引用他人片段必须 UP/标题/BV 三要素齐全且单段 ≤3 秒；代码强制' },
      { group: '发布与红线', path: ['redlines', 'bannedWords'], label: '违禁词（红线）', kind: 'list',
        hint: '逗号分隔（最多 200 个）；审查命中直接 FAIL。可以追加，别删（删了宿主也会按红线补默认值）' },

      // ── 自审（§4 selfReview）──
      { group: '自审', path: ['selfReview', 'enabled'], label: '渲染后自动自审', kind: 'switch',
        hint: '关 = 不跑 review；没有 pass=true 的视频不允许投稿' },
      { group: '自审', path: ['selfReview', 'passScore'], label: '附加评分线', kind: 'range', min: 0, max: 100, step: 1,
        hint: '硬闸门全过 = pass；这条只是质量建议线，不改变 pass' },
      { group: '自审', path: ['selfReview', 'minSubtitleCoverage'], label: '字幕覆盖率下限', kind: 'range', min: 0, max: 1, step: 0.01,
        hint: '0–1；低于下限不算通过' },
      { group: '自审', path: ['selfReview', 'loudnessRange', 0], label: '响度下限（LUFS）', kind: 'number', min: -60, max: 0, step: 0.1,
        hint: '−60..0，且必须小于上限' },
      { group: '自审', path: ['selfReview', 'loudnessRange', 1], label: '响度上限（LUFS）', kind: 'number', min: -60, max: 0, step: 0.1,
        hint: '−60..0，且必须大于下限' },
      { group: '自审', path: ['selfReview', 'requireAiLabel'], label: '自审校验 AI 标注', kind: 'switch',
        hint: '建议保持开；就算关掉，红线表也会拦（别关）' },
      { group: '自审', path: ['selfReview', 'requireRedlineCard'], label: '要求红线卡片画面', kind: 'switch',
        hint: '默认关；开 = 画面里必须有红线条卡' },
      { group: '自审', path: ['selfReview', 'maxClipSec'], label: '引用片段最长（秒）', kind: 'number', min: 0.5, max: 10, step: 0.1,
        hint: '0.5–10；红线是单段 ≤3 秒' },

      // ── 声音（§4 voice）──
      { group: '声音', path: ['voice', 'voice'], label: '配音音色', kind: 'select',
        options: [
          'zh-CN-XiaoyiNeural',
          'zh-CN-XiaoxiaoNeural',
          'zh-CN-YunxiNeural',
          'zh-CN-YunxiaNeural',
          'zh-CN-YunjianNeural',
          'zh-CN-YunyangNeural',
          'zh-CN-liaoning-XiaobeiNeural',
          'zh-CN-shaanxi-XiaoniNeural',
        ],
        hint: 'Edge TTS 音色；列表外的音色要手改配置文件（宿主会校验格式）' },
      { group: '声音', path: ['voice', 'rate'], label: '语速', kind: 'text', placeholder: '+8%',
        hint: 'Edge TTS 格式，例如 +8% / -5%' },
      { group: '声音', path: ['voice', 'pitch'], label: '音高', kind: 'text', placeholder: '+8Hz',
        hint: 'Edge TTS 格式，例如 +8Hz / -10Hz' },

      // ── 渲染与路径（§4 outDir / paths）──
      { group: '渲染与路径', path: ['outDir'], label: '成片根目录', kind: 'text', wide: true,
        hint: '留空 = <DSH_HOME>/bili-faship/videos；/media 只读这个目录里的白名单文件' },
      { group: '渲染与路径', path: ['paths', 'cache'], label: '表情帧缓存', kind: 'text', wide: true,
        hint: '留空 = 默认；env WHALE_VIDEO_CACHE 仍然最优先' },
      { group: '渲染与路径', path: ['paths', 'stickers'], label: '表情包目录', kind: 'text', wide: true,
        hint: '留空 = 按 DESIGN §3 的链回退（优先复用 dsh-bili-whale 的表情包）' },
      { group: '渲染与路径', path: ['paths', 'python'], label: 'Python 解释器', kind: 'text', wide: true,
        hint: '留空 = env WHALE_PYTHON → python；必须带 Pillow' },
      { group: '渲染与路径', path: ['paths', 'ffmpeg'], label: 'ffmpeg 可执行文件', kind: 'text', wide: true,
        hint: '留空 = env FFMPEG → PATH → 插件 bin/ → 剪映自带' },

      // ── 人物与素材（§4 persona / materials）──
      { group: '人物与素材', path: ['persona', 'name'], label: '角色名', kind: 'text', hint: '例如 大肥鱼' },
      { group: '人物与素材', path: ['persona', 'ownerTitle'], label: '她怎么称呼你', kind: 'text', hint: '例如 主人' },
      { group: '人物与素材', path: ['persona', 'selfClaim'], label: '她怎么自称', kind: 'text', hint: '例如 我' },
      { group: '人物与素材', path: ['materials', 'diary'], label: '日记素材文件', kind: 'list',
        hint: '逗号分隔的绝对路径；不存在会被跳过并在汇报里说明' },
      { group: '人物与素材', path: ['materials', 'extraNotes'], label: '额外素材 / 便签', kind: 'list',
        hint: '可选；逗号分隔的绝对路径' },
    ]

    // 分组渲染顺序（DESIGN §8 的界面分区；不在表里的分组兜底排最后，不会消失）
    const GROUP_ORDER = ['节奏', '发布与红线', '自审', '声音', '渲染与路径', '人物与素材']
    const SECTION_HINTS = {
      '节奏': '总开关 + 每 N 天 + 每天的叫醒窗口；两者都满足且到期才会自己叫醒。',
      '发布与红线': '默认只出 dry 投稿包。红线由代码强制（只读）；真发 = allowGo 打开 + 调用方每次再显式 confirm。',
      '自审': '自审不通过（pass=false）的视频不允许投稿；评分线只是建议，不改变 pass。',
      '声音': '配音走 Edge TTS；音色格式宿主会校验（应形如 zh-CN-XiaoyiNeural）。',
      '渲染与路径': '留空 = 按 DESIGN §3 的解析链回退；路径长度上限 500。',
      '人物与素材': '这些会进叫醒词和画面；日记素材目录是只读素材。',
    }

    // ── 样式只注入一次 ──────────────────────────────────────────────────────
    function useStyleOnce() {
      useEffect(() => {
        if (typeof document === 'undefined' || !document) return
        if (document.getElementById(CSS_TAG)) return
        const el = document.createElement('style')
        el.id = CSS_TAG
        el.textContent = CSS
        const host = document.head || document.body || document.documentElement
        if (host && typeof host.appendChild === 'function') host.appendChild(el)
      }, [])
    }

    // ── 数据驱动的一行：switch / number / range / select / list / text ───────
    function FieldRow({ f, value, readOnly, onChange }) {
      const text = f.kind === 'list' ? listToText(value) : (value == null ? '' : String(value))
      const [draft, setDraft] = useState(text)
      const focused = useRef(false)
      // 外部（load / 保存后服务端回值）变了才同步草稿；用户正在打字时不覆盖
      useEffect(() => { if (!focused.current) setDraft(text) }, [text])
      const disabled = Boolean(readOnly)
      let control = null

      if (f.kind === 'switch') {
        control = h('input', {
          className: 'bf-switch',
          type: 'checkbox',
          checked: Boolean(value),
          disabled,
          title: disabled ? '红线由代码强制，界面只读' : undefined,
          onChange: (e) => onChange(Boolean(e.target.checked)),
        })
      } else if (f.kind === 'number') {
        control = h('input', {
          className: 'bf-input bf-num',
          type: 'number',
          value: draft,
          disabled,
          min: f.min,
          max: f.max,
          step: f.step == null ? 'any' : f.step,
          onFocus: () => { focused.current = true },
          onChange: (e) => {
            const raw = e.target.value
            setDraft(raw)
            if (raw === '') { onChange(undefined); return }
            const n = Number(raw)
            if (Number.isFinite(n)) onChange(n)
          },
          onBlur: () => { focused.current = false; setDraft(value == null ? '' : String(value)) },
        })
      } else if (f.kind === 'range') {
        const n = Number(value)
        const shown = Number.isFinite(n) ? n : (f.min == null ? 0 : f.min)
        control = h('div', { className: 'bf-range-wrap' },
          h('input', {
            className: 'bf-input',
            type: 'range',
            value: shown,
            disabled,
            min: f.min == null ? 0 : f.min,
            max: f.max == null ? 100 : f.max,
            step: f.step == null ? 1 : f.step,
            onChange: (e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v)) onChange(v)
            },
          }),
          h('span', { className: 'bf-range-val' }, (f.step && f.step < 1 ? shown.toFixed(2) : String(shown)) + (f.unit || '')))
      } else if (f.kind === 'select') {
        const opts = Array.isArray(f.options) ? f.options.slice() : []
        const cur = value == null ? '' : String(value)
        if (cur && opts.indexOf(cur) < 0) opts.unshift(cur)   // 配置里有列表外的旧值：也要能显示
        control = h('select', {
          className: 'bf-select',
          value: cur,
          disabled,
          onChange: (e) => onChange(e.target.value),
        }, opts.map((o) => h('option', { key: o, value: o }, o)))
      } else if (f.kind === 'list') {
        control = h('input', {
          className: 'bf-input bf-wide',
          value: draft,
          disabled,
          placeholder: f.placeholder || '逗号分隔',
          onFocus: () => { focused.current = true },
          onChange: (e) => { const raw = e.target.value; setDraft(raw); onChange(parseList(raw)) },
          onBlur: () => { focused.current = false; setDraft(listToText(parseList(draft))) },
        })
      } else {
        control = h('input', {
          className: 'bf-input' + (f.wide ? ' bf-wide' : ''),
          value: text,
          disabled,
          placeholder: f.placeholder || '',
          onChange: (e) => onChange(e.target.value),
        })
      }

      return h('div', { className: 'bf-row', 'data-danger': f.danger ? '' : undefined },
        h('div', null,
          h('div', { className: 'bf-label' }, f.label,
            readOnly ? h('span', { className: 'bf-badge bf-lock' }, '只读') : null,
            f.danger ? h('span', { className: 'bf-badge bf-badge-danger' }, '危险') : null),
          f.hint ? h('div', { className: 'bf-hint' }, f.hint) : null),
        control)
    }

    // ── 状态卡（GET /status：到期 / 上次发布 / 待发 / 任务 / 依赖）──────────
    function StatusCard({ status, meta, deps }) {
      const s = status || null
      const sch = (s && s.schedule) || null
      const jobs = s && Array.isArray(s.jobs) ? s.jobs.slice(0, 3) : []
      const pending = s && Array.isArray(s.pending) ? s.pending : []
      const last = (s && s.last) || null
      const depItems = deps && Array.isArray(deps.items) ? deps.items : null
      const depBad = depItems ? depItems.filter((i) => !i.ok && !i.optional).length : null
      const report = (s && s.lastReport) || null

      return h('div', { className: 'bf-card' },
        h('div', { className: 'bf-badges' },
          s
            ? h('span', { className: 'bf-badge', 'data-tone': s.due ? 'good' : undefined }, s.due ? '● 到点了，该做一条' : '○ 还没到期')
            : h('span', { className: 'bf-badge' }, '状态读取中…'),
          h('span', { className: 'bf-badge' }, '上次发布：' + (s && s.lastPublishedAt ? fmtAgo(s.lastPublishedAt) : '从未')),
          h('span', { className: 'bf-badge', 'data-tone': pending.length ? 'warn' : undefined }, '待发：' + pending.length + ' 条'),
          h('span', { className: 'bf-badge' }, '成片：' + (s ? (Number(s.videos) || 0) : 0)),
          jobs.length ? h('span', { className: 'bf-badge', 'data-tone': 'warn' }, '任务：' + jobs.length + ' 个') : null,
          depBad == null
            ? h('span', { className: 'bf-badge' }, '依赖：未体检')
            : h('span', { className: 'bf-badge', 'data-tone': depBad ? 'bad' : 'good' }, '依赖：' + (depBad ? depBad + ' 项不可用' : '全部可用')),
          s && s.indexState
            ? h('span', { className: 'bf-badge', 'data-tone': s.indexState === 'ok' ? undefined : 'warn' },
              '索引：' + indexStateText(s.indexState))
            : null),

        s
          ? h('div', { className: 'bf-kv' },
            h('div', null, h('b', null, '调度'), '：' + (sch
              ? (sch.enabled ? '开' : '关') + ' · ' + scheduleReason(sch.reason) + (sch.inWindow ? ' · 窗口内' : ' · 窗口外')
              : '—')),
            h('div', null, h('b', null, '节律'), '：每 ' + String(s.cadenceDays == null ? '?' : s.cadenceDays) + ' 天一条 · '
              + (s.nextDueAt ? '下次到期 ' + fmtTime(s.nextDueAt) : (s.due ? '现在就可做' : '—'))),
            h('div', null, h('b', null, '叫醒'), '：上次 ' + fmtAgo(sch && sch.lastWakeAt)
              + (sch && sch.wakeable ? ' · 可叫醒' : ' · 当前不可叫醒')),
            last ? h('div', null, h('b', null, '上一条'), '：' + (last.title || last.slug || '(未命名)')
              + (last.bvid ? ' · ' + last.bvid : '')) : null,
            report && report.updatedAt ? h('div', null, h('b', null, '最后汇报'), '：' + fmtTime(report.updatedAt) + '（' + String(report.bytes || 0) + ' 字节）') : null,
            meta && meta.videoRoot ? h('div', null, h('b', null, '成片目录'), '：' + meta.videoRoot) : null,
            meta && meta.configPath ? h('div', null, h('b', null, '配置文件'), '：' + meta.configPath) : null,
            meta && meta.version ? h('div', null, h('b', null, '版本'), '：v' + meta.version + (meta.pluginRoot ? ' · ' + meta.pluginRoot : '')) : null)
          : h('div', { className: 'bf-hint' }, '状态读取中…'),

        // /status 的 ok:false 表示管线状态不健康（payload 仍完整）⇒ 把原因当警告摆出来，不是静默
        s && s.error ? h('div', { className: 'bf-warn' }, '管线状态异常：' + String(s.error)) : null,

        jobs.length
          ? h('div', null, jobs.map((j) => h('div', {
            key: String(j.id || j.startedAt || j.action),
            className: 'bf-hint',
          }, '任务 ' + jobLabel(j.action) + ' · ' + String(j.status || '?') + ' · ' + fmtAgo(j.startedAt)
            + (j.exitCode == null ? '' : ' · exit ' + j.exitCode) + (j.dir ? ' · ' + j.dir : ''))))
          : null,
        pending.length ? h('div', { className: 'bf-hint' }, '待发：' + pending.map((p) => p.title || p.slug).join('、')) : null,
        sch && sch.reason === 'job-running' ? h('div', { className: 'bf-hint' }, '有任务在跑 —— 生物钟这一轮不叫醒，等它结束。') : null,
        sch && sch.enabled === false ? h('div', { className: 'bf-hint' }, '生物钟是关的：不会自己叫醒，只能点「现在做一条」。') : null)
    }

    // ── review.json 摘要（/media?dir=&file=review.json）────────────────────
    function ReviewBox({ rv }) {
      if (!rv || rv.state === 'loading') return h('div', { className: 'bf-hint' }, '读取 review.json…')
      if (rv.state === 'err') return h('div', { className: 'bf-hint' }, '读不到 review.json：' + (rv.error || '未知原因'))
      const data = rv.data || {}
      const checks = Array.isArray(data.checks) ? data.checks : []
      return h('div', { className: 'bf-review' },
        h('div', { className: 'bf-hint' }, 'pass=' + String(data.pass) + ' · score=' + String(data.score == null ? '?' : data.score)
          + ' · 自审时间 ' + fmtTime(data.reviewedAt)),
        checks.length
          ? h('div', { className: 'bf-checks' }, checks.map((c, i) => h('div', {
            key: String(c.id || i),
            className: 'bf-check',
            'data-ok': c.ok ? '' : undefined,
          }, (c.ok ? '✓ ' : '✗ ') + String(c.id || '?') + (c.hard ? '（硬闸门）' : '') + ' — ' + String(c.detail || ''))))
          : h('div', { className: 'bf-hint' }, 'review.json 里没有 checks'),
        h('pre', { className: 'bf-pre' }, JSON.stringify(data, null, 2)))
    }

    // ── 视频卡片（封面/播放走 /media；展开 review 摘要）────────────────────
    function VideoCard({ v, selected, onSelect, expanded, review, onExpand }) {
      const title = v.title || v.slug || '(未命名)'
      const bvid = v.published && v.published.bvid ? String(v.published.bvid) : ''
      const bv = bvUrl(bvid)
      return h('div', { className: 'bf-video', 'data-selected': selected ? '' : undefined },
        v.hasCover
          ? h('img', { className: 'bf-cover', src: mediaUrl(v, 'cover.jpg'), loading: 'lazy', alt: '' })
          : h('div', { className: 'bf-cover bf-cover-none' }, '无封面'),
        h('div', { className: 'bf-video-body' },
          h('div', { className: 'bf-video-title' }, title),
          h('div', { className: 'bf-hint' }, String(v.slug || '') + ' · ' + fmtAgo(v.mtime)),
          h('div', { className: 'bf-badges' },
            h('span', { className: 'bf-badge' }, v.hasVideo ? '有成片' : '未渲染'),
            v.hasStoryboard ? h('span', { className: 'bf-badge' }, '有分镜') : null,
            v.review ? h('span', { className: 'bf-badge', 'data-tone': v.review.pass ? 'good' : 'bad' }, v.review.pass ? '自审通过' : '自审未过') : null,
            v.review && typeof v.review.score === 'number' ? h('span', { className: 'bf-badge' }, '分 ' + v.review.score) : null,
            bv ? h('a', { className: 'bf-badge', href: bv, target: '_blank', rel: 'noreferrer noopener' }, 'B站 ' + bvid) : null),
          h('div', { className: 'bf-video-actions' },
            h('button', { className: 'bf-btn2', onClick: () => onSelect(v) }, selected ? '✓ 已选中' : '选中'),
            v.hasVideo
              ? h('a', { className: 'bf-btn bf-btn2', href: mediaUrl(v, 'video.mp4'), target: '_blank', rel: 'noreferrer noopener' }, '播放')
              : null,
            h('button', { className: 'bf-btn2', onClick: () => onExpand(v) }, expanded ? '收起自审' : '展开自审')),
          expanded ? h(ReviewBox, { rv: review }) : null))
    }

    // ── 成片列表 + 选中后的动作（渲染 / dry 投稿包）─────────────────────────
    function VideosBlock({ videos, root, selectedDir, onSelect, expanded, reviews, onExpand, onRun, busy }) {
      const list = Array.isArray(videos) ? videos : null
      const selected = list && selectedDir ? list.filter((v) => v && v.dir === selectedDir)[0] : null
      return h('div', { className: 'bf-sec' },
        h('div', { className: 'bf-group' }, '成片列表' + (list ? '（' + list.length + '）' : '')),
        h('div', { className: 'bf-hint' }, '目录：' + (root || '—') + ' · 封面/播放/自审都走 /media（只读 videoRoot 内的白名单文件）'),
        h('div', { className: 'bf-actions' },
          h('div', { className: 'bf-hint' }, selected
            ? '已选中：' + (selected.title || selected.slug || selected.dir)
            : '先在下面卡片上点「选中」，再点渲染 / 投稿包'),
          h('div', { className: 'bf-grow' }),
          h('button', {
            className: 'bf-btn2', disabled: Boolean(busy) || !selected,
            onClick: () => onRun('render', selected && selected.dir),
          }, '渲染选中视频'),
          h('button', {
            className: 'bf-btn2', disabled: Boolean(busy) || !selected,
            onClick: () => onRun('publish-dry', selected && selected.dir),
          }, '生成投稿包（dry）')),
        list === null
          ? h('div', { className: 'bf-hint' }, '读取视频列表…')
          : list.length === 0
            ? h('div', { className: 'bf-hint' }, '还没有成片 —— 让 agent 跑一条（或点「现在做一条」）。')
            : h('div', { className: 'bf-videos' }, list.map((v, i) => h(VideoCard, {
              key: String(v.dir || v.slug || i),
              v,
              selected: Boolean(selectedDir && v.dir === selectedDir),
              onSelect,
              expanded: Boolean(expanded && expanded === String(v.slug || v.dir || '')),
              review: reviews[String(v.slug || v.dir || '')],
              onExpand,
            }))))
    }

    // ── 凭据：只写不读（成功即清空输入框，提示里绝不带旧值）────────────────
    function CredentialsBlock({ creds, setCreds, onSave, busy }) {
      const set = (k) => (e) => setCreds({ ...creds, [k]: e.target.value })
      const input = (k, placeholder) => h('input', {
        className: 'bf-input',
        type: 'password',
        autoComplete: 'off',
        spellCheck: false,
        value: creds[k] == null ? '' : creds[k],
        placeholder,
        onChange: set(k),
      })
      const canSave = String(creds.sessdata || '').trim() !== '' && String(creds.bili_jct || '').trim() !== ''
      return h('div', { className: 'bf-sec' },
        h('div', { className: 'bf-group' }, 'B 站凭据（只写不回显）'),
        h('div', { className: 'bf-rows' },
          h('div', { className: 'bf-row' },
            h('div', null,
              h('div', { className: 'bf-label' }, 'Cookie'),
              h('div', { className: 'bf-hint' }, '浏览器 F12 → Application → Cookies 复制。SESSDATA 是 HttpOnly，console 里拿不到。写入 ~/.bili-ai/credentials.json；插件永远不会把旧值读回来显示。')),
            h('div', { className: 'bf-cred' },
              input('sessdata', 'SESSDATA（必填）'),
              input('bili_jct', 'bili_jct（32 位 hex，必填）'),
              input('buvid3', 'buvid3（可空）'),
              h('div', { className: 'bf-video-actions' },
                h('button', {
                  className: 'bf-btn',
                  disabled: Boolean(busy) || !canSave,
                  onClick: onSave,
                }, busy === 'cookie' ? '写入中…' : '写入凭据'))))))
    }

    // ── 顶部动作条（保存 / 依赖体检 / 重新读取 / 现在做一条）───────────────
    function ActionsBar({ busy, dirty, allowGo, onSave, onDeps, onReload, onWake }) {
      return h('div', { className: 'bf-actions' },
        h('button', { className: 'bf-btn', disabled: Boolean(busy), onClick: onSave }, busy === 'save' ? '保存中…' : '保存'),
        dirty ? h('span', { className: 'bf-dirty' }, '● 有改动还没保存（改了不点保存 = 没生效）') : null,
        h('button', { className: 'bf-btn2', disabled: Boolean(busy), onClick: onDeps }, busy === 'deps' ? '体检中…' : '依赖体检'),
        h('button', { className: 'bf-btn2', disabled: Boolean(busy), onClick: onReload }, busy === 'reload' ? '读取中…' : '重新读取'),
        h('button', { className: 'bf-btn2 bf-btn-warn', disabled: Boolean(busy), onClick: onWake }, busy === 'wake' ? '叫醒中…' : '现在做一条'),
        h('div', { className: 'bf-grow' }),
        allowGo
          ? h('span', { className: 'bf-badge', 'data-tone': 'bad' }, '真发已允许')
          : h('span', { className: 'bf-badge' }, '真发未授权'))
    }

    // ══════════════════════════════════════════════════════════════════════
    // Section —— 设置页正文
    // ══════════════════════════════════════════════════════════════════════
    function Section() {
      useStyleOnce()
      const alive = useRef(true)
      useEffect(() => () => { alive.current = false }, [])

      const [cfg, setCfg] = useState(null)
      const [savedJson, setSavedJson] = useState('')
      const [meta, setMeta] = useState(null)
      const [status, setStatus] = useState(null)
      const [deps, setDeps] = useState(null)
      const [videos, setVideos] = useState(null)
      const [videoRoot, setVideoRoot] = useState('')
      const [selectedDir, setSelectedDir] = useState('')
      const [expanded, setExpanded] = useState('')
      const [reviews, setReviews] = useState({})
      const [creds, setCreds] = useState({ sessdata: '', bili_jct: '', buvid3: '' })
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const [out, setOut] = useState('')

      // ── 读取 ──────────────────────────────────────────────────────────
      const loadSettings = async () => {
        const r = await jget('/settings')
        if (!r || !r.config) throw new Error((r && r.error) || '返回里没有 config（宿主版本对不上？）')
        setCfg(r.config)
        setSavedJson(JSON.stringify(r.config))
        setMeta({
          configPath: r.configPath || '',
          videoRoot: r.videoRoot || '',
          pluginRoot: r.pluginRoot || '',
          home: r.home || '',
          version: r.version || '',
        })
        return r
      }
      const loadStatus = async () => {
        // /status 在管线状态不健康时会 200 + ok:false（payload 仍完整）⇒ 宽松读，错误当警告显示
        const r = await jgetLoose('/status')
        if (r && typeof r === 'object') setStatus(r)
        return r
      }
      const loadVideos = async () => {
        const r = await jget('/videos')
        if (r && r.ok !== false) {
          setVideos(Array.isArray(r.videos) ? r.videos : [])
          setVideoRoot(r.root || '')
        }
        return r
      }
      const reloadAll = async () => {
        setBusy('reload'); setErr(''); setOut('')
        try {
          await loadSettings()
          await loadStatus()
          await loadVideos()
          setOut('✓ 已重新读取：配置 / 状态 / 视频列表')
        } catch (e) { setErr('重新读取失败：' + msgOf(e)) } finally { setBusy('') }
      }

      // ── 首次加载 + 状态轮询（15 秒；只读 /status，很便宜）───────────────
      useEffect(() => {
        let gone = false
        const boot = async () => {
          try { await loadSettings() } catch (e) { if (!gone) setErr('读取配置失败：' + msgOf(e)); return }
          try { await loadStatus() } catch (e) { if (!gone) setErr('读取状态失败：' + msgOf(e)) }
          try { await loadVideos() } catch (e) { if (!gone) setErr('读取视频列表失败：' + msgOf(e)) }
        }
        boot()
        const timer = setInterval(() => {
          if (gone || !alive.current) return
          loadStatus().catch(() => { /* 轮询抖动不打扰用户 */ })
        }, 15000)
        return () => { gone = true; clearInterval(timer) }
      }, [])

      // ── 保存：整份 { config }（§5），失败必须显示 ───────────────────────
      const save = async () => {
        if (!cfg) return
        setBusy('save'); setErr(''); setOut('')
        try {
          const r = await postSave(cfg)
          const next = r && r.config ? r.config : cfg
          setCfg(next)
          setSavedJson(JSON.stringify(next))
          const warns = r && Array.isArray(r.warnings) ? r.warnings : []
          const ignored = r && Array.isArray(r.ignored) ? r.ignored : []
          let text = '✓ 已保存'
          if (warns.length) text += '\n⚠️ ' + warns.join('\n⚠️ ')
          if (ignored.length) text += '\n（宿主忽略的键：' + ignored.join('、') + '）'
          if (meta && meta.configPath) text += '\n配置文件：' + meta.configPath
          setOut(text + '\n（未在页面显示的字段已原样保留）')
          await loadStatus()
        } catch (e) { setErr('保存失败：' + msgOf(e)) } finally { setBusy('') }
      }

      // ── 依赖体检（GET /deps）───────────────────────────────────────────
      const checkDeps = async () => {
        setBusy('deps'); setErr(''); setOut('')
        try {
          // /deps 的 ok:false 只表示「有硬依赖不可用」，items 仍要展示 ⇒ 宽松读
          const r = await jgetLoose('/deps')
          if (!r || !Array.isArray(r.items)) throw new Error((r && (r.error || r.detail)) || '宿主没有返回体检项')
          setDeps(r)
          const items = r.items
          const lines = items.map((it) => (it.ok ? '✓ ' : '✗ ') + String(it.name || '?')
            + (it.optional ? '（可选）' : '') + ' — ' + String(it.detail || '')
            + (!it.ok && it.fix ? '\n    修法：' + String(it.fix) : ''))
          const bad = items.filter((it) => !it.ok && !it.optional).length
          lines.push('', bad ? '✗ ' + bad + ' 项硬依赖不可用' : '✓ 硬依赖全部可用')
          if (r.node) lines.push('node：' + (r.node.path || '?') + ' ' + (r.node.version || ''))
          if (r.ffmpeg) lines.push('ffmpeg：' + (r.ffmpeg.path || '?') + ' ' + (r.ffmpeg.version || ''))
          if (r.python) lines.push('python：' + (r.python.path || '?') + ' · Pillow ' + (r.python.pillow || '?'))
          if (r.error) lines.push('', '宿主报错：' + String(r.error))
          setOut(lines.join('\n'))
        } catch (e) { setErr('依赖体检失败：' + msgOf(e)) } finally { setBusy('') }
      }

      // ── 现在做一条（POST /wake，二次确认）──────────────────────────────
      const wakeNow = async () => {
        if (!askConfirm('现在就叫醒鲸鱼娘做一条？\n\n会立刻开一个会话开始选题 / 写分镜 / 渲染，可能要跑几分钟到几十分钟。确定现在做吗？')) return
        setBusy('wake'); setErr(''); setOut('')
        try {
          const r = await jpost('/wake', {})
          setOut('✓ 已经叫醒（会话 ' + String((r && r.sessionId) || 'bili-faship')
            + '，' + fmtTime(r && r.at) + '）\n进度看上面的状态卡「任务」，成片出来会进「成片列表」。')
          await loadStatus()
        } catch (e) {
          const m = msgOf(e)
          setErr('叫醒失败：' + m + (/503/.test(m) ? '\n宿主说 sessionController 拿不到 —— 叫醒功能要在 DSH 里跑，且调度器已激活。' : ''))
        } finally { setBusy('') }
      }

      // ── 渲染 / 投稿包（POST /jobs；不是真发）───────────────────────────
      //   DESIGN §5：render 回后台 job；publish-dry 是同步动作，回 result（两种形状都兼容显示）
      const runJob = async (action, dir) => {
        if (!dir) { setErr('先选一条视频'); return }
        setBusy(action); setErr(''); setOut('')
        try {
          const r = await jpost('/jobs', { action, dir })
          const job = r && r.job
          let text
          if (job) {
            text = '✓ ' + jobLabel(action) + ' 任务已启动（job ' + String(job.id || '?')
              + (job.log ? ' · 日志 ' + job.log : '') + '）\n进度会出现在状态卡「任务」里（15 秒自动刷新）。'
          } else if (r && r.result) {
            text = '✓ ' + jobLabel(action) + ' 完成\n' + JSON.stringify(r.result, null, 2)
          } else {
            text = '✓ ' + jobLabel(action) + ' 完成'
          }
          setOut(text)
          await loadStatus()
        } catch (e) { setErr(jobLabel(action) + '启动失败：' + msgOf(e)) } finally { setBusy('') }
      }

      // ── 凭据（只写；成功清空；绝不回显）────────────────────────────────
      const saveCookie = async () => {
        setBusy('cookie'); setErr(''); setOut('')
        try {
          const body = {
            sessdata: String(creds.sessdata || '').trim(),
            bili_jct: String(creds.bili_jct || '').trim(),
            buvid3: String(creds.buvid3 || '').trim(),
          }
          if (!body.sessdata || !body.bili_jct) throw new Error('SESSDATA 和 bili_jct 都要填')
          const r = await jpost('/cookie', body)
          let text = '✓ ' + String((r && r.detail) || '凭据已写入')
          if (r && r.self) text += '（' + String(r.self.name || '?') + ' · mid ' + String(r.self.mid || '?') + '）'
          if (r && r.warn) text += '\n⚠️ ' + String(r.warn)
          text += '\n（凭据只写不读；要换就整组重填再写入）'
          setOut(text)
          setCreds({ sessdata: '', bili_jct: '', buvid3: '' })
          await loadStatus()
        } catch (e) { setErr('写入凭据失败：' + msgOf(e)) } finally { setBusy('') }
      }

      // ── 表单写入（危险字段先 confirm；fail-closed）─────────────────────
      const setFieldSafe = (f, value) => {
        const risky = f && f.confirm && value !== false && value !== '' && value != null
        if (risky && !askConfirm(f.confirm)) return
        setCfg((prev) => {
          const next = JSON.parse(JSON.stringify(prev || {}))
          setPath(next, f.path, value)
          return next
        })
      }

      // ── 展开 / 收起 review 摘要（懒加载 review.json）───────────────────
      const onExpand = async (v) => {
        const key = String((v && (v.slug || v.dir)) || '')
        if (!key) return
        if (expanded === key) { setExpanded(''); return }
        setExpanded(key)
        const cur = reviews[key]
        if (cur && (cur.state === 'ok' || cur.state === 'loading')) return
        setReviews((prev) => ({ ...prev, [key]: { state: 'loading' } }))
        try {
          const res = await fetch(mediaUrl(v, 'review.json'), { credentials: 'same-origin' })
          if (!res.ok) throw new Error(res.status === 404 ? '还没有 review.json（先跑自审）' : 'HTTP ' + res.status)
          const data = await res.json()
          setReviews((prev) => ({ ...prev, [key]: { state: 'ok', data } }))
        } catch (e) {
          setReviews((prev) => ({ ...prev, [key]: { state: 'err', error: msgOf(e) } }))
        }
      }

      // ── 还没读到配置：给明确状态，别装死 ──────────────────────────────
      if (!cfg) {
        return h('div', { className: 'bf' },
          h('h3', { className: 'bf-title' }, LABEL),
          err
            ? h('div', { className: 'bf-err' }, err)
            : h('div', { className: 'bf-hint' }, '读取配置中…'))
      }

      // ── 分组渲染（GROUP_ORDER 显式定死；未知分组兜底排最后）────────────
      const groups = []
      for (const f of FIELDS) {
        let g = groups.filter((x) => x.name === f.group)[0]
        if (!g) { g = { name: f.group, fields: [] }; groups.push(g) }
        g.fields.push(f)
      }
      const ordered = GROUP_ORDER.map((name) => groups.filter((g) => g.name === name)[0]).filter(Boolean)
      const known = new Set(GROUP_ORDER)
      const leftovers = groups.filter((g) => !known.has(g.name))
      const allowGoNow = Boolean(getPath(cfg, ['autoPublish', 'allowGo']))
      const dirty = savedJson !== '' && JSON.stringify(cfg) !== savedJson

      const renderGroup = (g) => h('div', { className: 'bf-sec', key: g.name },
        h('div', { className: 'bf-group' }, g.name),
        SECTION_HINTS[g.name] ? h('div', { className: 'bf-hint' }, SECTION_HINTS[g.name]) : null,
        h('div', { className: 'bf-rows' }, g.fields.map((f) => h(FieldRow, {
          key: fieldKey(f),
          f,
          value: getPath(cfg, f.path),
          readOnly: Boolean(f.readOnly),
          onChange: (v) => setFieldSafe(f, v),
        }))))

      return h('div', { className: 'bf' },
        h('h3', { className: 'bf-title' }, LABEL),
        h('p', { className: 'bf-intro' },
          '让 agent 按节奏自己构思 → 写分镜 → 配音/逐帧渲染 → 自审 → 投稿。所有值写进 ',
          h('code', null, (meta && meta.configPath) || '配置文件'),
          '（页面没显示的字段保存时原样保留）。'),

        h(StatusCard, { status, meta, deps }),

        err ? h('div', { className: 'bf-err' }, err) : null,
        out ? h('div', { className: 'bf-out' }, out) : null,

        h(ActionsBar, {
          busy, dirty, allowGo: allowGoNow,
          onSave: save, onDeps: checkDeps, onReload: reloadAll, onWake: wakeNow,
        }),

        allowGoNow
          ? h('div', { className: 'bf-warn' },
            '⚠️ 真发授权已打开（autoPublish.allowGo=true）—— 之后任何一次带 confirm 的真发调用都会真的投稿到 B 站。发完建议马上关掉；本页没有「一键真发」按钮。')
          : null,

        ordered.map(renderGroup),
        leftovers.map(renderGroup),

        h(CredentialsBlock, { creds, setCreds, onSave: saveCookie, busy }),

        h(VideosBlock, {
          videos,
          root: videoRoot || (meta && meta.videoRoot) || '',
          selectedDir,
          onSelect: (v) => setSelectedDir(String((v && v.dir) || '')),
          expanded,
          reviews,
          onExpand,
          onRun: runJob,
          busy,
        }),

        h('div', { className: 'bf-foot' },
          h('div', { className: 'bf-hint' }, '红线（代码强制，关不掉）：AI 生成标注 / 不冒充真人 / 不搬运未标注片段 / 不刷量不群发 / 撞 412·429·601 立即停。'),
          h('div', { className: 'bf-hint' }, '真投稿必须同时满足：review.pass === true、autoPublish.allowGo === true、调用方显式 confirm。设置页不提供绕过的入口。'),
          meta && meta.home ? h('div', { className: 'bf-hint' }, 'DSH home：' + meta.home) : null))
    }

    // ── 注册进 DSH 设置（DESIGN §8；与 dsh-bili-whale「养鱼」同一个 slot）───
    const inject = ['slots']
    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: NS, order: ORDER, label: () => LABEL },
        Section,
      )))
    }

    exports.apply = apply
    exports.inject = inject
    exports.Section = Section
    exports.FIELDS = FIELDS
    exports.GROUP_ORDER = GROUP_ORDER
    exports.API = API
    // 给 tests/client.test.mjs 与 selfcheck 用的内部工具（不是公开 API；但也别删，测试认它）
    exports.__internals = {
      asJson,
      askConfirm,
      getPath,
      setPath,
      parseList,
      listToText,
      saveBody,
      postSave,
      payloadError,
      mediaDir,
      mediaUrl,
      bvUrl,
      fmtTime,
      fmtAgo,
      scheduleReason,
      indexStateText,
      jobLabel,
      fieldKey,
      FieldRow,
      StatusCard,
      VideosBlock,
      CredentialsBlock,
      ActionsBar,
    }
    return module.exports
  },
})
