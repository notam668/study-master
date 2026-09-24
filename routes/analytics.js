const express = require('express')
const router = express.Router()
const db = require('../db')
const { authMiddleware, optionalAuth } = require('../middleware/auth')

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
 * 获取统计监控大屏数据
 * GET /api/admin/dashboard
 */
router.get('/dashboard', async (req, res) => {
  try {
    const stats = db.getStats()
    // 如果在 Vercel 环境或者本地尚无用户，主动拉取一次腾讯云托管 510+ 真实考生数据
    if (config.isVercel || !stats.users || stats.users.length === 0 || req.query.sync === '1') {
      const { syncFromCloudBase } = require('../services/cloudSyncService')
      await syncFromCloudBase()
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
router.get('/user/:id', (req, res) => {
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
 * 导出学生名册与答题统计 CSV (支持 ?className=xxx 过滤单个班级)
 * GET /api/admin/export/users.csv
 */
router.get('/export/users.csv', (req, res) => {
  const stats = db.getStats()
  let users = stats.users || []
  const filterClass = (req.query.className || '').trim()

  if (filterClass) {
    users = users.filter(u => (u.className || '').trim() === filterClass)
  }

  // CSV 头部（带 UTF-8 BOM，确保 Windows Excel 打开不乱码）
  let csv = '\uFEFF序号,真实姓名,班级,学号,电话号码,绑定激活码,信息完善状态,模考次数,最高得分,平均得分,平均正确率,刷题次数,登录次数,注册时间,最后登录时间\n'

  users.forEach((u, idx) => {
    const formatTime = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }).replace(',', '') : '--'
    const escapeCsv = (str) => `"${String(str || '').replace(/"/g, '""')}"`

    const row = [
      idx + 1,
      escapeCsv(u.realName || u.nickname || '未命名'),
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

  const fileNamePrefix = filterClass ? `studymaster_${encodeURIComponent(filterClass)}_students` : 'studymaster_students'
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename=${fileNamePrefix}_${Date.now()}.csv`)
  return res.send(csv)
})

/**
 * 导出所有剩余可用激活码（纯文本格式，每行一个，方便复制）
 * GET /api/admin/export/unused-codes
 */
router.get('/export/unused-codes', (req, res) => {
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
router.get('/export/exams.csv', (req, res) => {
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
router.get('/activation-codes', (req, res) => {
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
router.post('/activation-codes', (req, res) => {
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
router.delete('/activation-codes/:code', (req, res) => {
  const code = req.params.code
  const success = db.deleteActivationCode(code)
  if (!success) {
    return res.status(400).json({ code: 400, message: '删除失败，该激活码不存在或已被考生使用' })
  }
  return res.json({ code: 0, message: '激活码删除成功' })
})

const { syncFromCloudBase } = require('../services/cloudSyncService')

/**
 * 手动从线上腾讯云托管同步最新真实数据
 * POST /api/admin/sync-cloud
 */
router.post('/sync-cloud', async (req, res) => {
  const result = await syncFromCloudBase()
  if (result.success) {
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

module.exports = router



