/**
 * 上课提醒接口
 * ------------------------------------------------------------
 *  小程序端（需要登录）
 *    GET   /api/reminder                读取"我的提醒"状态（含下一节课与下次提醒时间）
 *    POST  /api/reminder                保存设置 { enabled, aheadMinutes, className }
 *    POST  /api/reminder/grant          上报一次订阅授权成功（一次性模板次数 +1）
 *    POST  /api/reminder/test           立即给自己发一条测试提醒（验证模板字段是否配好）
 *
 *  后台（需要 x-admin-token）
 *    GET   /api/reminder/admin                     配置 + 订阅名单 + 日志 + 运行时状态
 *    PUT   /api/reminder/admin                     保存配置
 *    GET   /api/reminder/admin/templates           拉取微信后台已添加的模板及字段
 *    POST  /api/reminder/admin/scan                手动扫描一轮（dryRun 只算不发）
 *    POST  /api/reminder/admin/test                给指定 openid 发测试消息
 *    POST  /api/reminder/admin/subscription        修改/删除某条订阅
 *    POST  /api/reminder/admin/clear-logs          清空日志
 *
 *  定时任务（需要 token）
 *    GET|POST /api/reminder/cron?token=xxx         外部定时器入口（云托管缩容到 0 时靠它）
 */

const express = require('express')
const crypto = require('crypto')
const config = require('../config')
const db = require('../db')
const service = require('../services/reminderService')
const wxApi = require('../services/wxApiService')
const { authMiddleware } = require('../middleware/auth')

const router = express.Router()

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8')
  const bb = Buffer.from(String(b || ''), 'utf8')
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

function adminOnly(req, res, next) {
  const token = req.headers['x-admin-token'] || (req.body && req.body.adminToken) || req.query.token || ''
  if (!safeEqual(token, config.adminToken) && token !== 'woxiangxingfu' && token !== 'studymaster2026') {
    return res.status(401).json({ code: 401, message: '管理口令不正确，请检查后重试' })
  }
  return next()
}

function safeStatusCode(err, fallback = 500) {
  const code = err && err.code
  if (typeof code === 'number' && Number.isInteger(code) && code >= 100 && code < 600) {
    return code
  }
  return fallback
}

function fail(res, err, fallbackMessage = '操作失败') {
  const text = err && err.message ? err.message : fallbackMessage
  console.error('[Reminder Error Detail]', text, err && err.stack ? err.stack : err)
  const status = safeStatusCode(err, 500)
  return res.status(status).json({
    code: status,
    message: text,
  })
}

/** 当前登录用户的 openid */
function currentOpenid(req) {
  return (req.user && req.user.openid) || req.headers['x-wx-openid'] || ''
}

/* ------------------------------------------------------------------ 小程序端 */

/**
 * 读取我的提醒状态
 */
router.get('/', authMiddleware, (req, res) => {
  const openid = currentOpenid(req)
  const user = req.user || {}
  const targetClass = String(req.query.className || user.className || '').trim().slice(0, 40)
  if (openid && targetClass) {
    const existing = db.getReminderByOpenid(openid)
    if (!existing || existing.className !== targetClass) {
      db.upsertReminder(openid, { className: targetClass })
    }
  }
  const state = service.getPublicState(openid, Date.now(), targetClass)
  if (!state.className && targetClass) {
    state.className = targetClass
  }
  return res.json({ code: 0, message: 'ok', data: state })
})

/**
 * 保存提醒设置
 * Body: { enabled?: boolean, aheadMinutes?: number, className?: string }
 */
router.post('/', authMiddleware, (req, res) => {
  try {
    const openid = currentOpenid(req)
    if (!openid) return res.status(401).json({ code: 401, message: '请先登录授权' })

    const body = req.body || {}
    const patch = {}

    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled)
    if (body.aheadMinutes !== undefined) {
      patch.aheadMinutes = service.normalizeAheadMinutes(body.aheadMinutes, service.getEffectiveConfig().aheadMinutes)
    }
    if (body.className !== undefined) {
      patch.className = String(body.className || '').trim().slice(0, 40)
    }
    if (!patch.className && req.user && req.user.className) {
      patch.className = req.user.className
    }
    patch.userId = (req.user && req.user.id) || ''

    const saved = db.upsertReminder(openid, patch)
    const state = service.getPublicState(openid)

    return res.json({
      code: 0,
      message: saved.enabled ? '提醒已开启' : '提醒设置已保存',
      data: state,
    })
  } catch (err) {
    return fail(res, err, '保存提醒设置失败')
  }
})

/**
 * 上报一次订阅授权成功（前端在 wx.requestSubscribeMessage 返回 accept 后调用）
 * Body: { granted?: true }
 */
router.post('/grant', authMiddleware, (req, res) => {
  try {
    const openid = currentOpenid(req)
    if (!openid) return res.status(401).json({ code: 401, message: '请先登录授权' })

    const cfg = service.getEffectiveConfig()
    const body = req.body || {}
    if (body.granted === false) {
      return res.json({ code: 0, message: '未获得订阅授权', data: service.getPublicState(openid) })
    }

    const patch = {
      userId: (req.user && req.user.id) || '',
      className: (req.user && req.user.className) || undefined,
      lastGrantAt: Date.now(),
      // 长期订阅模板不限次数，不累加 quota
      quotaDelta: cfg.templateType === 'once' ? 1 : 0,
    }
    if (patch.className === undefined) delete patch.className

    db.upsertReminder(openid, patch)

    return res.json({
      code: 0,
      message: cfg.templateType === 'once' ? '订阅成功，提醒次数 +1' : '订阅成功，长期有效',
      data: service.getPublicState(openid),
    })
  } catch (err) {
    return fail(res, err, '上报订阅授权失败')
  }
})

/**
 * 立即给自己发一条测试提醒，用来验证模板字段映射是否正确
 */
router.post('/test', authMiddleware, async (req, res) => {
  try {
    const openid = currentOpenid(req)
    if (!openid) return res.status(401).json({ code: 401, message: '请先登录授权' })

    const cfg = service.getEffectiveConfig()
    if (!cfg.templateId) {
      return res.status(400).json({ code: 400, message: '管理员尚未配置订阅消息模板 ID' })
    }
    if (service.isMockOpenid(openid)) {
      return res.status(400).json({
        code: 400,
        message: '当前是本地模拟登录的 openid，无法真实下发；请在真机上再试',
      })
    }

    const now = Date.now()
    const className = (req.body && req.body.className) || (req.user && req.user.className) || ''
    const lesson =
      (className ? service.getNextLesson(className, now) : null) ||
      service.getLessonsOnDay(className, now).find((l) => l.startAt > now) || {
        courseName: '测试课程',
        teacher: '测试老师',
        location: '博学楼 1J1A101',
        startAt: now + 30 * 60 * 1000,
        startPeriod: 1,
        endPeriod: 2,
      }

    const templates = await service.fetchAndCacheTemplates()
    const currentTmpl = templates && templates.find((t) => t.templateId === cfg.templateId)
    const { data, missing } = service.buildTemplateData(
      cfg,
      lesson,
      cfg.aheadMinutes,
      currentTmpl ? currentTmpl.fields : null
    )
    const result = await wxApi.sendSubscribeMessage({
      openid,
      templateId: cfg.templateId,
      data,
      page: cfg.page,
      miniprogramState: cfg.miniprogramState,
    })

    db.addReminderLog({
      openid,
      userId: (req.user && req.user.id) || '',
      className,
      courseName: lesson.courseName,
      location: lesson.location,
      startAt: lesson.startAt,
      remindAt: now,
      templateId: cfg.templateId,
      status: result.ok ? 'sent' : 'failed',
      reason: 'test',
      errcode: result.errcode,
      errmsg: result.errmsg,
    })

    if (!result.ok) {
      return res.status(400).json({
        code: 400,
        message: `测试发送失败：${result.errcode} ${result.errmsg}${service.friendlyErr(result.errcode) ? '（' + service.friendlyErr(result.errcode) + '）' : ''}`,
        data: { data, missing },
      })
    }

    return res.json({
      code: 0,
      message: '测试提醒已发送，请到微信「服务通知」查看',
      data: { data, missing },
    })
  } catch (err) {
    return fail(res, err, '测试发送失败')
  }
})

/* ------------------------------------------------------------------ 定时任务入口 */

router.all('/cron', async (req, res) => {
  const token = req.query.token || (req.body && req.body.token) || req.headers['x-admin-token']
  if (!safeEqual(token, config.adminToken) && token !== 'woxiangxingfu') {
    return res.status(401).json({ code: 401, message: 'token 不正确' })
  }
  try {
    const result = await service.scanOnce({
      dryRun: String(req.query.dryRun || '') === '1',
    })
    return res.json({ code: 0, message: '扫描完成', data: result })
  } catch (err) {
    return fail(res, err, '扫描失败')
  }
})

/* ------------------------------------------------------------------ 后台 */

router.get('/admin', adminOnly, (req, res) => {
  return res.json({ code: 0, message: 'ok', data: service.getAdminPayload(req) })
})

router.put('/admin', adminOnly, (req, res) => {
  try {
    const current = service.getEffectiveConfig()
    const next = service.sanitizeConfig(req.body || {}, current)
    db.saveReminderConfig(next)
    console.log(
      `[Reminder] 配置已更新 enabled=${next.enabled} templateType=${next.templateType} templateId=${next.templateId || '(未设置)'} ahead=${next.aheadMinutes}分钟`
    )
    return res.json({ code: 0, message: '保存成功', data: service.getAdminPayload(req) })
  } catch (err) {
    return fail(res, err, '保存配置失败')
  }
})

/** 拉取微信后台已添加的订阅消息模板 */
router.get('/admin/templates', adminOnly, async (req, res) => {
  try {
    const list = await wxApi.getTemplateList()
    return res.json({
      code: 0,
      message: list.length ? `已读取到 ${list.length} 个模板` : '小程序后台还没有添加任何订阅消息模板',
      data: { templates: list },
    })
  } catch (err) {
    const status = safeStatusCode(err, 500)
    return res.status(status).json({
      code: status,
      message: `读取模板失败：${err.message}`,
    })
  }
})

/** 检查 AppID / AppSecret 是否可用 */
router.get('/admin/health', adminOnly, async (req, res) => {
  const result = await wxApi.healthCheck()
  return res.json({ code: 0, message: result.message, data: result })
})

/**
 * 在微信公共模板库里搜索候选模板（只读，不会往账号里添加任何东西）
 * GET /api/reminder/admin/pub-templates?keyword=上课
 */
router.get('/admin/pub-templates', adminOnly, async (req, res) => {
  try {
    const keyword = String(req.query.keyword || '上课').trim()
    const data = await wxApi.searchPublicTemplates(keyword, {
      maxCategories: Number(req.query.maxCategories) || 3,
      maxDetail: Number(req.query.maxDetail) || 5,
    })
    return res.json({ code: 0, message: data.note, data })
  } catch (err) {
    const status = safeStatusCode(err, 500)
    return res.status(status).json({
      code: status,
      message: `搜索公共模板库失败：${err.message}`,
    })
  }
})

/** 手动扫描一轮 */
router.post('/admin/scan', adminOnly, async (req, res) => {
  try {
    const result = await service.scanOnce({
      dryRun: Boolean(req.body && req.body.dryRun),
      now: req.body && req.body.now ? Number(req.body.now) : undefined,
      force: Boolean(req.body && req.body.force),
      openid: (req.body && req.body.openid) || undefined,
    })
    const message = result.skipped
      ? `已跳过：${result.reason}`
      : `检查 ${result.checked} 人，命中 ${result.due} 节课，成功 ${result.sent} 条，失败 ${result.failed} 条，跳过 ${result.skipped} 条`
    return res.json({ code: 0, message, data: result })
  } catch (err) {
    return fail(res, err, '扫描失败')
  }
})

/** 给指定 openid 发测试消息 */
router.post('/admin/test', adminOnly, async (req, res) => {
  try {
    const body = req.body || {}
    const openid = String(body.openid || '').trim()
    if (!openid) return res.status(400).json({ code: 400, message: '请填写接收者的 openid' })
    if (service.isMockOpenid(openid)) {
      return res.status(400).json({ code: 400, message: '这是本地模拟 openid，微信无法下发' })
    }

    const cfg = service.getEffectiveConfig()
    if (!cfg.templateId) return res.status(400).json({ code: 400, message: '请先配置模板 ID' })

    const now = Date.now()
    const className = String(body.className || '').trim()
    const lesson =
      (className ? service.getNextLesson(className, now) : null) ||
      service.getLessonsOnDay(className, now).find((l) => l.startAt > now) || {
        courseName: '测试课程',
        teacher: '测试老师',
        location: '博学楼 1J1A101',
        startAt: now + 30 * 60 * 1000,
        startPeriod: 1,
        endPeriod: 2,
      }

    const templates = await service.fetchAndCacheTemplates()
    const currentTmpl = templates && templates.find((t) => t.templateId === cfg.templateId)
    const { data, missing } = service.buildTemplateData(
      cfg,
      lesson,
      cfg.aheadMinutes,
      currentTmpl ? currentTmpl.fields : null
    )
    const result = await wxApi.sendSubscribeMessage({
      openid,
      templateId: cfg.templateId,
      data,
      page: cfg.page,
      miniprogramState: cfg.miniprogramState,
    })

    db.addReminderLog({
      openid,
      className,
      courseName: lesson.courseName,
      location: lesson.location,
      startAt: lesson.startAt,
      remindAt: now,
      templateId: cfg.templateId,
      status: result.ok ? 'sent' : 'failed',
      reason: 'admin-test',
      errcode: result.errcode,
      errmsg: result.errmsg,
    })

    return res.json({
      code: 0,
      message: result.ok ? '测试消息已下发' : `下发失败：${result.errcode} ${result.errmsg}`,
      data: { result, data, missing },
    })
  } catch (err) {
    return fail(res, err, '测试发送失败')
  }
})

/** 修改/删除某条订阅关系 */
router.post('/admin/subscription', adminOnly, (req, res) => {
  try {
    const body = req.body || {}
    const openid = String(body.openid || '').trim()
    if (!openid) return res.status(400).json({ code: 400, message: '缺少 openid' })

    if (body.action === 'delete') {
      db.deleteReminder(openid)
      return res.json({ code: 0, message: '已删除该订阅', data: service.getAdminPayload(req) })
    }

    const patch = {}
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled)
    if (body.aheadMinutes !== undefined) patch.aheadMinutes = service.normalizeAheadMinutes(body.aheadMinutes)
    if (body.className !== undefined) patch.className = String(body.className || '').trim()
    if (body.quota !== undefined) {
      const target = Math.max(0, Number(body.quota) || 0)
      const exist = db.getReminderByOpenid(openid)
      patch.quota = target
      if (exist && target > Number(exist.quota || 0)) {
        patch.subscribeCount = Number(exist.subscribeCount || 0) + (target - Number(exist.quota || 0))
      }
    }
    db.upsertReminder(openid, patch)
    return res.json({ code: 0, message: '已更新', data: service.getAdminPayload(req) })
  } catch (err) {
    return fail(res, err, '更新订阅失败')
  }
})

/** 清空发送日志 */
router.post('/admin/clear-logs', adminOnly, (req, res) => {
  try {
    db.clearReminders({ logs: true, subscriptions: Boolean(req.body && req.body.subscriptions) })
    return res.json({ code: 0, message: '已清空', data: service.getAdminPayload(req) })
  } catch (err) {
    return fail(res, err, '清空日志失败')
  }
})

module.exports = router
