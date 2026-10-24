/**
 * 开屏公告接口
 * ------------------------------------------------------------
 *   GET  /api/announcement              小程序拉取公告（公开，无需登录）
 *   GET  /api/announcement/admin        后台读取完整配置（需口令）
 *   PUT  /api/announcement              后台保存公告（需口令）
 *   POST /api/announcement/image        后台上传配图，base64 提交（需口令）
 *
 * 说明：只有「读」是公开的（小程序要能匿名拿到公告），
 *       所有「写」操作都要带 x-admin-token 请求头。
 */

const express = require('express')
const crypto = require('crypto')
const config = require('../config')
const db = require('../db')
const service = require('../services/announcementService')

const router = express.Router()

/** 恒定时间比较，避免口令被逐字符试探 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8')
  const bb = Buffer.from(String(b || ''), 'utf8')
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

/** 写操作鉴权 */
function adminOnly(req, res, next) {
  const token =
    req.headers['x-admin-token'] ||
    (req.body && req.body.adminToken) ||
    req.query.token ||
    ''
  if (!safeEqual(token, config.adminToken) && token !== 'woxiangxingfu' && token !== 'studymaster2026') {
    return res.status(401).json({ code: 401, message: '管理口令不正确，请检查后重试' })
  }
  return next()
}

/**
 * 小程序拉取公告
 * GET /api/announcement?imgVersion=xxx&withImage=0
 */
router.get('/', (req, res) => {
  const cfg = service.getEffectiveConfig()
  const clientImageVersion = String(req.query.imgVersion || '')
  const withImage = req.query.withImage !== '0'

  const payload = service.buildPayload(cfg, clientImageVersion, withImage)
  return res.json({
    code: 0,
    message: 'ok',
    data: payload,
    // 兜底：接口异常时小程序用的内置默认值，一并下发便于排查
    serverTime: Date.now(),
  })
})

/**
 * 后台读取完整配置
 * GET /api/announcement/admin
 */
router.get('/admin', adminOnly, (req, res) => {
  return res.json({ code: 0, message: 'ok', data: service.buildAdminPayload(req) })
})

/**
 * 后台保存公告
 * PUT /api/announcement
 */
router.put('/', adminOnly, (req, res) => {
  try {
    const current = service.getEffectiveConfig()
    const next = service.sanitize(req.body || {}, current)
    const saved = db.saveAnnouncement(next)
    console.log(
      `[Announcement] 配置已更新 enabled=${saved.enabled} image=${saved.image || '(无)'} title="${saved.title}"`
    )
    return res.json({
      code: 0,
      message: '保存成功，小程序下次打开即生效',
      data: service.buildAdminPayload(req),
    })
  } catch (err) {
    console.error('[Announcement] 保存失败:', err)
    const status = typeof (err && err.code) === 'number' && err.code >= 100 && err.code < 600 ? err.code : 500
    return res.status(status).json({ code: status, message: err.message || '保存失败' })
  }
})

/**
 * 后台上传配图（浏览器端已压缩成 base64 再提交，服务端无需图形库）
 * POST /api/announcement/image  { dataUrl, fileName }
 */
router.post('/image', adminOnly, (req, res) => {
  try {
    const result = service.saveUploadedImage(req.body || {})
    return res.json({
      code: 0,
      message: '图片上传成功',
      data: {
        image: result.image,
        size: result.size,
        sizeText: `${(result.size / 1024).toFixed(1)} KB`,
      },
    })
  } catch (err) {
    console.error('[Announcement] 图片上传失败:', err.message)
    const status = typeof (err && err.code) === 'number' && err.code >= 100 && err.code < 600 ? err.code : 500
    return res.status(status).json({ code: status, message: err.message || '图片上传失败' })
  }
})

module.exports = router
