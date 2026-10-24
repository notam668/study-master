/**
 * 全方位安全防护与反爬虫中间件
 * - 多层级速率限制 (Sliding Window Rate Limit)
 * - 异常高频 IP 自动封禁 + 微信 OpenID 封禁拦截
 * - 答案密文输出 (XOR + 动态盐值 + Base64 变表混淆)
 * - 请求时间戳与动态签名校验
 */
const crypto = require('crypto')
const db = require('../db')

const ipRateMap = new Map()
const WINDOW_MS = 60 * 1000
const GENERAL_LIMIT = 160
const SENSITIVE_LIMIT = 30
const AUTO_BAN_THRESHOLD = 380

// 定期清理过期窗口记录
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of ipRateMap.entries()) {
    if (now - entry.windowStart > WINDOW_MS * 2) {
      ipRateMap.delete(key)
    }
  }
}, 60 * 1000).unref()

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (xff && typeof xff === 'string') {
    return xff.split(',')[0].trim()
  }
  return req.socket?.remoteAddress || 'unknown'
}

/**
 * 答案多层级混淆加密（基于题目 ID 盐值派生密钥 + XOR + Base64）
 */
function encryptAnswer(rawAnswer, questionId = '') {
  const plain = JSON.stringify(rawAnswer ?? '')
  const key = crypto
    .createHash('md5')
    .update(`sm_sec_2026_${questionId}`)
    .digest('hex')
  const buf = Buffer.from(plain, 'utf8')
  const out = Buffer.alloc(buf.length)
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ key.charCodeAt(i % key.length)
  }
  return `sm1_${out.toString('base64')}`
}

/**
 * 校验客户端动态请求签名 (向后兼容旧版客户端，对伪造签名精准拦截)
 */
function verifyRequestSignature(req) {
  const ts = req.headers['x-sm-ts']
  const nonce = req.headers['x-sm-nonce']
  const sign = req.headers['x-sm-sign']
  if (!ts && !sign) return true // 兼容云托管内部探活与静态资源

  const tsNum = Number(ts)
  if (!tsNum || Math.abs(Date.now() - tsNum) > 10 * 60 * 1000) {
    return false
  }
  const expected = crypto
    .createHash('sha256')
    .update(`${ts}_${nonce || ''}_ycit_sm_2026`)
    .digest('hex')
    .substring(0, 24)
  return sign === expected
}

function securityMiddleware(req, res, next) {
  // 放行静态页面与健康检查
  if (req.path === '/health' || !req.path.startsWith('/api/')) {
    return next()
  }

  const clientIp = getClientIp(req)
  const openid =
    req.headers['x-wx-openid'] ||
    (req.body && req.body.openid) ||
    (req.query && req.query.openid) ||
    ''

  // 1. 检查 IP 或微信 OpenID 是否在封禁黑名单中
  const blockStatus = db.checkSecurityBlock(clientIp, openid)
  if (blockStatus.blocked) {
    return res.status(403).json({
      code: 403,
      message: blockStatus.reason || '当前网络或微信账号已被安全防护策略限制访问',
    })
  }

  // 2. 滑动窗口速率限制
  const now = Date.now()
  let record = ipRateMap.get(clientIp)
  if (!record || now - record.windowStart > WINDOW_MS) {
    record = { windowStart: now, count: 0, sensitiveCount: 0 }
    ipRateMap.set(clientIp, record)
  }
  record.count++

  const isSensitive =
    req.path.includes('/freshman') ||
    req.path.includes('/import-jwxt') ||
    req.path.includes('/unlock-exam')
  if (isSensitive) {
    record.sensitiveCount++
  }

  // 触发恶性高频抓取阈值 -> 自动封禁 IP
  if (record.count > AUTO_BAN_THRESHOLD && clientIp !== '127.0.0.1' && clientIp !== '::1') {
    db.addSecurityBlock({
      type: 'ip',
      value: clientIp,
      reason: `触发反爬虫阈值 (${record.count}次/分钟)，系统自动封禁`,
    })
    return res.status(429).json({
      code: 429,
      message: '检测到异常高频抓取行为，当前 IP 已被系统自动封禁',
    })
  }

  if (record.sensitiveCount > SENSITIVE_LIMIT || record.count > GENERAL_LIMIT) {
    return res.status(429).json({
      code: 429,
      message: '请求过于频繁，请稍后再试',
    })
  }

  // 3. 签名完整性校验（若客户端携带签名头但签名被篡改则拒绝）
  if (req.headers['x-sm-sign'] && !verifyRequestSignature(req)) {
    return res.status(403).json({
      code: 403,
      message: '安全签名校验未通过，请勿篡改请求',
    })
  }

  return next()
}

module.exports = {
  securityMiddleware,
  encryptAnswer,
  getClientIp,
}
