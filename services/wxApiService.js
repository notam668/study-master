/**
 * 微信小程序服务端接口封装
 * ------------------------------------------------------------
 * 目前服务于「上课提醒」的订阅消息下发，包含：
 *   1. getAccessToken()        —— 用 stable_token 拿全局凭证，内存 + 文件双缓存，失败自动重试
 *   2. getTemplateList()       —— 拉取小程序后台已添加的订阅消息模板，解析出可用字段
 *   3. sendSubscribeMessage()  —— 下发一条订阅消息
 *   4. getSubscribeCategory()  —— 查询账号可用的长期订阅类目（排查"为什么没有长期模板"）
 *
 * 两个关键工程点：
 *   · 微信 access_token 有 5 分钟生效延迟、且新 token 会顶掉老的，
 *     所以一律走 /cgi-bin/stable_token（微信官方给多实例/Serverless 场景用的接口），
 *     且缓存到 data 目录，容器重启后不必重新拉。
 *   · errcode 40001/40014/42001（token 失效）时强制刷新一次再重试，
 *     避免容器长时间空转后第一个请求必失败。
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const axios = require('axios')
const config = require('../config')

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
})

const TOKEN_CACHE_FILE = path.join(config.dataDir, 'wechat_token_cache.json')
const TOKEN_SAFETY_WINDOW_MS = 5 * 60 * 1000 // 提前 5 分钟视为过期

// 需要强制刷新 token 后重试的错误码
const TOKEN_ERROR_CODES = new Set([40001, 40014, 42001, 42007, 42009])

let memoryToken = null
let inflightToken = null

const WX_BASES = [
  'https://api2.weixin.qq.com',
  'https://api.weixin.qq.com',
]

function getApiBases() {
  if (config.wxApiBase) {
    const custom = String(config.wxApiBase).replace(/\/+$/, '')
    return [custom, ...WX_BASES.filter((b) => b !== custom)]
  }
  return WX_BASES
}

function assertCredentials() {
  if (!config.wxAppId || !config.wxAppSecret) {
    const err = new Error('服务端未配置 WX_APPID / WX_APPSECRET，无法调用微信接口')
    err.code = 500
    throw err
  }
}

function readTokenCacheFromDisk() {
  if (memoryToken) return memoryToken
  try {
    if (fs.existsSync(TOKEN_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8'))
      if (raw && raw.accessToken && raw.expiresAt) {
        memoryToken = raw
        return memoryToken
      }
    }
  } catch (err) {
    console.warn('[WxApi] 读取 token 缓存失败，忽略:', err.message)
  }
  return null
}

function writeTokenCacheToDisk(token) {
  memoryToken = token
  try {
    fs.writeFileSync(
      TOKEN_CACHE_FILE,
      JSON.stringify({ appid: config.wxAppId, ...token }),
      'utf8'
    )
  } catch (err) {
    console.warn('[WxApi] 写入 token 缓存失败，忽略:', err.message)
  }
}

/**
 * 统一发送微信接口网络请求（带容灾域名切换与详细错误抽取）
 */
async function requestWxEndpoint(method, apiPath, options = {}) {
  const bases = getApiBases()
  let lastErr = null

  for (let i = 0; i < bases.length; i++) {
    const base = bases[i]
    const fullUrl = `${base}${apiPath}`
    try {
      const res = await axios({
        method,
        url: fullUrl,
        params: options.params,
        data: options.data,
        timeout: options.timeout || 8000,
        httpsAgent,
      })
      return res.data || {}
    } catch (err) {
      lastErr = err
      const status = err.response ? err.response.status : (err.code || 'ERR')
      const respData = err.response && err.response.data
      const detail = respData ? (typeof respData === 'object' ? JSON.stringify(respData) : String(respData)) : err.message
      console.warn(`[WxApi] 请求 ${fullUrl} 异常 (${status}): ${detail}，尝试备用节点...`)
      if (i < bases.length - 1) {
        continue
      }
    }
  }

  // 如果所有域名均失败，包装可读的错误信息抛出
  const status = lastErr.response ? lastErr.response.status : 500
  const respData = lastErr.response && lastErr.response.data
  let detailMsg = lastErr.message
  if (respData) {
    if (typeof respData === 'object') {
      detailMsg = respData.errmsg ? `${respData.errcode || ''} ${respData.errmsg}` : JSON.stringify(respData)
    } else {
      detailMsg = String(respData)
    }
  }
  const customErr = new Error(`微信接口请求失败 (${status}): ${detailMsg}`)
  customErr.code = 500
  throw customErr
}

/**
 * 获取 access_token（带缓存与并发合流）
 * @param {boolean} force 强制刷新
 */
async function getAccessToken(force = false) {
  assertCredentials()

  const cached = readTokenCacheFromDisk()
  if (!force && cached && cached.expiresAt - Date.now() > TOKEN_SAFETY_WINDOW_MS) {
    return cached.accessToken
  }

  if (inflightToken) return inflightToken

  inflightToken = (async () => {
    const data = await requestWxEndpoint('POST', '/cgi-bin/stable_token', {
      data: {
        grant_type: 'client_credential',
        appid: config.wxAppId,
        secret: config.wxAppSecret,
        force_refresh: Boolean(force),
      },
      timeout: 8000,
    })

    if (!data.access_token) {
      const err = new Error(
        `获取微信 access_token 失败: ${data.errcode || '-'} ${data.errmsg || '未知错误'}`
      )
      err.code = 500
      err.wxCode = data.errcode
      throw err
    }
    const token = {
      accessToken: data.access_token,
      expiresAt: Date.now() + (Number(data.expires_in) || 7200) * 1000,
      fetchedAt: Date.now(),
    }
    writeTokenCacheToDisk(token)
    console.log('[WxApi] access_token 已刷新，有效期至', new Date(token.expiresAt).toISOString())
    return token.accessToken
  })()

  try {
    return await inflightToken
  } finally {
    inflightToken = null
  }
}

/**
 * 调用任意微信接口，遇到 token 失效自动刷新重试一次
 * @param {'GET'|'POST'} method
 * @param {string} apiPath 形如 /cgi-bin/message/subscribe/send
 * @param {object} options { params, data }
 */
async function callWx(method, apiPath, options = {}, retried = false) {
  assertCredentials()
  const token = await getAccessToken(retried)

  const body = await requestWxEndpoint(method, apiPath, {
    params: { access_token: token, ...(options.params || {}) },
    data: options.data,
    timeout: options.timeout || 8000,
  })

  if (body.errcode && TOKEN_ERROR_CODES.has(Number(body.errcode)) && !retried) {
    console.warn(`[WxApi] token 失效 (errcode=${body.errcode})，刷新后重试 ${apiPath}`)
    return callWx(method, apiPath, options, true)
  }
  return body
}

/**
 * 拉取小程序后台已添加的订阅消息模板，并解析出字段列表
 * 返回 [{ templateId, title, type, content, fields:[{ code, label, sample }] }]
 */
async function getTemplateList() {
  const body = await callWx('GET', '/wxaapi/newtmpl/gettemplate')
  if (body.errcode && Number(body.errcode) !== 0) {
    const err = new Error(`拉取模板失败: ${body.errcode} ${body.errmsg || ''}`)
    err.wxCode = body.errcode
    throw err
  }
  const list = Array.isArray(body.data) ? body.data : []
  return list.map((item) => ({
    templateId: item.priTmplId || item.templateId || '',
    title: item.title || '',
    type: Number(item.type),
    typeText: Number(item.type) === 2 ? '一次性订阅' : '长期订阅',
    content: item.content || '',
    example: item.example || '',
    fields: parseTemplateFields(item.content || '', item.keywordEnumValueList || []),
  }))
}

/**
 * 从模板 content 中解析字段，例如：
 *   "课程名称：{{thing1.DATA}}\n上课时间：{{time3.DATA}}"
 *   -> [{ code:'thing1', label:'课程名称', sample:'' }, { code:'time3', label:'上课时间' }]
 * 同时把 keywordEnumValueList 里的示例值挂上，方便后台展示。
 */
function parseTemplateFields(content, enumList) {
  const sampleMap = {}
  ;(enumList || []).forEach((e) => {
    if (e && e.keywordCode) sampleMap[e.keywordCode] = e.enumValue || ''
  })

  const fields = []
  const re = /\{\{\s*([a-zA-Z0-9_]+)\.DATA\s*\}\}/g
  const lines = String(content || '').split(/\r?\n/)
  lines.forEach((line) => {
    re.lastIndex = 0
    const match = re.exec(line)
    if (!match) return
    const code = match[1]
    // 字段名 = 冒号前面的文案；没有冒号就用 code
    const label = line.split(/[:：]/)[0].trim() || code
    fields.push({ code, label, sample: sampleMap[code] || '' })
  })
  return fields
}

/**
 * 下发一条订阅消息
 * @param {object} payload
 *   openid         接收者 openid
 *   templateId     模板 ID
 *   data           形如 { thing1: { value: '高等数学' }, time3: { value: '08:00' } }
 *   page           点击跳转的小程序页面
 *   miniprogramState formal | trial | developer
 *   lang           zh_CN
 * 返回 { ok:boolean, errcode, errmsg }
 */
async function sendSubscribeMessage(payload) {
  const { openid, templateId, data, page, miniprogramState, lang } = payload || {}
  if (!openid || !templateId) {
    return { ok: false, errcode: -1, errmsg: '缺少 openid 或 templateId' }
  }

  const body = await callWx('POST', '/cgi-bin/message/subscribe/send', {
    data: {
      touser: openid,
      template_id: templateId,
      page: page || undefined,
      miniprogram_state: miniprogramState || 'formal',
      lang: lang || 'zh_CN',
      data: data || {},
    },
  })

  const errcode = Number(body.errcode || 0)
  return {
    ok: errcode === 0,
    errcode,
    errmsg: body.errmsg || '',
    msgid: body.msgid || '',
  }
}

/**
 * 查询账号可用的长期订阅类目（用于排查"后台看不到长期模板"）
 */
async function getSubscribeCategory() {
  return callWx('GET', '/wxaapi/newtmpl/getcategory')
}

/**
 * 查询某个类目下的公共模板库
 * 接口名 getPubNewTemplatetitles；路径是 getpubtemplatetitles 而不是 getpubtemplates
 * （写成后者微信会返回 40066 invalid url）。
 * @param {number[]} categoryIds 类目 id 列表
 */
async function getPublicTemplates(categoryIds, start = 0, limit = 30) {
  return callWx('GET', '/wxaapi/newtmpl/getpubtemplatetitles', {
    // limit 上限是 30，超了会返回 200017
    params: { ids: (categoryIds || []).join(','), start, limit: Math.min(Math.max(limit, 1), 30) },
  })
}

/**
 * 查询某个公共模板的可用关键词（决定能显示哪些信息）
 */
async function getPublicTemplateKeywords(tid) {
  return callWx('GET', '/wxaapi/newtmpl/getpubtemplatekeywords', { params: { tid } })
}

/**
 * 在公共模板库里按关键词搜索（给后台"找不到模板就用这个"用）
 * 说明：只做只读查询，不会往账号里添加任何模板 —— 添加动作请在小程序后台完成。
 */
async function searchPublicTemplates(keyword = '上课', options = {}) {
  const maxCategories = Math.min(Math.max(Number(options.maxCategories) || 3, 1), 10)
  const maxDetail = Math.min(Math.max(Number(options.maxDetail) || 5, 0), 10)

  const catBody = await getSubscribeCategory()
  if (catBody.errcode && Number(catBody.errcode) !== 0) {
    const err = new Error(`读取小程序类目失败: ${catBody.errcode} ${catBody.errmsg || ''}`)
    err.wxCode = catBody.errcode
    throw err
  }
  const categories = (catBody.data || []).map((c) => ({ id: c.id, name: c.name }))
  if (categories.length === 0) {
    return { categories: [], matches: [], note: '该小程序还没有设置服务类目，请先到公众平台「设置 → 基本设置 → 服务类目」补充（教育类目才能申请长期订阅模板）' }
  }

  const kw = String(keyword || '').trim()
  const pool = []
  for (const cat of categories.slice(0, maxCategories)) {
    try {
      const body = await getPublicTemplates([cat.id])
      ;(body.data || []).forEach((t) => {
        pool.push({
          tid: t.tid,
          title: t.title,
          type: Number(t.type),
          typeText: Number(t.type) === 3 ? '长期订阅' : '一次性订阅',
          categoryId: t.categoryId || cat.id,
          categoryName: cat.name,
        })
      })
    } catch (err) {
      console.warn(`[WxApi] 读取类目 ${cat.id} 的公共模板失败:`, err.message)
    }
  }

  const filtered = kw ? pool.filter((t) => String(t.title || '').indexOf(kw) !== -1) : pool
  const matches = filtered.slice(0, maxDetail)

  for (const item of matches) {
    try {
      const body = await getPublicTemplateKeywords(item.tid)
      item.keywords = (body.data || []).map((k) => ({
        kid: k.kid,
        name: k.name,
        example: k.example || '',
        rule: k.rule || '',
      }))
    } catch (err) {
      item.keywords = []
      item.keywordError = err.message
    }
  }

  return {
    categories,
    matches,
    scanned: pool.length,
    note: matches.length
      ? '以上是微信公共模板库里的候选模板。请到公众平台用它「选用」并添加，然后回到本页点「读取微信模板」。'
      : `公共模板库里没搜到包含「${kw}」的模板，可换个关键词（如"课程""提醒""上课"）再试，或直接在公众平台手动搜索。`,
  }
}

/**
 * 只读的健康检查（给管理台用）：能拿到 token 就说明 AppID/Secret 配对了
 */
async function healthCheck() {
  try {
    await getAccessToken(true)
    return { ok: true, message: 'AppID / AppSecret 校验通过，微信接口可用' }
  } catch (err) {
    return { ok: false, message: err.message }
  }
}

let wxAnalyticsCache = null
let wxAnalyticsCachedAt = 0
const WX_ANALYTICS_TTL_MS = 10 * 60 * 1000 // 10 分钟缓存

function formatYmd(dateMs) {
  const d = new Date(dateMs + 8 * 3600 * 1000)
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

function formatDashDate(ymd) {
  const s = String(ymd || '')
  if (s.length === 8) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  }
  return s
}

function calcGrowthRate(curr, prev) {
  const c = Number(curr || 0)
  const p = Number(prev || 0)
  if (p <= 0) return c > 0 ? 100 : 0
  return Number((((c - p) / p) * 100).toFixed(2))
}

/**
 * 拉取微信小程序官方 DataCube 核心统计指标（累计用户数、昨日打开次数、DAU、新增用户及日环比）
 */
async function getWechatOfficialAnalytics(forceRefresh = false) {
  if (!forceRefresh && wxAnalyticsCache && Date.now() - wxAnalyticsCachedAt < WX_ANALYTICS_TTL_MS) {
    return wxAnalyticsCache
  }

  try {
    const nowMs = Date.now()
    const dailyRecords = []

    // 依次查询最近 1~4 天（微信官方每日数据通常在次日早上 8~9 点完成结算）
    for (let offset = 1; offset <= 4; offset++) {
      const ds = formatYmd(nowMs - offset * 86400 * 1000)
      const [summaryRes, visitRes] = await Promise.all([
        callWx('POST', '/datacube/getweanalysisappiddailysummarytrend', {
          data: { begin_date: ds, end_date: ds },
          timeout: 6000,
        }).catch(() => null),
        callWx('POST', '/datacube/getweanalysisappiddailyvisittrend', {
          data: { begin_date: ds, end_date: ds },
          timeout: 6000,
        }).catch(() => null),
      ])

      const sItem = summaryRes && Array.isArray(summaryRes.list) && summaryRes.list[0] ? summaryRes.list[0] : null
      const vItem = visitRes && Array.isArray(visitRes.list) && visitRes.list[0] ? visitRes.list[0] : null

      if (sItem || vItem) {
        dailyRecords.push({
          refDate: formatDashDate((sItem && sItem.ref_date) || (vItem && vItem.ref_date) || ds),
          rawDate: ds,
          visitTotal: Number((sItem && sItem.visit_total) || 0),
          sharePv: Number((sItem && sItem.share_pv) || 0),
          shareUv: Number((sItem && sItem.share_uv) || 0),
          sessionCnt: Number((vItem && vItem.session_cnt) || 0),
          visitPv: Number((vItem && vItem.visit_pv) || 0),
          visitUv: Number((vItem && vItem.visit_uv) || 0),
          visitUvNew: Number((vItem && vItem.visit_uv_new) || 0),
          stayTimeUv: Number((vItem && vItem.stay_time_uv) || 0),
          stayTimeSession: Number((vItem && vItem.stay_time_session) || 0),
          visitDepth: Number((vItem && vItem.visit_depth) || 0),
        })
      }

      if (dailyRecords.length >= 2 && offset >= 3) {
        break
      }
    }

    if (dailyRecords.length > 0) {
      const latest = dailyRecords[0]
      const prev = dailyRecords[1] || latest

      const result = {
        refDate: latest.refDate,
        prevDate: prev.refDate,
        visitTotal: latest.visitTotal,
        visitTotalDiff: latest.visitTotal - prev.visitTotal,
        visitTotalGrowthRate: calcGrowthRate(latest.visitTotal, prev.visitTotal),
        sessionCnt: latest.sessionCnt,
        prevSessionCnt: prev.sessionCnt,
        sessionCntGrowthRate: calcGrowthRate(latest.sessionCnt, prev.sessionCnt),
        visitPv: latest.visitPv,
        prevVisitPv: prev.visitPv,
        visitPvGrowthRate: calcGrowthRate(latest.visitPv, prev.visitPv),
        visitUv: latest.visitUv,
        prevVisitUv: prev.visitUv,
        visitUvGrowthRate: calcGrowthRate(latest.visitUv, prev.visitUv),
        visitUvNew: latest.visitUvNew,
        prevVisitUvNew: prev.visitUvNew,
        visitUvNewGrowthRate: calcGrowthRate(latest.visitUvNew, prev.visitUvNew),
        stayTimeUv: Math.round(latest.stayTimeUv || 0),
        stayTimeSession: Math.round(latest.stayTimeSession || 0),
        visitDepth: Number((latest.visitDepth || 0).toFixed(2)),
        sharePv: latest.sharePv,
        shareUv: latest.shareUv,
        recentDays: dailyRecords,
        updatedAt: Date.now(),
        source: 'wechat_datacube_live',
      }

      wxAnalyticsCache = result
      wxAnalyticsCachedAt = Date.now()
      return result
    }
  } catch (err) {
    console.warn('[WxApi] 拉取微信官方 DataCube 统计异常:', err.message)
  }

  return wxAnalyticsCache
}

module.exports = {
  callWx,
  getAccessToken,
  getTemplateList,
  parseTemplateFields,
  sendSubscribeMessage,
  getSubscribeCategory,
  getPublicTemplates,
  getPublicTemplateKeywords,
  searchPublicTemplates,
  healthCheck,
  getWechatOfficialAnalytics,
  TOKEN_ERROR_CODES,
}
