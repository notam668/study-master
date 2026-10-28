/**
 * 教务（正方 jwglxt.ycit.edu.cn）浏览器登录：只负责「过滑块 + 登录 + 交回 cookie」
 *
 * 为什么要有这个文件：教务登录被服务端强校验的顶象滑块（zfcaptchaLogin）挡着，
 * 纯 HTTP 拿不到会话（2026-10-26 实测：不带滑块直接 POST，服务端回「请先滑动图片进行验证！」）。
 * 唯一可行路径 = 真浏览器 + 真鼠标事件（Playwright mouse → CDP Input.dispatchMouseEvent，isTrusted=true）。
 *
 * 2026-10-26 本机实测（Playwright 1.64.1 / Chromium 156.0.8078.4，headed）：
 *   首次即通，滑块 1.6s 过（25 步），登录 2.1s，取回课表 26 条。
 *
 * 铁律：
 *  - 口令只在本进程内存里用一次，不打印、不写盘、不进日志、不进异常信息。
 *  - 本文件不落 cookie、不落课表；只 return 给调用方。
 *
 * ── 2026-10-26 P9：主路径改 CAS2 统一认证（滑块降为兜底）───────────────────
 * 老板 10-26 00:13 给的非滑块入口：
 *   https://cas2.ycit.edu.cn/cas/login?service=https%3A%2F%2Fportal.ycit.edu.cn%2F...
 * 实证（本机已抓到的登录页 dept-dev/probes/2026-10-26-timetable/cas_login.html）：
 *   CAS 是 Vue 单页，**整页没有任何滑块/顶象资源**（zfdun/slide/nc_/aliyun/geetest/jigsaw 命中 0），
 *   只有一个「图片验证码」文本框，且配置 captchaSkipN=3（前 3 次免验证码）、mfaEnabled=false。
 *   密码在 JS 侧 RSA-2048 PKCS1v15 加密，加前缀 `__RSA__`：password = "__RSA__" + base64(enc)。
 *   纯 HTTP 即可登录，不需要真浏览器（2026-10-26 01:06 已验：POST 带 _eventId=submit + submit=Login1
 *   才拿得到 302 票据，缺一个就 200 原地不动）。
 *
 * 开关：JWXT_AUTH_MODE=cas|slider（默认 cas）。cas 失败且失败码不是「口令被拒」时，
 * 自动落到原滑块通道（JWXT_CAS_FALLBACK=0 可关掉这个兜底）。口令被拒绝不重试、绝不换通道，
 * 防两个系统各记一次错密码把账号锁掉。
 */
const fs = require('fs')

// 依赖解析：容器/正式环境应 `npm i playwright`；本机沿用部门探针目录里的安装，避免改老板的 package.json
function loadPlaywright() {
  const tries = [
    'playwright',
    process.env.PLAYWRIGHT_MODULE_PATH,
    'C:/Users/manjunzong/hermes_company/dept-dev/probes/2026-10-26-p2-playwright/node_modules/playwright',
  ].filter(Boolean)
  let lastErr = null
  for (const p of tries) {
    try {
      return require(p)
    } catch (e) {
      lastErr = e
    }
  }
  const err = new Error('服务端未安装 playwright：npm i playwright && npx playwright install chromium')
  err.code = 'JWXT_BROWSER_MISSING'
  err.cause = lastErr && lastErr.message
  throw err
}

const REAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0'
// 2026-10-26 P7：加一个只读的站点覆盖口，仅为「用假服务端验密码错路径」存在（JWXT_BASE=http://127.0.0.1:PORT）。
// 不设时永远是真教务，线上行为不变；测试脚本用它，测试全程不碰 jwglxt.ycit.edu.cn。
const BASE = process.env.JWXT_BASE || 'https://jwglxt.ycit.edu.cn'
const LOGIN_URL = BASE + '/xtgl/login_slogin.html'
const LOGIN_OK_URL = /index_initMenu|xtgl\/index|index\.html/i

// ── P9：CAS2 统一认证通道的常量 ─────────────────────────────────────────────
const crypto = require('crypto')
// 只读站点覆盖口（与 JWXT_BASE 同性质）：只为「用本地假 CAS 验通/验错」存在，不设时永远是真 CAS。
const CAS_BASE = process.env.JWXT_CAS_BASE || 'https://cas2.ycit.edu.cn'
// 老板 00:13 给的原样 service（portal 首页）。CAS 对 service 白名单强校验，不能随手改。
const CAS_SERVICE =
  process.env.JWXT_CAS_SERVICE ||
  'https://portal.ycit.edu.cn/?path=https%3A%2F%2Fportal.ycit.edu.cn%2Fmain.html%23%2F'
// 若 jwglxt 本身登记了 CAS 客户端，用这个 SSO 入口换 ticket 就能免滑块拿正方会话。
// 该入口路径**今日无网未验**（2026-10-26 12:30 校内四站全不通），故做成可覆盖，验通前只当加分项。
const CAS_JWXT_SSO =
  process.env.JWXT_CAS_JWXT_SSO || BASE + '/xtgl/login_ssologin.html'
const AUTH_MODE = String(process.env.JWXT_AUTH_MODE || 'cas').toLowerCase() === 'slider' ? 'slider' : 'cas'
const CAS_FALLBACK = String(process.env.JWXT_CAS_FALLBACK || '1') !== '0'
const CAS_TIMEOUT_MS = Number(process.env.JWXT_CAS_TIMEOUT_MS || 20000)
const CAS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0'


// 等登录结果的总窗口（2026-10-26 老板令 P7：24s → 8s）
const LOGIN_WAIT_MS = 8000
const LOGIN_POLL_MS = 250

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rnd = (a, b) => a + Math.random() * (b - a)

// ── 重试闸门（2026-10-26 老板令·防锁号）──────────────────────────────────────
// 原来 :298 是黑名单（/BAD_|BROWSER_/ 放行），漏掉了 JWXT_LOGIN_REJECTED —— 密码错会被
// 整个循环重试最多 3 轮，每轮都是一次真实的错密码，教务 lockErrorTimes 计数翻倍，5 次锁号。
// 现在改成白名单：只有「口令还没提交过」的失败（滑块/页面/图片/站点打不开/浏览器类）才重试；
// 口令一旦提交（JWXT_LOGIN_REJECTED 密码错、JWXT_LOGIN_TIMEOUT 提交后没回音）立刻抛出，绝不重试。
// 未知错误码默认不重试（fail-safe）：宁可让用户重试一次，也不让机器自己试锁账号。
const RETRYABLE = /^JWXT_(SLIDER_FAIL|SLIDER_FAILED|NO_GAP|NO_IMG|PAGE_NOT_READY|BTN_OFFSCREEN|SITE_UNREACHABLE|BROWSER_)/
const SLIDER_LIKE = /^JWXT_(SLIDER_FAIL|SLIDER_FAILED|NO_GAP|NO_IMG|PAGE_NOT_READY|BTN_OFFSCREEN)/

// 滑块缺口识别（纯 Node 标准库解 PNG）：亮度抬升 + 饱和度下降 + 竖直边 三线索投票
function detectGap(bgBuf, jgBuf) {
  const { decodePNG } = require('./pngLite')
  const bg = decodePNG(bgBuf)
  const jg = decodePNG(jgBuf)
  const W = bg.w
  const H = bg.h
  let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1
  const A = jg.rgba
  for (let y = 0; y < jg.h; y++)
    for (let x = 0; x < jg.w; x++)
      if (A[(y * jg.w + x) * 4 + 3] > 127) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  if (x1 < 0) { const e = new Error('拼图块没有 alpha 轮廓'); e.code = 'JWXT_NO_GAP'; throw e }
  const pw = x1 - x0 + 1, ph = y1 - y0 + 1
  const mask = new Uint8Array(pw * ph)
  let mcount = 0
  for (let y = 0; y < ph; y++)
    for (let x = 0; x < pw; x++)
      if (A[((y + y0) * jg.w + (x + x0)) * 4 + 3] > 127) { mask[y * pw + x] = 1; mcount++ }
  const B = bg.rgba
  const lum = new Float32Array(W * H), sat = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) {
    const r = B[i * 4], g = B[i * 4 + 1], b = B[i * 4 + 2]
    lum[i] = (r + g + b) / 3
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    sat[i] = (mx - mn) / Math.max(mx, 1)
  }
  const gx = new Float32Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) gx[y * W + x] = Math.abs(lum[y * W + x + 1] - lum[y * W + x])
  const cands = []
  for (let X = 0; X <= W - pw; X++) {
    let sl = 0, ss = 0
    for (let y = 0; y < ph; y++) {
      const by = y + y0
      if (by < 0 || by >= H) continue
      for (let x = 0; x < pw; x++) {
        if (!mask[y * pw + x]) continue
        const bx = X + x
        if (bx < 0 || bx >= W) continue
        sl += lum[by * W + bx]; ss += sat[by * W + bx]
      }
    }
    sl /= (mcount || 1); ss /= (mcount || 1)
    let rl = 0, rs = 0, rc = 0
    for (let y = 0; y < ph; y++) {
      const by = y + y0
      if (by < 0 || by >= H) continue
      for (let x = Math.max(0, X - 12); x < X; x++) { rl += lum[by * W + x]; rs += sat[by * W + x]; rc++ }
    }
    if (!rc) { rl = sl; rs = ss; rc = 1 }
    rl /= rc; rs /= rc
    let edge = 0
    for (let y = 0; y < ph; y++) {
      const by = y + y0
      if (by < 0 || by >= H) continue
      if (X < W) edge += gx[by * W + X]
      const xe = X + pw - 1
      if (xe >= 0 && xe < W) edge += gx[by * W + xe]
    }
    edge /= (ph * 2 || 1)
    cands.push({ x: X, climb: sl - rl, desat: rs - ss, edge })
  }
  const norm = (k) => {
    let mn = 1e18, mx = -1e18
    for (const c of cands) { if (c[k] < mn) mn = c[k]; if (c[k] > mx) mx = c[k] }
    const d = mx - mn || 1
    for (const c of cands) c[k + '_n'] = (c[k] - mn) / d
  }
  norm('climb'); norm('desat'); norm('edge')
  for (const c of cands) c.score = 0.5 * c.climb_n + 0.2 * c.desat_n + 0.3 * c.edge_n
  cands.sort((a, b) => b.score - a.score)
  return { gap: cands[0].x, score: +cands[0].score.toFixed(3), pieceW: pw, bgW: W, bgH: H }
}

// 真人手感拖动：分步 + y 轴抖动 + 中段一次回拉 + 随机停顿 + 松手前停顿
async function drag(page, x0, y0, dist) {
  const t0 = Date.now()
  await page.mouse.move(x0, y0)
  await sleep(rnd(80, 140))
  await page.mouse.down()
  await sleep(rnd(140, 320))
  let moved = 0, steps = 0, back = false
  while (moved < dist) {
    const remain = dist - moved
    let step
    if (remain > 60) step = Math.max(3, Math.round(remain * rnd(0.09, 0.2)))
    else if (remain > 16) step = Math.max(1, Math.round(remain * rnd(0.2, 0.4)))
    else step = 1
    moved = Math.min(dist, moved + step)
    if (!back && moved / dist > 0.6 && Math.random() < 0.75) {
      back = true
      await page.mouse.move(x0 + Math.max(0, moved - rnd(1.5, 3.5)), y0 + rnd(-1.2, 1.2)); steps++
      await sleep(rnd(16, 40))
    }
    const jy = Math.random() < 0.34 ? y0 + rnd(-1.4, 1.4) : y0 + rnd(-0.4, 0.4)
    await page.mouse.move(x0 + moved, jy); steps++
    await sleep(Math.random() < 0.12 ? rnd(45, 95) : rnd(8, 26))
  }
  await page.mouse.move(x0 + dist, y0 + rnd(-0.5, 0.5)); steps++
  await sleep(rnd(90, 220))
  await page.mouse.up()
  return { dragMs: Date.now() - t0, steps }
}

// ── P9：CAS2 统一认证（纯 HTTP，不开浏览器）──────────────────────────────────
// 为什么不复用滑块那套浏览器：CAS 是 Vue 单页 + 图片验证码（前 3 次免），没有滑块，
// 纯表单 POST 就能拿到 302 + ticket；开 Playwright 反而慢 30 倍还占内存。

// fetch 自己不管 cookie（每次重定向都是裸请求），CAS 的 SESSION/TGC/票据全靠它，所以自己拿。
class CookieJar {
  constructor() { this.map = new Map() }
  absorb(res) {
    let list = []
    if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie()
    else {
      const raw = res.headers.get('set-cookie')
      if (raw) list = raw.split(/,(?=\s*[^;,=]+=)/)
    }
    for (const sc of list) {
      const first = String(sc).split(';')[0]
      const i = first.indexOf('=')
      if (i <= 0) continue
      const k = first.slice(0, i).trim()
      const v = first.slice(i + 1).trim()
      if (!k) continue
      if (v === '' || /expires=Thu, 01 Jan 1970/i.test(sc)) this.map.delete(k)
      else this.map.set(k, v)
    }
    return this
  }
  header() { return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ') }
  toArray() {
    return [...this.map.entries()].map(([name, value]) => ({ name, value, path: '/', domain: null, httpOnly: false, secure: false, expires: null }))
  }
  keys() { return [...this.map.keys()] }
}

const EXECUTION_RE = /name=["']execution["']\s+value=["']([^"']+)["']/i

// 从 CAS 登录页抽一次性 execution 令牌（真页里约 12.5KB 的 JWT 串）
function parseExecution(html) {
  const m = EXECUTION_RE.exec(String(html || ''))
  return m ? m[1] : ''
}

function casError(msg, code, extra) {
  const e = new Error(msg)
  e.code = code
  if (extra) Object.assign(e, extra)
  return e
}

// 手动跟随重定向：一步一步走，每一跳都把 Set-Cookie 收进 jar、下一跳带上。
async function casFetch(url, { method = 'GET', body, headers = {}, jar, maxHops = 12 } = {}) {
  let cur = url
  const hops = []
  for (let i = 0; i < maxHops; i++) {
    const h = { 'User-Agent': CAS_UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...headers }
    const ck = jar.header()
    if (ck) h.cookie = ck
    let res
    try {
      res = await fetch(cur, {
        method: i === 0 ? method : 'GET',
        body: i === 0 ? body : undefined,
        headers: h,
        redirect: 'manual',
        signal: AbortSignal.timeout(CAS_TIMEOUT_MS),
      })
    } catch (e) {
      throw casError('CAS/CAS 下游站点打不开：' + e.message, 'CAS_UNREACHABLE', { atUrl: cur })
    }
    jar.absorb(res)
    const loc = res.headers.get('location')
    hops.push({ status: res.status, url: cur.replace(/ticket=[^&]+/, 'ticket=<hidden>') })
    if (res.status >= 300 && res.status < 400 && loc) {
      cur = new URL(loc, cur).toString()
      continue
    }
    const text = await res.text().catch(() => '')
    return { res, status: res.status, url: cur, text, hops }
  }
  throw casError('CAS 重定向次数过多（>' + maxHops + '）', 'CAS_TOO_MANY_REDIRECTS', { hops })
}

// 口令按 CAS 页面 JS 的规矩加密：RSA-2048 PKCS1v15 + base64 + 前缀 __RSA__
// （页面守卫：encryptEnabled && password.indexOf('__RSA__') < 0 就直接拦下）
function rsaEncryptPassword(password, pem) {
  const key = String(pem || '').replace(/^\uFEFF/, '').replace(/^\s+/, '').trim()
  if (!/BEGIN PUBLIC KEY/.test(key)) throw casError('CAS 公钥格式不认识', 'CAS_BAD_PUBKEY')
  let buf
  try {
    buf = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(String(password), 'utf8'))
  } catch (e) {
    throw casError('口令加密失败：' + e.message, 'CAS_BAD_PUBKEY')
  }
  return '__RSA__' + buf.toString('base64')
}

/**
 * 走 CAS2 统一认证，换到 service 的会话 cookie。
 * @param {{studentId:string, password:string, service?:string}} opts
 * @returns {Promise<{cookies:Array, stats:object}>}
 */
async function loginForCookiesCas({ studentId, password, service = CAS_JWXT_SSO }) {
  if (!studentId || !/^\d{8,14}$/.test(String(studentId))) {
    const e = new Error('学号格式不正确'); e.code = 'JWXT_BAD_STUDENT_ID'; throw e
  }
  if (!password || String(password).length < 4) {
    const e = new Error('密码为空或过短'); e.code = 'JWXT_BAD_PASSWORD'; throw e
  }
  const t0 = Date.now()
  const jar = new CookieJar()
  const stats = {
    authMode: 'cas', service,
    hops: [], gotExecution: false, execLen: 0, rsaMs: 0, postMs: 0,
    ticket: false, ticketLen: 0, finalUrl: '', cookies: [], totalMs: 0,
  }
  const loginUrl = CAS_BASE + '/cas/login?service=' + encodeURIComponent(service)

  // 1) 登录页 → execution
  const g = await casFetch(loginUrl, { jar })
  if (g.status !== 200) throw casError('CAS 登录页返回 ' + g.status, 'CAS_PAGE_FAIL', { status: g.status })
  if (/未注册|服务未授权|invalid service|Unregistered/i.test(g.text)) {
    throw casError('CAS 不认这个 service：' + service, 'CAS_SERVICE_NOT_REGISTERED', { service })
  }
  const execution = parseExecution(g.text)
  if (!execution) {
    throw casError('CAS 登录页抽不到 execution（页面结构可能变了）', 'CAS_NO_EXECUTION', { bytes: g.text.length })
  }
  stats.gotExecution = true
  stats.execLen = execution.length

  // 2) 公钥 → 加密口令
  const tk = Date.now()
  const pk = await casFetch(CAS_BASE + '/cas/jwt/publicKey', { jar })
  if (pk.status !== 200 || !/BEGIN PUBLIC KEY/.test(pk.text)) {
    throw casError('CAS 公钥接口异常（' + pk.status + '）', 'CAS_BAD_PUBKEY', { status: pk.status })
  }
  const encPwd = rsaEncryptPassword(password, pk.text)
  stats.rsaMs = Date.now() - tk
  stats.encLen = encPwd.length

  // 3) 提交（只发一次。口令一旦提交，绝不在这层重试。）
  const form = new URLSearchParams()
  form.set('username', String(studentId))
  form.set('password', encPwd)
  form.set('captcha', '')
  form.set('currentMenu', '1')
  form.set('failN', '-1')
  form.set('mfaState', '')
  form.set('execution', execution)
  form.set('_eventId', 'submit')
  form.set('submit', 'Login1')
  const tp = Date.now()
  const p = await casFetch(loginUrl, {
    method: 'POST',
    body: form.toString(),
    jar,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: loginUrl, Origin: CAS_BASE },
  })
  stats.postMs = Date.now() - tp
  stats.hops = p.hops.map((x) => x.status)
  stats.finalUrl = p.url.replace(/ticket=[^&]+/, 'ticket=<hidden>')

  const tm = /[?&]ticket=(ST-[^&]+)/.exec(p.url + ' ' + (p.text.match(/ticket=(ST-[^"'\s&]+)/) || [''])[0])
  if (tm) { stats.ticket = true; stats.ticketLen = tm[1].length }

  // 4) 判结果。还在 CAS 登录页 = 没成，要分清是「口令错」还是「要图片验证码」。
  if (/\/cas\/login/.test(p.url)) {
    const captchaNeeded =
      /captchaRequired["']?\s*[:=]\s*["']?true/i.test(p.text) ||
      /请输入图片验证码|screen\.captcha\.title/.test(p.text) && /您(的)?操作疑似异常|验证码错误/i.test(p.text)
    if (captchaNeeded) {
      throw casError('CAS 要求图片验证码（前 3 次免，已用完）', 'CAS_CAPTCHA_REQUIRED')
    }
    if (/密码错误|用户名或密码|账号或密码|不存在|被锁定|锁定/i.test(p.text)) {
      // 口令被拒：换成路由层认识的码，且绝不重试、绝不换通道
      const e = new Error('统一认证拒绝登录：账号或密码不正确')
      e.code = 'JWXT_LOGIN_REJECTED'
      throw e
    }
    throw casError('CAS 未跳转（票据未下发）', 'CAS_NO_TICKET', { status: p.status })
  }

  stats.cookies = jar.keys()
  stats.totalMs = Date.now() - t0
  stats.loginMs = stats.totalMs
  if (!stats.cookies.length) throw casError('CAS 走完了但一个 cookie 都没拿到', 'CAS_NO_COOKIE')
  return { cookies: jar.toArray(), stats }
}

// 老板 00:13 那条链接（service=portal）原样跑一遍：只用于诊断「CAS 本身通不通」。
// portal 会话不能拿去取正方课表，所以它不参与 loginForCookies 的返回。
async function loginForCookiesCasPortal({ studentId, password }) {
  return loginForCookiesCas({ studentId, password, service: CAS_SERVICE })
}

/**
 * 登录并返回 cookie 列表（不落盘）。
 * P9：默认先走 CAS（JWXT_AUTH_MODE=cas），CAS 不成且不是口令问题时自动落滑块兜底。
 * @param {{studentId:string, password:string, headed?:boolean, tries?:number}} opts
 * @returns {Promise<{cookies:Array, stats:object}>}
 */
async function loginForCookies({ studentId, password, headed = false, tries = 3 }) {
  if (AUTH_MODE === 'slider') {
    const r = await loginForCookiesSlider({ studentId, password, headed, tries })
    r.stats.authMode = 'slider'
    return r
  }
  try {
    return await loginForCookiesCas({ studentId, password })
  } catch (e) {
    const code = e.code || 'ERR'
    // 口令问题（学号/密码格式、统一认证拒登）：不许换通道重试，否则两边各记一次错密码 = 锁号
    if (/^JWXT_(BAD_STUDENT_ID|BAD_PASSWORD|LOGIN_REJECTED)$/.test(code) || code === 'CAS_LOGIN_REJECTED') throw e
    if (!CAS_FALLBACK) throw e
    console.warn('[jwxt] CAS 通道未通过（' + code + '），落滑块兜底：' + e.message)
    let r
    try {
      r = await loginForCookiesSlider({ studentId, password, headed, tries })
    } catch (e2) {
      // 两条通道都挂：把 CAS 的原因挂到滑块错误上，别让它把真正的首因吃掉
      e2.casError = code
      e2.casMessage = e.message
      throw e2
    }
    r.stats.authMode = 'slider_fallback'
    r.stats.casError = code
    r.stats.casMessage = e.message
    return r
  }
}

async function loginForCookiesSlider({ studentId, password, headed = false, tries = 3 }) {
  if (!studentId || !/^\d{8,14}$/.test(String(studentId))) {
    const e = new Error('学号格式不正确'); e.code = 'JWXT_BAD_STUDENT_ID'; throw e
  }
  if (!password || String(password).length < 4) {
    const e = new Error('密码为空或过短'); e.code = 'JWXT_BAD_PASSWORD'; throw e
  }
  const { chromium } = loadPlaywright()
  const tAll = Date.now()
  let browser
  try {
    browser = await chromium.launch({
      headless: !headed,
      args: ['--disable-blink-features=AutomationControlled', '--no-default-browser-check', '--no-sandbox'],
    })
  } catch (e) {
    const err = new Error('浏览器启动失败：' + e.message); err.code = 'JWXT_BROWSER_LAUNCH_FAIL'; throw err
  }
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: REAL_UA,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    deviceScaleFactor: 1,
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] })
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
  })
  const stats = { tries: [], totalMs: 0, submits: 0, authMode: 'slider' }
  try {
    for (let i = 1; i <= tries; i++) {
      const rec = { idx: i }
      const tRound = Date.now()
      const page = await ctx.newPage()
      const cap = { resps: [] }
      page.on('response', async (r) => {
        if (r.url().includes('zfcaptchaLogin')) {
          let body = ''
          try { body = (await r.text()).slice(0, 120) } catch (e) { body = 'ERR' }
          cap.resps.push({ status: r.status(), body })
        }
      })
      try {
        try {
          await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
        } catch (e) {
          const err = new Error('教务站点打不开：' + e.message); err.code = 'JWXT_SITE_UNREACHABLE'; throw err
        }
        try {
          await page.waitForFunction(() => {
            const b = document.querySelector('.zfdun_slider_bar_btn')
            const im = document.querySelector('.zfdun_bgimg_img')
            const j = document.querySelector('.zfdun_bgimg_jigsaw')
            return document.readyState === 'complete' && b && im && im.naturalWidth > 0 && j
          }, { timeout: 20000 })
        } catch (e) {
          const err = new Error('登录页滑块组件未渲染'); err.code = 'JWXT_PAGE_NOT_READY'; throw err
        }
        const imgs = await page.evaluate(() => {
          const grab = (sel) => {
            const el = document.querySelector(sel)
            if (!el || !el.naturalWidth) return null
            const c = document.createElement('canvas')
            c.width = el.naturalWidth; c.height = el.naturalHeight
            c.getContext('2d').drawImage(el, 0, 0)
            return c.toDataURL('image/png').split(',')[1]
          }
          return { bg: grab('.zfdun_bgimg_img'), jg: grab('.zfdun_bgimg_jigsaw') }
        })
        if (!imgs.bg || !imgs.jg) { const err = new Error('取不到滑块图片'); err.code = 'JWXT_NO_IMG'; throw err }
        const g = detectGap(Buffer.from(imgs.bg, 'base64'), Buffer.from(imgs.jg, 'base64'))
        rec.gap = g.gap; rec.gapScore = g.score
        const geo = await page.evaluate(() => {
          const b = document.querySelector('.zfdun_slider_bar_btn')
          b.scrollIntoView({ block: 'center', inline: 'center' })
          const bg = document.querySelector('.zfdun_bgimg_img')
          const br = bg.getBoundingClientRect()
          const r = b.getBoundingClientRect()
          const x = r.x + r.width / 2, y = r.y + r.height / 2
          const hit = document.elementFromPoint(x, y)
          return { x, y, scale: bg.naturalWidth ? br.width / bg.naturalWidth : 1, isBtn: hit ? b.contains(hit) : false }
        })
        if (!geo.isBtn) { const err = new Error('滑块按钮不在可视区'); err.code = 'JWXT_BTN_OFFSCREEN'; throw err }
        const d = await drag(page, geo.x, geo.y, Math.max(1, Math.round(g.gap * (geo.scale || 1))))
        rec.dragMs = d.dragMs; rec.steps = d.steps; rec.dist = Math.round(g.gap * (geo.scale || 1))
        const tw = Date.now()
        while (Date.now() - tw < 6000 && !cap.resps.length) await sleep(120)
        await sleep(250)
        const icon = await page.evaluate(() => {
          const i = document.querySelector('.zfdun_slider_icon')
          const b = document.querySelector('.zfdun_slider_bar p')
          return { cls: i ? i.className : '?', bar: b ? b.innerText.trim() : '' }
        })
        rec.verify = icon.bar || (cap.resps[0] && cap.resps[0].body) || ''
        const okVerify = /success/i.test(icon.cls) || (cap.resps[0] && /"status":"success"/.test(cap.resps[0].body || ''))
        if (!okVerify) { stats.tries.push(rec); const err = new Error('滑块未通过：' + rec.verify); err.code = 'JWXT_SLIDER_FAIL'; throw err }

        // 计数：走到这里一定要把口令填进表单并点 #dl，这就是「一次真实登录尝试」。
        // 它只用来证明「密码错只试一次」，不进响应体、不含任何口令内容。
        stats.submits++
        rec.submit = stats.submits
        rec.preMs = Date.now() - tRound // 提交前（开浏览器+开页面+过滑块）花了多久
        const tLogin = Date.now()
        await page.fill('#yhm', String(studentId))
        await page.fill('#mm', String(password))
        // 2026-10-26 P7：原来先 Promise.all 干等 waitForURL 25s，再进 60×400ms 轮询，
        // 密码错也要 29.7s 才回。现在：点完就每 250ms 同时看 URL 和 #tips，
        // 教务的「用户名或密码不正确」一出现立刻抛；总窗口硬顶 8s。
        const navP = page.waitForURL(LOGIN_OK_URL, { timeout: LOGIN_WAIT_MS }).catch(() => null)
        await page.click('#dl')
        let logged = false
        for (;;) {
          if (LOGIN_OK_URL.test(page.url())) { logged = true; break }
          const tip = await page.evaluate(() => {
            const e = document.querySelector('#tips, .alert-danger, #showErrorTip')
            return e ? e.innerText.trim().slice(0, 120) : ''
          }).catch(() => '')
          if (tip && /错误|失败|不正确|验证/.test(tip)) {
            rec.waitMs = Date.now() - tLogin // 点#dl之后等教务回提示花了多久
            rec.tip = tip
            stats.tries.push(rec)
            const err = new Error('教务拒绝登录：' + tip); err.code = 'JWXT_LOGIN_REJECTED'; throw err
          }
          const left = LOGIN_WAIT_MS - (Date.now() - tLogin)
          if (left <= 0) break
          await sleep(Math.min(LOGIN_POLL_MS, left))
        }
        await navP
        rec.waitMs = Date.now() - tLogin
        rec.loginMs = Date.now() - tLogin
        if (!logged) {
          stats.tries.push(rec)
          const err = new Error('登录后未跳转（超时）'); err.code = 'JWXT_LOGIN_TIMEOUT'; throw err
        }
        stats.tries.push(rec)
        const cookies = (await ctx.cookies()).map((c) => ({
          name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
          httpOnly: !!c.httpOnly, secure: !!c.secure,
          expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : null,
        }))
        stats.totalMs = Date.now() - tAll
        stats.loginMs = rec.loginMs
        stats.sliderMs = rec.dragMs
        return { cookies, stats }
      } catch (e) {
        const code = e.code || 'ERR'
        rec.error = code
        if (!stats.tries.includes(rec)) stats.tries.push(rec)
        e.loginStats = stats // 诊断用：失败时也能拿到每次尝试的 gap/steps/阶段（不用于响应体）
        const canRetry = RETRYABLE.test(code) // 白名单外一律不重试（含 JWXT_LOGIN_REJECTED 密码错）
        if (!canRetry || i >= tries) {
          // 口令已经提交过就必须留下「只试了几次」的痕迹，方便事后核对有没有被重试放大
          if (stats.submits > 0) {
            const ms = []
            if (rec.preMs) ms.push(`提交前${rec.preMs}ms`)
            if (rec.waitMs) ms.push(`等提示${rec.waitMs}ms`)
            console.warn(`[jwxt] 不重试 ${code}：本次真实提交口令 ${stats.submits} 次（第 ${i} 轮，上限 ${tries} 轮）${ms.length ? '，' + ms.join('+') : ''}`)
          }
          throw e
        }
        // 只有滑块/页面类（口令还没提交）才走到这里：打日志、清 cookie、歇一下再来一轮
        if (SLIDER_LIKE.test(code)) {
          console.warn(`[jwxt] 第 ${i} 轮滑块失败（${code}），重试第 ${i + 1} 轮`)
        }
        await ctx.clearCookies().catch(() => { })
        await sleep(rnd(1200, 2400))
      } finally {
        await page.close().catch(() => { })
      }
    }
    const err = new Error('登录未成功'); err.code = 'JWXT_LOGIN_FAILED'; throw err
  } finally {
    await browser.close().catch(() => { })
  }
}

module.exports = {
  loginForCookies,
  loginForCookiesSlider,
  loginForCookiesCas,
  loginForCookiesCasPortal,
  detectGap,
  parseExecution,
  rsaEncryptPassword,
  // 供路由层把「这次走的是哪条通道」透出来，方便端上和老板核对
  authConfig: () => ({ mode: AUTH_MODE, casFallback: CAS_FALLBACK, casBase: CAS_BASE, casService: CAS_SERVICE, casJwxtSso: CAS_JWXT_SSO }),
}
