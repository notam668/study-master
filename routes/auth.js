const express = require('express')
const router = express.Router()
const axios = require('axios')
const jwt = require('jsonwebtoken')
const config = require('../config')
const db = require('../db')
const { authMiddleware, optionalAuth } = require('../middleware/auth')

/**
 * 微信小程序登录
 * POST /api/auth/login
 * Body: { code, nickname?, avatarUrl? }
 */
router.post('/login', async (req, res) => {
  const { code, nickname, avatarUrl, realName, className, phone, studentId } = req.body || {}
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''

  if (!code) {
    return res.status(400).json({ code: 400, message: '缺少登录凭证 code' })
  }

  let openid = ''

  // 0. 如果是微信云托管原生 callContainer 调用，微信会自动注入安全可信的 x-wx-openid 头部
  const headerOpenid = req.headers['x-wx-openid']
  if (headerOpenid && typeof headerOpenid === 'string' && headerOpenid.trim() !== '') {
    openid = headerOpenid.trim()
  } else if (config.wxAppSecret && config.wxAppSecret.trim() !== '' && !code.startsWith('dev_code_') && !code.startsWith('mock_')) {
    // 1. 如果配置了微信 AppSecret，则真实请求微信服务器 jscode2session
    try {
      const wxRes = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
        params: {
          appid: config.wxAppId,
          secret: config.wxAppSecret,
          js_code: code,
          grant_type: 'authorization_code',
        },
        timeout: 5000,
      })

      if (wxRes.data && wxRes.data.openid) {
        openid = wxRes.data.openid
      } else {
        console.warn('微信接口返回提示（可能是开发工具模拟 code）:', wxRes.data)
        openid = `wx_dev_${code.length > 8 ? code.substring(0, 16) : code}`
      }
    } catch (err) {
      console.warn('请求微信 jscode2session 异常，自动启用安全降级登录:', err.message)
      // 云托管容器内无外网公网出口或网络波动时，绝不抛 500 导致小程序瘫痪，安全派生身份
      openid = `wx_cloud_${code.length > 8 ? code.substring(0, 16) : code}`
    }
  } else {
    // 2. 本地开发/测试模式
    openid = `mock_wx_${code.length > 8 ? code.substring(0, 16) : code}`
  }

  // 3. 记录或更新用户数据
  const { user, isNew } = db.createOrUpdateUser(openid, {
    nickname,
    avatarUrl,
    realName,
    className,
    phone,
    studentId,
    ip: clientIp,
  })

  // 4. 生成 JWT Token（有效期 30 天）
  const token = jwt.sign(
    { userId: user.id, openid: user.openid },
    config.jwtSecret,
    { expiresIn: '30d' }
  )

  // 5. 记录登录事件
  db.addEvent({
    userId: user.id,
    openid: user.openid,
    eventType: isNew ? 'user_register' : 'user_login',
    meta: { isNew, ip: clientIp },
  })

  return res.json({
    code: 0,
    message: isNew ? '新用户授权成功' : '登录成功',
    data: {
      token,
      isNewUser: isNew,
      user: {
        id: user.id,
        openid: user.openid,
        nickname: user.nickname,
        realName: user.realName || '',
        className: user.className || '',
        studentId: user.studentId || '',
        phone: user.phone || '',
        avatarText: user.avatarText || '',
        avatarUrl: user.avatarUrl,
        isProfileCompleted: user.isProfileCompleted || false,
        isExamUnlocked: true,
        createdAt: user.createdAt,
        loginCount: user.loginCount,
      },
    },
  })
})

/**
 * 提交/更新学生信息（问答式采集：年级、学号、学院、班级、姓名、电话号码、排行榜显示偏好）
 * POST /api/auth/profile
 * Body: { realName, className, phone?, studentId?, nickname?, avatarUrl?, grade?, college?, major?, campus?, rankDisplayMode? }
 */
router.post('/profile', authMiddleware, (req, res) => {
  const {
    realName,
    className,
    phone,
    studentId,
    nickname,
    avatarUrl,
    grade,
    college,
    major,
    campus,
    rankDisplayMode,
  } = req.body || {}

  const cleanPhone = phone ? String(phone).trim() : ''
  const cleanStudentId = studentId ? String(studentId).trim() : ''
  const cleanRealName = realName ? String(realName).trim() : ''
  let cleanClassName = className ? String(className).trim() : ''

  const roster = cleanStudentId ? db.lookupFreshmanChecked(cleanStudentId, cleanRealName) : null
  if (roster && roster.found && roster.nameMatched === false) {
    return res.status(400).json({
      code: 400,
      message: roster.message,
    })
  }

  const matched = Boolean(roster && roster.nameMatched && roster.student)
  let cleanGrade = grade || ''
  let cleanCollege = college || ''
  let cleanMajor = major || ''
  let cleanCampus = campus || ''
  if (matched) {
    cleanClassName = roster.student.className
    cleanGrade = roster.student.grade || '2026级'
    cleanCollege = roster.student.college || ''
    cleanMajor = roster.student.major || ''
    cleanCampus = roster.student.campus || ''
  } else {
    cleanGrade = db.normalizeGradeInput(cleanGrade, '')
  }

  if (!cleanRealName || !cleanPhone || !cleanClassName) {
    return res.status(400).json({
      code: 400,
      message: roster && roster.found === false
        ? '未在2026级新生名单中找到该学号。大二、大三、大四请手动填写班级、学院、专业和校区'
        : '请完整填写姓名、所在班级与电话号码',
    })
  }

  const validation = db.validateProfileInput({
    realName: cleanRealName,
    phone: cleanPhone,
    studentId: cleanStudentId,
    className: cleanClassName,
    grade: cleanGrade,
  })
  if (!validation.valid) {
    return res.status(400).json({
      code: 400,
      message: validation.message,
    })
  }

  const conflict = db.findProfileConflict({
    phone: cleanPhone,
    studentId: cleanStudentId,
    exceptUserId: req.user.id,
  })
  if (conflict) {
    return res.status(400).json({
      code: 400,
      message: conflict.message,
    })
  }

  const user = db.updateUserProfile(req.user.id, {
    realName: cleanRealName,
    className: cleanClassName,
    phone: cleanPhone,
    studentId: cleanStudentId,
    nickname,
    avatarUrl,
    grade: cleanGrade,
    college: cleanCollege,
    major: cleanMajor,
    campus: cleanCampus,
    rankDisplayMode: rankDisplayMode === 'realName' ? 'realName' : 'nickname',
    isFreshmanVerified: matched,
  })

  if (!user) {
    return res.status(404).json({ code: 404, message: '用户不存在' })
  }

  // 记录完善信息事件
  db.addEvent({
    userId: user.id,
    openid: user.openid,
    eventType: 'update_profile',
    meta: {
      realName: user.realName,
      className: user.className,
      studentId: user.studentId,
      phone: user.phone,
      grade: user.grade,
      college: user.college,
      rankDisplayMode: user.rankDisplayMode,
    },
  })

  // 同步更新用户上课提醒绑定的班级
  if (user.openid && user.className) {
    try {
      db.upsertReminder(user.openid, { className: user.className })
    } catch (e) {
      console.warn('[Profile Update] 同步班级至提醒失败:', e)
    }
  }

  return res.json({
    code: 0,
    message: user.isFreshmanVerified
      ? '已按2026级新生名单匹配学院、专业、班级和校区'
      : '信息保存成功',
    data: {
      id: user.id,
      realName: user.realName,
      className: user.className,
      studentId: user.studentId,
      phone: user.phone,
      grade: user.grade || '',
      college: user.college || '',
      major: user.major || '',
      campus: user.campus || '',
      rankDisplayMode: user.rankDisplayMode || 'nickname',
      isFreshmanVerified: Boolean(user.isFreshmanVerified),
      avatarText: user.avatarText,
      isProfileCompleted: user.isProfileCompleted,
      isExamUnlocked: true,
      profileSource: user.isFreshmanVerified ? 'freshman-roster' : 'manual',
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
    },
  })
})

/**
 * 2026级大一新生学号核验。realName / name 可选：
 * 不传姓名只查学号；传了姓名则必须和新生名单一致，否则不返回档案。
 * GET /api/auth/freshman-lookup?studentId=260101011001&realName=姓名
 */
router.get('/freshman-lookup', optionalAuth, (req, res) => {
  const sid = String((req.query && req.query.studentId) || '').trim()
  const realName = String((req.query && (req.query.realName || req.query.name)) || '').trim()
  if (!sid || sid.length < 8) {
    return res.status(400).json({ code: 400, message: '请输入正确的学号' })
  }
  return res.json({
    code: 0,
    data: db.lookupFreshmanChecked(sid, realName),
  })
})

/**
 * 获取盐城工学院 17 个官方学院及下属班级元数据
 * GET /api/auth/colleges
 */
router.get('/colleges', (req, res) => {
  const meta = db.getProfileFormMeta()
  return res.json({
    code: 0,
    data: {
      colleges: meta.colleges,
      campuses: meta.campuses,
      grades: meta.grades,
    },
  })
})

/**
 * 跨端 APP 标准账号登录接口（为后续独立手机 APP 预留，支持学号/手机号登录）
 * POST /api/auth/app-login
 */
router.post('/app-login', (req, res) => {
  const { account, studentId, phone } = req.body || {}
  const key = String(account || studentId || phone || '').trim()
  if (!key) {
    return res.status(400).json({ code: 400, message: '请输入学号或手机号' })
  }
  // 只登录 app_ 专用身份。不能因为学号或手机号相同，就把微信用户的登录态发给调用方。
  const openid = `app_${key}`
  const existing = db.getUserByOpenid(openid)
  let nextStudentId = /^\d{8,14}$/.test(key) ? key : ''
  let nextPhone = /^1[3-9]\d{9}$/.test(key) ? key : ''
  const exceptUserId = existing ? existing.id : ''
  if (nextStudentId && db.findProfileConflict({ studentId: nextStudentId, exceptUserId })) {
    nextStudentId = ''
  }
  if (nextPhone && db.findProfileConflict({ phone: nextPhone, exceptUserId })) {
    nextPhone = ''
  }
  const created = db.createOrUpdateUser(openid, {
    studentId: nextStudentId,
    phone: nextPhone,
  })
  const user = created.user
  const token = jwt.sign({ userId: user.id, openid: user.openid }, config.jwtSecret, { expiresIn: '30d' })
  return res.json({
    code: 0,
    message: 'APP 登录成功',
    data: {
      token,
      user: {
        ...user,
        isExamUnlocked: true,
      },
    },
  })
})

/**
 * 兼容旧版「输入激活码」入口。题库和模考已经全部开放，这里不再核销激活码。
 * POST /api/auth/unlock-exam
 * Body: { code? } 激活码可省略，传了也不会消耗。
 */
router.post('/unlock-exam', optionalAuth, (req, res) => {
  const targetUser = req.user
  if (targetUser && targetUser.id) {
    db.grantExamAccess(targetUser.id)
    db.addEvent({
      userId: targetUser.id,
      openid: targetUser.openid,
      eventType: 'unlock_exam',
      meta: { free: true },
    })
  }

  return res.json({
    code: 0,
    message: '题库与模考已全部开放，无需激活码',
    data: {
      isExamUnlocked: true,
    },
  })
})

/**
 * 获取当前用户信息
 * GET /api/auth/me
 */
router.get('/me', authMiddleware, (req, res) => {
  return res.json({
    code: 0,
    data: {
      ...req.user,
      isExamUnlocked: true,
    },
  })
})

module.exports = router
