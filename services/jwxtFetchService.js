/**
 * 拿现成会话 cookie 用纯 HTTP 取课表（不启浏览器、不渲染页面）。
 * 端点：POST https://jwglxt.ycit.edu.cn/kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151
 * body：xnm=<学年>&xqm=<学期>
 *
 * 2026-10-26 本机实测：26 条，619–830ms（node fetch / Playwright APIRequestContext 均同量级）。
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0'
const BASE = 'https://jwglxt.ycit.edu.cn'
const KB_URL = BASE + '/kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151'

function classify(resp, body) {
  if (!resp || resp.status !== 200) return 'HTTP_' + (resp ? resp.status : 'NO_RESPONSE')
  const head = String(body || '').slice(0, 400)
  if (/<html|<!DOCTYPE/i.test(head)) return 'SESSION_EXPIRED_HTML'
  try {
    const j = JSON.parse(body)
    if (j && (Array.isArray(j.kbList) || j.xsxx)) return 'OK'
    return 'JSON_NO_KBLIST'
  } catch (e) {
    return 'JSON_PARSE_FAIL'
  }
}

/**
 * @param {{cookieHeader:string, xnm?:string, xqm?:string}} opts
 */
async function fetchTimetable({ cookieHeader, xnm = '2026', xqm = '3', timeoutMs = 30000 }) {
  if (!cookieHeader) {
    const e = new Error('没有可用会话'); e.code = 'JWXT_NO_SESSION'; throw e
  }
  const t0 = Date.now()
  let resp = null
  let body = ''
  try {
    resp = await fetch(KB_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Cookie: cookieHeader,
        'X-Requested-With': 'XMLHttpRequest',
        Referer: KB_URL,
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
      body: `xnm=${encodeURIComponent(xnm)}&xqm=${encodeURIComponent(xqm)}`,
      signal: AbortSignal.timeout(timeoutMs),
    })
    body = await resp.text()
  } catch (e) {
    const err = new Error('取课表网络失败：' + e.message)
    err.code = 'JWXT_NETWORK_FAIL'
    err.ms = Date.now() - t0
    throw err
  }
  const ms = Date.now() - t0
  const verdict = classify(resp, body)
  let parsed = null
  if (verdict === 'OK') {
    try { parsed = JSON.parse(body) } catch (e) { parsed = null }
  }
  const kbList = (parsed && (parsed.kbList || parsed.sjkList)) || []
  return {
    http: resp.status,
    ms,
    bytes: body.length,
    verdict,
    rows: kbList.length,
    kbList,
    sjkList: (parsed && parsed.sjkList) || [],
    xsxx: (parsed && parsed.xsxx) || null,
    term: { xnm, xqm },
    raw: body,
  }
}

module.exports = { fetchTimetable, KB_URL, classify }
