const express = require('express')
const router = express.Router()
const db = require('../db')
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

/**
 * 保存用户专属课表
 * POST /api/schedule/user-schedule
 * Body: { scheduleData, userKey }
 */
router.post('/user-schedule', optionalAuth, (req, res) => {
  const { scheduleData, userKey } = req.body || {}
  const targetKey = (req.user && (req.user.studentId || req.user.openid || req.user.phone || req.user.id)) || userKey
  if (!targetKey) {
    return res.status(400).json({ code: 400, message: '缺少用户标识，无法保存课表' })
  }
  if (!scheduleData || !scheduleData.sessions) {
    return res.status(400).json({ code: 400, message: '课表数据格式不正确' })
  }

  const keysToUpdate = new Set()
  keysToUpdate.add(String(targetKey).trim())
  if (userKey) keysToUpdate.add(String(userKey).trim())
  if (req.user) {
    if (req.user.studentId) keysToUpdate.add(String(req.user.studentId).trim())
    if (req.user.phone) keysToUpdate.add(String(req.user.phone).trim())
    if (req.user.openid) keysToUpdate.add(String(req.user.openid).trim())
    if (req.user.id) keysToUpdate.add(String(req.user.id).trim())
  }
  if (scheduleData.studentId) keysToUpdate.add(String(scheduleData.studentId).trim())

  let savedRecord = null
  for (const k of keysToUpdate) {
    if (k) {
      savedRecord = db.saveUserSchedule(k, scheduleData)
    }
  }

  return res.json({
    code: 0,
    message: '课表已成功保存至云端服务器',
    data: savedRecord,
  })
})

/**
 * 获取用户专属课表
 * GET /api/schedule/user-schedule?userKey=xxx
 */
router.get('/user-schedule', optionalAuth, (req, res) => {
  const { userKey } = req.query || {}
  const keysToCheck = []
  if (req.user) {
    if (req.user.studentId) keysToCheck.push(String(req.user.studentId).trim())
    if (req.user.phone) keysToCheck.push(String(req.user.phone).trim())
    if (req.user.openid) keysToCheck.push(String(req.user.openid).trim())
    if (req.user.id) keysToCheck.push(String(req.user.id).trim())
  }
  if (userKey) keysToCheck.push(String(userKey).trim())

  for (const k of keysToCheck) {
    if (!k) continue
    const record = db.getUserSchedule(k)
    if (record && record.scheduleData) {
      return res.json({
        code: 0,
        message: '读取成功',
        data: record.scheduleData,
        updatedAt: record.updatedAt,
      })
    }
  }

  return res.json({
    code: 0,
    message: '暂无云端保存的课表',
    data: null,
  })
})

const scheduleOcrService = require('../services/scheduleOcrService')

/**
 * 拍照/相册课表智能识别与解析导入
 * POST /api/schedule/ocr-import
 * Body: { imageBase64: "data:image/jpeg;base64,..." }
 */
router.post('/ocr-import', async (req, res) => {
  const { imageBase64 } = req.body || {}
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({
      code: 400,
      message: '请提供有效的课表图片数据 (imageBase64)',
    })
  }

  // 1. 优先采用纯 Node.js 的高可用 OCR 识别管道（彻底解决 Vercel 无法运行 Python 的架构缺陷）
  try {
    const parsed = await scheduleOcrService.processScheduleOcr(imageBase64)
    if (parsed && (parsed.success || (parsed.sessions && parsed.sessions.length > 0) || parsed.matchedClass)) {
      return res.json({
        code: 0,
        message: '识别解析成功',
        data: parsed,
      })
    }
  } catch (cloudErr) {
    console.warn('[Schedule OCR] 云端智能识别引擎异常，尝试本地备用通道:', cloudErr.message)
  }

  // 2. 本地备用通道：若处于有 Python 环境的服务器（如本地开发机），调用 parse_schedule_image.py
  const { spawn } = require('child_process')
  const fs = require('fs')
  const path = require('path')
  const os = require('os')

  let tempPath = ''
  try {
    const rawData = imageBase64.replace(/^data:image\/\w+;base64,/, '')
    const buffer = Buffer.from(rawData, 'base64')
    tempPath = path.join(os.tmpdir(), `ocr_schedule_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.jpg`)
    fs.writeFileSync(tempPath, buffer)

    const candidateScripts = [
      path.join(__dirname, '..', 'tools', 'parse_schedule_image.py'),
      path.resolve(__dirname, '..', '..', '刷题小程序（正式版）', 'tools', 'parse_schedule_image.py'),
      path.join('d:\\刷题小程序（正式版）', 'tools', 'parse_schedule_image.py'),
    ]
    const scriptPath = candidateScripts.find(p => fs.existsSync(p))

    if (!scriptPath) {
      if (tempPath && fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath) } catch (e) {}
      }
      return res.json({
        code: 0,
        fallback: true,
        message: '未能自动解析出清晰排课，推荐直接通过班级搜索一键导入官方完整课表',
        data: null,
      })
    }

    let hasResponded = false
    const respondOnce = (status, payload) => {
      if (hasResponded) return
      hasResponded = true
      if (tempPath && fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath) } catch (e) {}
      }
      return res.status(status).json(payload)
    }

    const pythonBin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3')
    const py = spawn(pythonBin, ['-X', 'utf8', scriptPath, tempPath], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })

    let stdout = ''
    let stderr = ''

    py.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8')
    })
    py.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8')
    })

    const timeout = setTimeout(() => {
      try { py.kill() } catch (e) {}
      respondOnce(200, {
        code: 0,
        fallback: true,
        message: '课表图片识别解析超时，建议直接通过班级搜索一键导入官方完整课表',
        data: null,
      })
    }, 45000)

    py.on('error', err => {
      clearTimeout(timeout)
      console.warn('[Schedule OCR] Python 备用通道未启动:', err.message)
      respondOnce(200, {
        code: 0,
        fallback: true,
        message: '图片识别服务暂未返回有效数据，建议直接通过班级搜索一键导入官方完整课表',
        data: null,
      })
    })

    py.on('close', code => {
      clearTimeout(timeout)
      if (hasResponded) return

      if (code !== 0) {
        return respondOnce(200, {
          code: 0,
          fallback: true,
          message: '未能从图片中解析出排课，建议直接通过班级搜索一键导入官方完整课表',
          error: stderr || `Exit code ${code}`,
          data: null,
        })
      }

      try {
        const jsonMatch = stdout.match(/\{[\s\S]*\}/)
        if (!jsonMatch) throw new Error('未解析出有效 JSON')
        const parsed = JSON.parse(jsonMatch[0])
        return respondOnce(200, {
          code: 0,
          message: '识别解析成功',
          data: parsed,
        })
      } catch (err) {
        return respondOnce(200, {
          code: 0,
          fallback: true,
          message: '未能提取出有效课程结构，建议直接通过班级搜索一键导入官方完整课表',
          data: null,
        })
      }
    })
  } catch (err) {
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath) } catch (e) {}
    }
    return res.json({
      code: 0,
      fallback: true,
      message: '图片处理异常，建议直接通过班级搜索一键导入官方完整课表',
      data: null,
    })
  }
})

const jwxtService = require('../services/jwxtService')

/**
 * 盐城工学院正方教务系统个人课表拉取与解析导入
 * POST /api/schedule/import-jwxt
 * Body: { studentId, password, termId?, rawKbJson? }
 */
router.post('/import-jwxt', optionalAuth, async (req, res) => {
  try {
    const { studentId, password, termId, rawKbJson } = req.body || {}
    const result = await jwxtService.importFromJwxt({
      studentId,
      password,
      termId,
      rawKbJson,
      user: req.user || null,
    })

    // 自动保存至当前登录用户的云端专属课表
    if (req.user) {
      const keys = [req.user.studentId, req.user.openid, req.user.phone, req.user.id, studentId].filter(Boolean)
      keys.forEach(k => db.saveUserSchedule(String(k).trim(), result))
    } else if (studentId) {
      db.saveUserSchedule(String(studentId).trim(), result)
    }

    return res.json({
      code: 0,
      message: '教务系统课表同步成功',
      data: result,
    })
  } catch (err) {
    return res.status(400).json({
      code: 400,
      message: err.message || '教务课表同步失败',
    })
  }
})

module.exports = router

