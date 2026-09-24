const express = require('express')
const router = express.Router()
const scheduleService = require('../services/scheduleService')
const { optionalAuth } = require('../middleware/auth')

/**
 * 获取所有班级列表（支持 keyword 模糊搜索）
 * GET /api/schedule/classes?keyword=xxx
 */
router.get('/classes', (req, res) => {
  const { keyword } = req.query
  const classes = scheduleService.getAllClassNames()
  if (!keyword || !keyword.trim()) {
    return res.json({
      code: 0,
      data: {
        total: classes.length,
        classes,
      },
    })
  }

  const kw = keyword.trim().toLowerCase()
  const filtered = classes.filter(c => c.toLowerCase().includes(kw))
  return res.json({
    code: 0,
    data: {
      total: filtered.length,
      classes: filtered,
    },
  })
})

/**
 * 查询班级课表
 * GET /api/schedule/query?className=xxx
 */
router.get('/query', optionalAuth, (req, res) => {
  let { className } = req.query
  // 如果没有显式传 className，但用户已登录，则使用用户登记的班级
  if (!className && req.user && req.user.className) {
    className = req.user.className
  }

  if (!className || !className.trim()) {
    return res.status(400).json({
      code: 400,
      message: '请指定需要查询的班级名称',
    })
  }

  const result = scheduleService.getScheduleByClass(className.trim())
  if (!result) {
    return res.status(503).json({
      code: 503,
      message: '课表数据源准备中，请稍后重试',
    })
  }

  if (!result.matched) {
    return res.json({
      code: 404,
      message: `未找到与「${className}」相匹配的班级课表，请核对班级名称`,
      data: result,
    })
  }

  return res.json({
    code: 0,
    message: '查询成功',
    data: result,
  })
})

/**
 * 触发重新同步
 * POST /api/schedule/sync
 */
router.post('/sync', async (req, res) => {
  try {
    const data = await scheduleService.syncScheduleData()
    if (data) {
      return res.json({ code: 0, message: '课表数据同步成功' })
    }
    return res.status(500).json({ code: 500, message: '同步失败' })
  } catch (err) {
    return res.status(500).json({ code: 500, message: err.message })
  }
})

module.exports = router
