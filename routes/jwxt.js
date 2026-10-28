/**
 * 教务课表接口
 *
 * P1（演示）：GET /api/jwxt/timetable-demo
 *   直接回放已在本地留存的真实课表快照（data/jwxt-demo-2026-1.json），
 *   用于小程序界面联调，不触碰教务系统，不接收任何账号密码。
 *
 * P2（真实抓取）：POST /api/jwxt/timetable —— 另文件实现。
 *
 * 安全：本文件不接收、不记录、不落盘任何教务口令。
 */
const express = require('express')
const fs = require('fs')
const path = require('path')

const router = express.Router()

const DEMO_FILE = path.join(__dirname, '..', 'data', 'jwxt-demo-2026-1.json')

// ── P2 真实抓取（2026-10-26）：登录 / 取课表 ────────────────────────────────
const sessionStore = require('../services/jwxtSessionStore')
const { loginForCookies } = require('../services/jwxtBrowserLogin')
const { fetchTimetable } = require('../services/jwxtFetchService')
const jwxtService = require('../services/jwxtService')

const SID_RE = /^\d{8,14}$/
// 登录很贵（要开浏览器过滑块），同一时刻只允许 1 个，且同一 IP 每分钟最多 3 次
let loginBusy = false
const loginHits = new Map()
function throttleLogin(ip) {
  const now = Date.now()
  const arr = (loginHits.get(ip) || []).filter((t) => now - t < 60000)
  arr.push(now)
  loginHits.set(ip, arr)
  return arr.length <= 3
}

function httpCodeFor(code) {
  if (code === 'JWXT_BAD_STUDENT_ID' || code === 'JWXT_BAD_PASSWORD' || !code) return 400
  if (code === 'JWXT_LOGIN_REJECTED') return 401
  if (code === 'JWXT_SITE_UNREACHABLE' || code === 'JWXT_BROWSER_LAUNCH_FAIL' || code === 'JWXT_BROWSER_MISSING') return 503
  if (code === 'JWXT_SLIDER_FAIL' || code === 'JWXT_PAGE_NOT_READY' || code === 'JWXT_LOGIN_TIMEOUT') return 502
  // P9 CAS 通道（2026-10-26）：网关侧打不通 = 503，CAS 自己回的东西不对 = 502
  if (code === 'CAS_UNREACHABLE') return 503
  if (/^CAS_/.test(code)) return 502
  return 500
}

let demoCache = null
let demoCacheMtime = 0

function loadDemo() {
  const stat = fs.statSync(DEMO_FILE)
  if (demoCache && stat.mtimeMs === demoCacheMtime) return demoCache
  const raw = JSON.parse(fs.readFileSync(DEMO_FILE, 'utf8'))
  const kb = Array.isArray(raw) ? raw : raw.kb || raw.kbList || []
  const xsxx = (Array.isArray(raw) ? {} : raw.xsxx) || {}
  demoCache = {
    xsxx,
    kb,
    kbList: kb, // 兼容官方字段名，端上两种都能读
    count: kb.length,
    term: {
      xnm: xsxx.XNM || '2026',
      xqm: xsxx.XQM || '3',
      label: xsxx.XNMC ? `${xsxx.XNMC}学年第${xsxx.XQMMC || '1'}学期` : '2026-2027学年第1学期',
    },
    source: 'demo_snapshot',
    sourceLabel: '本地留存的教务真实课表快照（演示用）',
    snapshotAt: stat.mtime.toISOString(),
  }
  demoCacheMtime = stat.mtimeMs
  return demoCache
}

// GET /api/jwxt/timetable-demo
router.get('/timetable-demo', (req, res) => {
  try {
    const data = loadDemo()
    res.set('Cache-Control', 'no-store')
    return res.json({ code: 0, message: 'ok', data })
  } catch (err) {
    console.error('[jwxt] 演示课表读取失败:', err.message)
    return res.status(500).json({ code: 500, message: '演示课表数据不可用' })
  }
})

/**
 * POST /api/jwxt/login
 * body: { studentId, password }
 * 只做一件事：真浏览器过滑块登录，把 cookie 存 app_state_kv 的 jwxt:session:<学号>（12 小时）。
 * 口令只在本进程内存里用一次，不入库、不入日志；响应里也不回显任何口令/cookie 值。
 */
router.post('/login', async (req, res) => {
  const body = req.body || {}
  const sid = String(body.studentId || '').trim()
  const password = body.password === undefined || body.password === null ? '' : String(body.password)
  if (!SID_RE.test(sid)) return res.status(400).json({ code: 40001, message: '学号格式不正确（8–14 位数字）' })
  if (password.length < 4) return res.status(400).json({ code: 40002, message: '密码不能为空' })
  if (loginBusy) return res.status(429).json({ code: 42901, message: '另一个登录正在进行，请稍后重试' })
  if (!throttleLogin(req.ip)) return res.status(429).json({ code: 42902, message: '登录过于频繁，请 1 分钟后再试' })

  loginBusy = true
  const t0 = Date.now()
  try {
    const { cookies, stats } = await loginForCookies({ studentId: sid, password })
    const saved = await sessionStore.put(sid, { cookies, loginMs: stats.loginMs, sliderMs: stats.sliderMs })
    return res.json({
      code: 0,
      message: 'ok',
      data: {
        studentId: sid,
        cookieCount: cookies.length,
        cookieKeys: cookies.map((c) => c.name),
        expiresAt: new Date(saved.expiresAt).toISOString(),
        ttlHours: sessionStore.TTL_MS / 3600000,
        storeKey: saved.key,
        store: saved.backend,
        loginMs: stats.loginMs,
        sliderMs: stats.sliderMs,
        authMode: stats.authMode || null,
        casError: stats.casError || null,
        casMessage: stats.casMessage || null,
        sliderGap: stats.tries && stats.tries[0] ? stats.tries[0].gap : null,
        sliderSteps: stats.tries && stats.tries[0] ? stats.tries[0].steps : null,
        totalMs: Date.now() - t0,
      },
    })
  } catch (err) {
    const code = err.code || 'JWXT_LOGIN_FAILED'
    console.error('[jwxt] 登录失败:', code, err.message)
    return res.status(httpCodeFor(code)).json({ code, message: err.message, elapsedMs: Date.now() - t0 })
  } finally {
    loginBusy = false
  }
})

/**
 * POST /api/jwxt/timetable
 * body: { studentId, xnm?, xqm?, password? }
 * 先查 app_state_kv 里 12 小时内的会话复用；没有/过期才登录（需要 body 带 password）。
 * 取课表本身是纯 HTTP（不渲染页面），返回 kbList 原始数组 + 解析后的 sessions。
 */
router.post('/timetable', async (req, res) => {
  const body = req.body || {}
  const sid = String(body.studentId || '').trim()
  const password = body.password === undefined || body.password === null ? '' : String(body.password)
  const xnm = String(body.xnm || '2026')
  const xqm = String(body.xqm || '3')
  if (!SID_RE.test(sid)) return res.status(400).json({ code: 40001, message: '学号格式不正确（8–14 位数字）' })
  const t0 = Date.now()

  let session = await sessionStore.get(sid)
  let servedFrom = session && !session.expired ? 'kv_reuse' : null
  let loginInfo = null

  const doLogin = async () => {
    if (loginBusy) { const e = new Error('另一个登录正在进行，请稍后重试'); e.code = 'JWXT_LOGIN_BUSY'; throw e }
    if (!password) { const e = new Error('登录已过期或尚未登录，请先登录'); e.code = 'JWXT_NEED_LOGIN'; throw e }
    loginBusy = true
    try {
      const r = await loginForCookies({ studentId: sid, password })
      const saved = await sessionStore.put(sid, { cookies: r.cookies, loginMs: r.stats.loginMs, sliderMs: r.stats.sliderMs })
      loginInfo = { loginMs: r.stats.loginMs, sliderMs: r.stats.sliderMs, authMode: r.stats.authMode || null, casError: r.stats.casError || null, expiresAt: new Date(saved.expiresAt).toISOString(), store: saved.backend }
    } finally {
      loginBusy = false
    }
    session = await sessionStore.get(sid)
    servedFrom = 'fresh_login'
  }

  try {
    if (!session || session.expired) await doLogin()
    let r = await fetchTimetable({ cookieHeader: sessionStore.cookieHeader(session.cookies), xnm, xqm })
    // 会话被服务端判无效 → 有口令就重登一次再试
    if (r.verdict !== 'OK' && /SESSION_EXPIRED/.test(r.verdict) && password) {
      await sessionStore.del(sid)
      await doLogin()
      r = await fetchTimetable({ cookieHeader: sessionStore.cookieHeader(session.cookies), xnm, xqm })
    }
    if (r.verdict !== 'OK') {
      if (/SESSION_EXPIRED/.test(r.verdict)) await sessionStore.del(sid)
      return res.status(502).json({
        code: 'JWXT_FETCH_' + r.verdict,
        message: r.verdict === 'SESSION_EXPIRED_HTML' ? '教务会话已失效，请重新登录' : '教务返回了非课表数据',
        data: { http: r.http, bytes: r.bytes, fetchMs: r.ms, needsLogin: /SESSION_EXPIRED/.test(r.verdict) },
      })
    }
    const sessions = jwxtService.parseZhengfangKbList(r.kbList)
    return res.json({
      code: 0,
      message: 'ok',
      data: {
        studentId: sid,
        term: { xnm, xqm, label: (r.xsxx && r.xsxx.XNMC ? r.xsxx.XNMC + '学年' : '2026-2027学年') },
        studentName: (r.xsxx && r.xsxx.XM) || '',
        className: (r.xsxx && r.xsxx.BJMC) || '',
        rows: r.rows,
        sessionCount: sessions.length,
        kbList: r.kbList,
        sessions,
        source: 'jwglxt_direct',
        servedFrom,
        timings: { fetchMs: r.ms, sessionTtlLeftMin: Math.round((session.ttlLeftMs || 0) / 60000), totalMs: Date.now() - t0 },
        login: loginInfo,
      },
    })
  } catch (err) {
    const code = err.code || 'JWXT_TIMETABLE_FAILED'
    if (code === 'JWXT_NEED_LOGIN') {
      return res.status(401).json({ code: 40102, message: err.message, data: { needsLogin: true, studentId: sid } })
    }
    console.error('[jwxt] 取课表失败:', code, err.message)
    return res.status(httpCodeFor(code)).json({ code, message: err.message, elapsedMs: Date.now() - t0 })
  }
})

// ── P3 隧道模式（2026-10-26 上线）：转发给已挂 EasyConnect VPN 的内网网关 ──
// 云托管容器在公网，直连 jwglxt.ycit.edu.cn 是不通的（学校限制校外访问）。
// 内网网关 43.142.152.33 上有 EasyConnect 隧道 + headless 浏览器，代为登录并取回课表，
// 本服务只做转发、短时缓存和同一学号并发合并，不落盘任何口令。
const http = require('http')
const { URL } = require('url')

const KB_BRIDGE_URL = process.env.KB_BRIDGE_URL || 'http://43.142.152.33/kb'
const KB_TIMEOUT_MS = Number(process.env.KB_TIMEOUT_MS || 150000)
const KB_CACHE_TTL_MS = 5 * 60 * 1000

const kbCache = new Map()
const kbPending = new Map()

function bridgeOpts(pathname) {
  const u = new URL(KB_BRIDGE_URL)
  return { hostname: u.hostname, port: Number(u.port) || 80, path: pathname, protocol: u.protocol }
}

function upstreamPull(studentId, password) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ id: studentId, password })
    const o = bridgeOpts(new URL(KB_BRIDGE_URL).pathname || '/kb')
    const req = http.request(
      {
        hostname: o.hostname,
        port: o.port,
        path: o.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: KB_TIMEOUT_MS,
      },
      (res) => {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { buf += c })
        res.on('end', () => {
          let parsed = null
          try { parsed = JSON.parse(buf) } catch (e) { /* 见下 */ }
          if (!parsed) {
            return reject(Object.assign(new Error('上游返回非 JSON：' + buf.slice(0, 160)), { code: 'KB_BAD_UPSTREAM' }))
          }
          if (res.statusCode !== 200 || parsed.ok === false) {
            return reject(Object.assign(new Error(parsed.error || ('上游 HTTP ' + res.statusCode)), { code: 'KB_UPSTREAM_FAIL' }))
          }
          resolve(parsed)
        })
      }
    )
    req.on('timeout', () => req.destroy(Object.assign(new Error('课表上游超时（' + KB_TIMEOUT_MS + 'ms）'), { code: 'KB_TIMEOUT' })))
    req.on('error', (e) => reject(Object.assign(e, { code: e.code || 'KB_NETWORK' })))
    req.write(body)
    req.end()
  })
}

async function pullWithCache(studentId, password, force) {
  const hit = kbCache.get(studentId)
  if (!force && hit && Date.now() - hit.at < KB_CACHE_TTL_MS) {
    return { data: hit.data, servedFrom: 'cache', ageMs: Date.now() - hit.at }
  }
  if (kbPending.has(studentId)) {
    const data = await kbPending.get(studentId)
    return { data, servedFrom: 'shared-inflight', ageMs: 0 }
  }
  const p = upstreamPull(studentId, password)
    .then((d) => { kbCache.set(studentId, { at: Date.now(), data: d }); return d })
    .finally(() => kbPending.delete(studentId))
  kbPending.set(studentId, p)
  const data = await p
  return { data, servedFrom: 'live', ageMs: 0 }
}

// 隧道健康检查：云托管 -> 内网网关
router.get('/bridge-health', (req, res) => {
  const t0 = Date.now()
  const o = bridgeOpts('/health')
  const r = http.request({ hostname: o.hostname, port: o.port, path: '/health', method: 'GET', timeout: 8000 }, (rs) => {
    let b = ''
    rs.setEncoding('utf8')
    rs.on('data', (c) => { b += c })
    rs.on('end', () => res.json({ code: 0, data: { upstream: KB_BRIDGE_URL, reachable: rs.statusCode === 200, status: rs.statusCode, body: b.slice(0, 200), ms: Date.now() - t0 } }))
  })
  r.on('timeout', () => r.destroy(Object.assign(new Error('上游健康检查超时'), { code: 'KB_TIMEOUT' })))
  r.on('error', (e) => res.status(502).json({ code: 'KB_BRIDGE_UNREACHABLE', message: e.message, upstream: KB_BRIDGE_URL, ms: Date.now() - t0 }))
  r.end()
})

// 拉取个人课表：POST /api/jwxt/pull { studentId, password, refresh? }
router.post('/pull', async (req, res) => {
  const t0 = Date.now()
  const b = req.body || {}
  const studentId = String(b.studentId || b.id || '').trim()
  const password = String(b.password || '')
  const force = !!b.refresh
  if (!/^\d{6,20}$/.test(studentId)) return res.status(400).json({ code: 'BAD_STUDENT_ID', message: '学号应为 6-20 位数字' })
  if (password.length < 4) return res.status(400).json({ code: 'BAD_PASSWORD', message: '密码不能为空' })
  try {
    const r = await pullWithCache(studentId, password, force)
    if (r.servedFrom === 'pulling') return res.status(200).json({ code: 202, message: '正在从教务系统取课表，大约再等 10-30 秒，再点一次就能看到', data: { servedFrom: 'pulling', pulling: true, totalMs: Date.now() - t0 } })
    return res.json({ code: 0, data: Object.assign({}, r.data, { servedFrom: r.servedFrom, cacheAgeMs: r.ageMs, totalMs: Date.now() - t0 }) })
  } catch (e) {
    const code = e.code || 'KB_PULL_FAILED'
    console.error('[jwxt] 隧道取课表失败:', code, e.message)
    return res.status(code === 'KB_TIMEOUT' ? 504 : 502).json({ code, message: e.message, elapsedMs: Date.now() - t0 })
  }
})

module.exports = router
