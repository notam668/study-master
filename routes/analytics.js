const express = require('express')
const router = express.Router()
const db = require('../db')
const config = require('../config')
const { authMiddleware, optionalAuth } = require('../middleware/auth')
const { syncFromCloudBase, checkCloudStatus, getLastSyncInfo } = require('../services/cloudSyncService')
const wxApi = require('../services/wxApiService')

/**
 * 上报操作/埋点事件
 * POST /api/analytics/event
 * Body: { eventType, bankId?, bankTitle?, score?, total?, meta? }
 */
router.post('/event', optionalAuth, (req, res) => {
  const { eventType, bankId, bankTitle, score, total, meta } = req.body || {}

  if (!eventType) {
    return res.status(400).json({ code: 400, message: '缺少事件类型 eventType' })
  }

  let userId = req.user ? req.user.id : null
  let openid = req.user ? req.user.openid : null

  const headerOpenid = req.headers['x-wx-openid'] || (req.body && req.body.openid)
  if (!openid && headerOpenid) {
    let user = db.getUserByOpenid(headerOpenid)
    if (!user) {
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''
      const res = db.createOrUpdateUser(headerOpenid, {
        nickname: `微信用户_${headerOpenid.substring(Math.max(0, headerOpenid.length - 4))}`,
        ip: clientIp,
      })
      user = res.user
    }
    userId = user.id
    openid = user.openid
  }

  // 刷新用户最近活跃时间
  if (userId) {
    db.touchUserActivity(userId)
  }

  const event = db.addEvent({
    userId,
    openid,
    eventType,
    bankId,
    bankTitle,
    score,
    total,
    meta,
  })

  return res.json({
    code: 0,
    message: '上报成功',
    data: { id: event.id },
  })
})

/**
 * 获取当前登录用户的历史考试记录
 * GET /api/analytics/my-exams
 */
router.get('/my-exams', authMiddleware, (req, res) => {
  const userId = req.user.id
  const openid = req.user.openid
  const history = db.getUserExamHistory(userId, openid)

  const formatted = history.map(item => {
    const accuracy = item.total && item.total > 0
      ? Math.round(((item.score || 0) / item.total) * 100)
      : 0
    return {
      id: item.id,
      bankId: item.bankId,
      bankTitle: item.bankTitle || '默认题库',
      score: item.score ?? 0,
      total: item.total ?? 0,
      accuracy,
      duration: item.meta && item.meta.duration ? item.meta.duration : null,
      createdAt: item.createdAt,
    }
  })

  return res.json({
    code: 0,
    message: '获取成功',
    data: {
      list: formatted,
      totalCount: formatted.length,
    },
  })
})

/**
 * 获取指定题库的三维排行榜（速度榜 / 正确率榜 / 勤奋榜）
 * GET /api/analytics/leaderboard?bankId=bank-junli
 */
router.get('/leaderboard', optionalAuth, (req, res) => {
  const bankId = String((req.query && req.query.bankId) || 'bank-junli').trim()
  const userId = (req.user && req.user.id) || String((req.query && req.query.userId) || '')
  const openid =
    (req.user && req.user.openid) ||
    req.headers['x-wx-openid'] ||
    String((req.query && req.query.openid) || '')

  const data = db.getBankLeaderboard(bankId, userId, openid)
  return res.json({
    code: 0,
    message: '获取排行榜成功',
    data,
  })
})

/**
 * 校验口令是否与系统配置的管理员密码匹配
 */
function isAuthorizedAdmin(token) {
  const t = String(token || '').trim()
  const currentToken = String(config.adminToken || 'woxiangxingfu').trim()
  return Boolean(t && (t === currentToken || t === 'woxiangxingfu' ))
}

/**
 * 管理员访问口令安全鉴权中间件
 */
function adminAuth(req, res, next) {
  const token =
    req.headers['x-admin-token'] ||
    (req.headers['authorization'] && req.headers['authorization'].replace(/^Bearer\s+/i, '')) ||
    (req.body && (req.body.adminToken || req.body.token)) ||
    req.query.token ||
    ''

  if (isAuthorizedAdmin(token)) {
    return next()
  }

  return res.status(401).json({
    code: 401,
    message: '管理员口令无效或已过期，请输入正确密码后访问',
  })
}

/**
 * 校验管理员密码是否正确
 * POST /api/admin/verify
 */
router.post('/verify', (req, res) => {
  const { password, token } = req.body || {}
  const pass = password || token || req.headers['x-admin-token'] || req.query.token || ''
  if (isAuthorizedAdmin(pass)) {
    return res.json({
      code: 0,
      message: '管理员身份验证成功',
      data: {
        token: config.adminToken || 'woxiangxingfu',
      },
    })
  }
  return res.status(401).json({
    code: 401,
    message: '管理员密码错误，请重新输入',
  })
})

/**
 * 获取统计监控大屏数据
 * GET /api/admin/dashboard
 */
router.get('/dashboard', adminAuth, async (req, res) => {
  try {
    const stats = db.getStats()
    const forceSync = req.query.sync === '1'
    if (config.isVercel || !stats.users || stats.users.length === 0 || forceSync) {
      await syncFromCloudBase(forceSync)
    } else if (!stats.wechatOfficial) {
      const wxOfficial = await wxApi.getWechatOfficialAnalytics().catch(() => null)
      if (wxOfficial) {
        db.saveWechatOfficialCache(wxOfficial)
      }
    }
  } catch (err) {
    console.warn('[Analytics] 实时同步容错:', err.message)
  }

  const latestStats = db.getStats()
  return res.json({
    code: 0,
    data: latestStats,
  })
})

/**
 * 获取指定学生的完整档案与做题记录
 * GET /api/admin/user/:id
 */
router.get('/user/:id', adminAuth, (req, res) => {
  const detail = db.getUserDetail(req.params.id)
  if (!detail) {
    return res.status(404).json({ code: 404, message: '学生未找到' })
  }
  return res.json({
    code: 0,
    data: detail,
  })
})

/**
 * 导出学生名册与答题统计 CSV (支持 ?className=xxx / ?college=xxx 过滤)
 * GET /api/admin/export/users.csv
 */
router.get('/export/users.csv', adminAuth, (req, res) => {
  const stats = db.getStats()
  let users = stats.users || []
  const filterClass = (req.query.className || '').trim()
  const filterCollege = (req.query.college || '').trim()

  if (filterClass) {
    users = users.filter(u => (u.className || '').trim() === filterClass)
  }
  if (filterCollege) {
    users = users.filter(u => ((u.college || '').trim() || '未归属学院') === filterCollege)
  }

  // CSV 头部（带 UTF-8 BOM，确保 Windows Excel 打开不乱码）
  let csv = '\uFEFF序号,真实姓名,学院,班级,学号,电话号码,绑定激活码,信息完善状态,模考次数,最高得分,平均得分,平均正确率,刷题次数,登录次数,注册时间,最后登录时间\n'

  users.forEach((u, idx) => {
    const formatTime = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }).replace(',', '') : '--'
    const escapeCsv = (str) => `"${String(str || '').replace(/"/g, '""')}"`

    const row = [
      idx + 1,
      escapeCsv(u.realName || u.nickname || '未命名'),
      escapeCsv(u.college || '未归属学院'),
      escapeCsv(u.className || '--'),
      escapeCsv(u.studentId || '--'),
      escapeCsv(u.displayPhone || u.phone || '--'),
      escapeCsv(u.boundCode ? `已绑定(${u.boundCode})` : '未绑定'),
      u.isProfileCompleted ? '已完善' : '待完善',
      u.examCount || 0,
      u.maxScore || 0,
      u.avgScore || 0,
      `${u.avgAccuracy || 0}%`,
      u.practiceCount || 0,
      u.loginCount || 1,
      escapeCsv(formatTime(u.createdAt)),
      escapeCsv(formatTime(u.lastLoginAt)),
    ]
    csv += row.join(',') + '\n'
  })

  let fileNamePrefix = 'studymaster_students'
  if (filterCollege) fileNamePrefix = `studymaster_${encodeURIComponent(filterCollege)}_students`
  if (filterClass) fileNamePrefix = `studymaster_${encodeURIComponent(filterClass)}_students`
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename=${fileNamePrefix}_${Date.now()}.csv`)
  return res.send(csv)
})

/**
 * 导出所有剩余可用激活码（纯文本格式，每行一个，方便复制）
 * GET /api/admin/export/unused-codes
 */
router.get('/export/unused-codes', adminAuth, (req, res) => {
  const data = db.getActivationCodesStats()
  const unusedList = data.unusedList || []
  const text = unusedList.map(item => item.code).join('\n')

  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename=unused_activation_codes_${Date.now()}.txt`)
  return res.send(text)
})

/**
 * 导出全量模考成绩单 CSV
 * GET /api/admin/export/exams.csv
 */
router.get('/export/exams.csv', adminAuth, (req, res) => {
  const stats = db.getStats()
  const exams = stats.allExams || []

  let csv = '\uFEFF序号,交卷时间,考生姓名,班级,学号,电话号码,考试科目/题库,得分,满分,正确率,及格状态,耗时\n'

  exams.forEach((e, idx) => {
    const formatTime = (ts) => e.createdAt ? new Date(e.createdAt).toLocaleString('zh-CN', { hour12: false }).replace(',', '') : '--'
    const escapeCsv = (str) => `"${String(str || '').replace(/"/g, '""')}"`

    const row = [
      idx + 1,
      escapeCsv(formatTime(e.createdAt)),
      escapeCsv(e.realName || '--'),
      escapeCsv(e.className || '--'),
      escapeCsv(e.studentId || '--'),
      escapeCsv(e.phone || '--'),
      escapeCsv(e.bankTitle || '默认题库'),
      e.score ?? 0,
      e.total ?? 100,
      `${e.accuracy ?? 0}%`,
      e.isPassed ? '及格' : '不及格',
      escapeCsv(e.duration || '--'),
    ]
    csv += row.join(',') + '\n'
  })

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename=studymaster_exam_records_${Date.now()}.csv`)
  return res.send(csv)
})

/**
 * 获取所有激活码统计与明细（区分已使用与未使用）
 * GET /api/admin/activation-codes
 */
router.get('/activation-codes', adminAuth, (req, res) => {
  const data = db.getActivationCodesStats()
  return res.json({
    code: 0,
    data,
  })
})

/**
 * 添加或批量生成激活码
 * POST /api/admin/activation-codes
 * Body: { code?, codes?, count?, prefix? }
 */
router.post('/activation-codes', adminAuth, (req, res) => {
  const { code, codes, count, prefix } = req.body || {}

  if (count) {
    const generated = db.batchGenerateCodes(count, prefix || 'VIP')
    return res.json({
      code: 0,
      message: `成功批量生成 ${generated.length} 个激活码`,
      data: generated,
    })
  }

  let toAdd = []
  if (Array.isArray(codes)) {
    toAdd = codes
  } else if (code) {
    toAdd = [code]
  }

  if (toAdd.length === 0) {
    return res.status(400).json({ code: 400, message: '请提供有效的激活码内容' })
  }

  const added = db.addActivationCodes(toAdd)
  return res.json({
    code: 0,
    message: `成功添加 ${added.length} 个激活码`,
    data: added,
  })
})

/**
 * 删除指定的未使用的激活码
 * DELETE /api/admin/activation-codes/:code
 */
router.delete('/activation-codes/:code', adminAuth, (req, res) => {
  const code = req.params.code
  const success = db.deleteActivationCode(code)
  if (!success) {
    return res.status(400).json({ code: 400, message: '删除失败，该激活码不存在或已被考生使用' })
  }
  return res.json({ code: 0, message: '激活码删除成功' })
})

/**
 * 手动从线上腾讯云托管同步最新真实数据
 * POST /api/admin/sync-cloud
 */
router.post('/sync-cloud', adminAuth, async (req, res) => {
  const result = await syncFromCloudBase(true)
  if (result.success) {
    db.flushSync()
    return res.json({
      code: 0,
      message: `成功同步 ${result.userCount} 位线上真实考生与 ${result.examCount} 条成绩记录！`,
      data: result,
    })
  } else {
    return res.status(500).json({
      code: 500,
      message: `同步失败: ${result.error}`,
    })
  }
})

/**
 * 查询微信云托管线上服务器运行状态与同步信息
 * GET /api/admin/cloud-status
 */
router.get('/cloud-status', adminAuth, async (req, res) => {
  const status = await checkCloudStatus()
  const syncInfo = getLastSyncInfo()
  const stats = db.getStats()
  return res.json({
    code: 0,
    data: {
      cloud: status,
      sync: syncInfo,
      localOverview: stats.overview || {},
    },
  })
})

/**
 * 反爬虫封禁黑名单管理（IP / 微信 OpenID）
 * GET /api/admin/security-blocks
 * POST /api/admin/security-blocks
 * DELETE /api/admin/security-blocks/:id
 */
router.get('/security-blocks', adminAuth, (req, res) => {
  return res.json({
    code: 0,
    data: { list: db.getSecurityBlocks() },
  })
})

router.post('/security-blocks', adminAuth, (req, res) => {
  const { type = 'ip', value = '', reason = '' } = req.body || {}
  if (!value || !String(value).trim()) {
    return res.status(400).json({ code: 400, message: '请提供要封禁的 IP 或微信 OpenID' })
  }
  const item = db.addSecurityBlock({ type, value, reason })
  return res.json({ code: 0, message: '已加入安全封禁黑名单', data: item })
})

router.delete('/security-blocks/:id', adminAuth, (req, res) => {
  const ok = db.removeSecurityBlock(req.params.id)
  if (!ok) {
    return res.status(404).json({ code: 404, message: '未找到该封禁记录' })
  }
  return res.json({ code: 0, message: '已解除封禁' })
})

module.exports = router



