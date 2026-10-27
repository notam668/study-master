const jwt = require('jsonwebtoken')
const config = require('../config')
const db = require('../db')

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'] || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader
  const headerOpenid = req.headers['x-wx-openid'] || (req.body && req.body.openid)

  // 1. 优先通过 Token 校验 JWT
  if (token) {
    try {
      const decoded = jwt.verify(token, config.jwtSecret)
      const user = db.getUserById(decoded.userId) || (decoded.openid ? db.getUserByOpenid(decoded.openid) : null)
      if (user) {
        req.user = user
        return next()
      }
    } catch (err) {
      // Token 过期或异常，尝试降级到 openid 判定
    }
  }

  // 2. 微信云托管原生 callContainer 会自动注入真实可信的 x-wx-openid
  if (headerOpenid) {
    let user = db.getUserByOpenid(headerOpenid)
    if (!user) {
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''
      const res = db.createOrUpdateUser(headerOpenid, {
        nickname: `微信用户_${headerOpenid.substring(Math.max(0, headerOpenid.length - 4))}`,
        ip: clientIp,
      })
      user = res.user
    }
    if (user) {
      req.user = user
      return next()
    }
  }

  if (!token && !headerOpenid) {
    return res.status(401).json({ code: 401, message: '请先登录授权' })
  }

  return res.status(401).json({ code: 401, message: '登录态已过期，请重新登录' })
}

// 可选认证（未登录也放行，但附加 user 对象）
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader
  const headerOpenid = req.headers['x-wx-openid'] || (req.body && req.body.openid)

  if (token) {
    try {
      const decoded = jwt.verify(token, config.jwtSecret)
      const user = db.getUserById(decoded.userId) || (decoded.openid ? db.getUserByOpenid(decoded.openid) : null)
      if (user) req.user = user
    } catch {
      // 忽略错误
    }
  }

  if (!req.user && headerOpenid) {
    let user = db.getUserByOpenid(headerOpenid)
    if (!user) {
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''
      const res = db.createOrUpdateUser(headerOpenid, {
        nickname: `微信用户_${headerOpenid.substring(Math.max(0, headerOpenid.length - 4))}`,
        ip: clientIp,
      })
      user = res.user
    }
    if (user) req.user = user
  }

  next()
}

module.exports = {
  authMiddleware,
  optionalAuth,
}
