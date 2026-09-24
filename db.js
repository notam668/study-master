const fs = require('fs')
const path = require('path')
const config = require('./config')

const DATA_DIR = config.dataDir
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
} catch (e) {
  console.warn('[DB] 初始化数据目录警告:', e.message)
}

const DB_FILE = path.join(DATA_DIR, 'studymaster.json')

// 如果在 Vercel 等临时目录且文件尚未创建，尝试从源码内置 data 目录拷入初始数据
const SEED_FILE = path.join(__dirname, 'data', 'studymaster.json')
if (!fs.existsSync(DB_FILE) && fs.existsSync(SEED_FILE) && DB_FILE !== SEED_FILE) {
  try {
    fs.copyFileSync(SEED_FILE, DB_FILE)
    console.log('[DB] 已从内置种子数据恢复 studymaster.json 到临时目录')
  } catch (e) {
    console.warn('[DB] 拷贝内置种子数据失败:', e.message)
  }
}

// 初始化默认数据结构
const initialData = {
  users: [],       // { id, openid, realName, className, phone, studentId, avatarText, nickname, avatarUrl, isProfileCompleted, isExamUnlocked, createdAt, lastLoginAt, loginCount, ip }
  events: [],      // { id, userId, openid, eventType, bankId, bankTitle, score, total, meta, createdAt }
  activationCodes: [], // { id, code, isUsed, usedByUserId, usedByUserRealName, usedByUserClass, usedByUserPhone, usedByUserOpenid, usedAt, createdAt }
  announcement: null,  // 开屏公告配置，结构见 services/announcementService.js；null = 用内置默认值
  reminders: [],       // 上课提醒订阅 { openid, userId, className, enabled, aheadMinutes, quota, subscribeCount, ... }
  reminderLogs: [],    // 上课提醒下发日志 { id, openid, className, courseName, startAt, remindAt, status, errcode, errmsg, createdAt }
  reminderConfig: null, // 上课提醒全局配置，结构见 services/reminderService.js；null = 用内置默认值
}

// 提醒日志只保留最近 N 条，避免 data/studymaster.json 无限膨胀
const REMINDER_LOG_LIMIT = 800

let memoryDb = null

function normalizePhoneAndStudentId(phoneInput, studentIdInput) {
  let phone = (phoneInput || '').trim()
  let studentId = (studentIdInput || '').trim()
  const isPhone = (v) => /^1[3-9]\d{9}$/.test(v)

  // 1. 如果 studentId 填成了 11 位手机号而 phone 为空，纠偏归正到 phone
  if (studentId && isPhone(studentId) && !phone) {
    phone = studentId
    studentId = ''
  }

  // 2. 如果 phone 填的是长学号（不是手机号），且 studentId 为空，纠偏到 studentId
  if (phone && !isPhone(phone) && !studentId) {
    studentId = phone
    phone = ''
  }

  // 3. 严格规则：只要 phone 不是合规 11 位手机号，一律清空（如果 studentId 为空则放入 studentId），杜绝污染
  if (phone && !isPhone(phone)) {
    if (!studentId) studentId = phone
    phone = ''
  }

  return { phone, studentId }
}

function loadDb() {
  if (memoryDb) return memoryDb
  if (fs.existsSync(DB_FILE)) {
    try {
      const content = fs.readFileSync(DB_FILE, 'utf8')
      memoryDb = JSON.parse(content)
      if (!Array.isArray(memoryDb.activationCodes)) {
        memoryDb.activationCodes = []
      }
      // 老数据兼容：早期版本没有 announcement 字段
      if (memoryDb.announcement === undefined) {
        memoryDb.announcement = null
      }
      // 老数据兼容：早期版本没有上课提醒相关字段
      if (!Array.isArray(memoryDb.reminders)) {
        memoryDb.reminders = []
      }
      if (!Array.isArray(memoryDb.reminderLogs)) {
        memoryDb.reminderLogs = []
      }
      if (memoryDb.reminderConfig === undefined) {
        memoryDb.reminderConfig = null
      }
      // 数据自动纠偏归正
      let userUpdated = false
      if (Array.isArray(memoryDb.users)) {
        memoryDb.users.forEach(u => {
          const oldPhone = u.phone
          const oldStudentId = u.studentId
          const { phone, studentId } = normalizePhoneAndStudentId(u.phone, u.studentId)
          u.phone = phone
          u.studentId = studentId
          u.isProfileCompleted = Boolean(u.realName && u.className && u.phone)
          if (oldPhone !== u.phone || oldStudentId !== u.studentId) {
            userUpdated = true
          }
        })
      }

      // 生成 50 个正式考培激活码 (YCIT-2026-1001 ~ YCIT-2026-1050)
      const official50Codes = []
      for (let i = 1001; i <= 1050; i++) {
        official50Codes.push(`YCIT-2026-${i}`)
      }

      // 预设激活码列表
      const presetCodes = [
        ...official50Codes,
        ...(config.examActivationCodes || ['VIP888', 'STUDY666', 'YCIT888', '2026888', 'SM888', 'EXAM888'])
      ]

      const existingCodes = new Set(memoryDb.activationCodes.map(c => c.code.toUpperCase()))
      let addedNew = false
      presetCodes.forEach(p => {
        const clean = p.toUpperCase().trim()
        if (!existingCodes.has(clean)) {
          memoryDb.activationCodes.push({
            id: `code_${clean}`,
            code: clean,
            isUsed: false,
            usedByUserId: null,
            usedByUserRealName: null,
            usedByUserClass: null,
            usedByUserPhone: null,
            usedByUserOpenid: null,
            usedAt: null,
            createdAt: 1787125200000,
          })
          existingCodes.add(clean)
          addedNew = true
        }
      })

      if (addedNew || userUpdated) {
        saveDb()
      }
    } catch (e) {
      console.error('读取数据库失败，重新初始化:', e)
      memoryDb = { ...initialData }
    }
  } else {
    memoryDb = { ...initialData }
    saveDb()
  }
  return memoryDb
}

let saveTimer = null
function saveDb() {
  if (!memoryDb) return
  // 防抖 + 原子化写入临时文件再重命名
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      const tmpFile = `${DB_FILE}.tmp`
      fs.writeFileSync(tmpFile, JSON.stringify(memoryDb, null, 2), 'utf8')
      fs.renameSync(tmpFile, DB_FILE)
    } catch (err) {
      console.error('持久化写入失败:', err)
    }
  }, 100)
}

function flushSync() {
  if (!memoryDb) return
  try {
    const tmpFile = `${DB_FILE}.tmp`
    fs.writeFileSync(tmpFile, JSON.stringify(memoryDb, null, 2), 'utf8')
    fs.renameSync(tmpFile, DB_FILE)
  } catch (err) {
    console.error('强制同步写入失败:', err)
  }
}

// 用户操作方法
const db = {
  getUserByOpenid(openid) {
    const d = loadDb()
    return d.users.find(u => u.openid === openid) || null
  },

  getUserById(id) {
    const d = loadDb()
    return d.users.find(u => u.id === id) || null
  },

  createOrUpdateUser(openid, extraInfo = {}) {
    const d = loadDb()
    let user = d.users.find(u => u.openid === openid)
    const now = Date.now()
    let isNew = false
    const { phone, studentId } = normalizePhoneAndStudentId(extraInfo.phone, extraInfo.studentId)

    if (!user) {
      isNew = true
      user = {
        id: `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        openid,
        nickname: extraInfo.nickname || `微信用户_${openid.substring(0, 6)}`,
        realName: extraInfo.realName || '',
        className: extraInfo.className || '',
        studentId,
        phone,
        avatarText: extraInfo.realName ? extraInfo.realName.trim().charAt(0) : '',
        avatarUrl: extraInfo.avatarUrl || '',
        isProfileCompleted: Boolean(extraInfo.realName && extraInfo.className && phone),
        isExamUnlocked: false,
        examUnlockCode: null,
        examUnlockedAt: null,
        createdAt: now,
        lastLoginAt: now,
        loginCount: 1,
        lastIp: extraInfo.ip || '',
      }
      d.users.push(user)
    } else {
      user.lastLoginAt = now
      user.loginCount = (user.loginCount || 1) + 1
      if (extraInfo.nickname) user.nickname = extraInfo.nickname
      if (extraInfo.avatarUrl) user.avatarUrl = extraInfo.avatarUrl
      if (extraInfo.ip) user.lastIp = extraInfo.ip
      if (extraInfo.realName) {
        user.realName = extraInfo.realName
        user.avatarText = extraInfo.realName.trim().charAt(0)
      }
      if (extraInfo.className) user.className = extraInfo.className
      if (studentId) user.studentId = studentId
      if (phone) user.phone = phone
      user.isProfileCompleted = Boolean(user.realName && user.className && user.phone)
    }

    saveDb()
    return { user, isNew }
  },

  updateUserProfile(userId, { realName, className, phone, studentId, nickname, avatarUrl }) {
    const d = loadDb()
    const user = d.users.find(u => u.id === userId)
    if (!user) return null

    if (realName !== undefined) {
      user.realName = (realName || '').trim()
      user.avatarText = user.realName ? user.realName.charAt(0) : ''
    }
    if (className !== undefined) user.className = (className || '').trim()
    
    const { phone: cleanPhone, studentId: cleanStudentId } = normalizePhoneAndStudentId(
      phone !== undefined ? phone : user.phone,
      studentId !== undefined ? studentId : user.studentId
    )
    if (phone !== undefined || cleanPhone) user.phone = cleanPhone
    if (studentId !== undefined || cleanStudentId) user.studentId = cleanStudentId

    if (nickname !== undefined) user.nickname = nickname
    if (avatarUrl !== undefined) user.avatarUrl = avatarUrl

    user.isProfileCompleted = Boolean(user.realName && user.className && user.phone)

    saveDb()
    return user
  },

  unlockUserExam(userId, code) {
    const d = loadDb()
    const user = d.users.find(u => u.id === userId)
    if (!user) return null

    user.isExamUnlocked = true
    user.examUnlockCode = code
    user.examUnlockedAt = Date.now()

    saveDb()
    return user
  },

  touchUserActivity(userId) {
    const d = loadDb()
    const user = d.users.find(u => u.id === userId || (u.openid && u.openid === userId))
    if (user) {
      user.lastLoginAt = Date.now()
      user.loginCount = (user.loginCount || 1) + 1
      saveDb()
    }
  },

  // 模考激活码管理相关方法
  getActivationCodesStats() {
    const d = loadDb()
    if (!Array.isArray(d.activationCodes)) {
      d.activationCodes = []
    }

    const all = d.activationCodes.slice()
    const used = all.filter(c => c.isUsed).sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0))
    const unused = all.filter(c => !c.isUsed).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

    return {
      total: all.length,
      usedCount: used.length,
      unusedCount: unused.length,
      activationRate: all.length > 0 ? Math.round((used.length / all.length) * 100) : 0,
      usedList: used,
      unusedList: unused,
      allList: all,
    }
  },

  addActivationCodes(codesArray) {
    const d = loadDb()
    if (!Array.isArray(d.activationCodes)) {
      d.activationCodes = []
    }

    const existingSet = new Set(d.activationCodes.map(c => c.code.toUpperCase()))
    const added = []
    const now = Date.now()

    codesArray.forEach(raw => {
      const code = String(raw || '').trim().toUpperCase()
      if (code && !existingSet.has(code)) {
        existingSet.add(code)
        const item = {
          id: `code_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          code,
          isUsed: false,
          usedByUserId: null,
          usedByUserRealName: null,
          usedByUserClass: null,
          usedByUserPhone: null,
          usedByUserOpenid: null,
          usedAt: null,
          createdAt: now,
        }
        d.activationCodes.unshift(item)
        added.push(item)
      }
    })

    saveDb()
    return added
  },

  batchGenerateCodes(count = 10, prefix = 'VIP') {
    const generated = []
    const cleanPrefix = (prefix || 'VIP').trim().toUpperCase()
    const num = Math.min(Math.max(parseInt(count, 10) || 10, 1), 100)

    for (let i = 0; i < num; i++) {
      const randomDigits = Math.floor(100 + Math.random() * 900)
      const randomStr = Math.random().toString(36).substring(2, 6).toUpperCase()
      const code = `${cleanPrefix}${randomDigits}${randomStr}`
      generated.push(code)
    }

    return this.addActivationCodes(generated)
  },

  deleteActivationCode(code) {
    const d = loadDb()
    if (!Array.isArray(d.activationCodes)) return false

    const cleanCode = (code || '').trim().toUpperCase()
    const idx = d.activationCodes.findIndex(c => c.code === cleanCode)
    if (idx === -1) return false

    // 如果已使用，不允许随意删除（保留审计日志）
    if (d.activationCodes[idx].isUsed) {
      return false
    }

    d.activationCodes.splice(idx, 1)
    saveDb()
    return true
  },

  redeemActivationCode(code, user) {
    const d = loadDb()
    if (!Array.isArray(d.activationCodes)) {
      d.activationCodes = []
    }

    const cleanCode = (code || '').trim().toUpperCase()
    if (!cleanCode) {
      return { success: false, message: '激活码不能为空' }
    }

    let codeItem = d.activationCodes.find(c => c.code === cleanCode)

    // 如果数据库中尚无此码，但属于全局预设码，自动初始化添加
    if (!codeItem && (config.examActivationCodes || []).includes(cleanCode)) {
      codeItem = {
        id: `code_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        code: cleanCode,
        isUsed: false,
        usedByUserId: null,
        usedByUserRealName: null,
        usedByUserClass: null,
        usedByUserPhone: null,
        usedByUserOpenid: null,
        usedAt: null,
        createdAt: Date.now(),
      }
      d.activationCodes.push(codeItem)
    }

    if (!codeItem) {
      return { success: false, message: '激活码无效或不存在，请核对后重试' }
    }

    if (codeItem.isUsed) {
      const userName = codeItem.usedByUserRealName ? ` (已被考生「${codeItem.usedByUserRealName}」使用)` : ''
      return { success: false, message: `该激活码已被使用${userName}，不可重复使用` }
    }

    // 成功兑换，实时绑定考生信息
    const now = Date.now()
    codeItem.isUsed = true
    codeItem.usedByUserId = user ? user.id : null
    codeItem.usedByUserRealName = user ? (user.realName || user.nickname || '考生') : '未知考生'
    codeItem.usedByUserClass = user ? (user.className || '--') : '--'
    codeItem.usedByUserStudentId = user ? (user.studentId || '--') : '--'
    const cleanPhone = (user && user.phone && /^1[3-9]\d{9}$/.test(String(user.phone).trim())) ? String(user.phone).trim() : (user && user.phone ? String(user.phone).trim() : '--')
    codeItem.usedByUserPhone = cleanPhone
    codeItem.usedByUserOpenid = user ? (user.openid || '') : ''
    codeItem.usedAt = now

    // 如果关联了用户实体，同步解锁用户
    if (user && user.id) {
      const dbUser = d.users.find(u => u.id === user.id || (user.openid && u.openid === user.openid))
      if (dbUser) {
        dbUser.isExamUnlocked = true
        dbUser.examUnlockCode = cleanCode
        dbUser.examUnlockedAt = now
      }
    }

    saveDb()
    return {
      success: true,
      message: '激活成功！已解锁无限次模考权限',
      codeItem,
    }
  },

  addEvent({ userId, openid, eventType, bankId, bankTitle, score, total, meta }) {
    const d = loadDb()
    const event = {
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      userId: userId || 'anonymous',
      openid: openid || '',
      eventType, // 'page_view' | 'start_practice' | 'finish_exam' | 'save_bank' | 'import_bank' | 'update_profile'
      bankId: bankId || '',
      bankTitle: bankTitle || '',
      score: typeof score === 'number' ? score : null,
      total: typeof total === 'number' ? total : null,
      meta: meta || {},
      createdAt: Date.now(),
    }
    d.events.push(event)
    saveDb()
    return event
  },

  getStats() {
    const d = loadDb()
    const now = Date.now()
    const todayZero = new Date().setHours(0, 0, 0, 0)

    const totalUsers = d.users.length
    const todayUsers = d.users.filter(u => u.createdAt >= todayZero).length
    
    // 综合统计今日活跃人数（包含登录、做题及页面浏览）
    const activeTodayUserSet = new Set(
      d.users.filter(u => (u.lastLoginAt && u.lastLoginAt >= todayZero) || (u.createdAt && u.createdAt >= todayZero)).map(u => u.id)
    )
    d.events.filter(e => e.createdAt >= todayZero).forEach(e => {
      if (e.userId && e.userId !== 'anonymous') activeTodayUserSet.add(e.userId)
      if (e.openid) activeTodayUserSet.add(e.openid)
    })
    const activeUsersToday = activeTodayUserSet.size

    const completedProfiles = d.users.filter(u => u.isProfileCompleted).length
    const uncompletedProfiles = totalUsers - completedProfiles

    const totalEvents = d.events.length
    const todayEvents = d.events.filter(e => e.createdAt >= todayZero).length

    // 统计所有交卷与练习事件
    const examEvents = d.events.filter(e => e.eventType === 'finish_exam')
    const practiceEvents = d.events.filter(e => e.eventType === 'start_practice')

    // 模考平均分与及格率
    let totalExamScoreSum = 0
    let passedExamCount = 0
    examEvents.forEach(e => {
      const score = e.score || 0
      const total = e.total || 100
      totalExamScoreSum += score
      if (total > 0 && (score / total) >= 0.6) {
        passedExamCount++
      }
    })
    const overallAvgScore = examEvents.length > 0 ? Math.round(totalExamScoreSum / examEvents.length) : 0
    const examPassRate = examEvents.length > 0 ? Math.round((passedExamCount / examEvents.length) * 100) : 0

    // 建立用户 ID 和 openid 到用户的快速索引
    const userMap = new Map()
    d.users.forEach(u => {
      userMap.set(u.id, u)
      if (u.openid) userMap.set(u.openid, u)
    })

    // 题库热度
    const bankMap = {}
    d.events.forEach(e => {
      if (e.bankTitle) {
        bankMap[e.bankTitle] = (bankMap[e.bankTitle] || 0) + 1
      }
    })
    const popularBanks = Object.keys(bankMap).map(k => ({ title: k, count: bankMap[k] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)

    // 丰富每个学生的做题统计情况
    const enrichedUsers = d.users.map(u => {
      const userExams = examEvents.filter(e => (u.id && e.userId === u.id) || (u.openid && e.openid === u.openid))
      const userPractices = practiceEvents.filter(e => (u.id && e.userId === u.id) || (u.openid && e.openid === u.openid))

      const examCount = userExams.length
      const maxScore = examCount > 0 ? Math.max(...userExams.map(e => e.score || 0)) : 0
      const totalScore = userExams.reduce((sum, e) => sum + (e.score || 0), 0)
      const avgScore = examCount > 0 ? Math.round(totalScore / examCount) : 0

      let totalAcc = 0
      userExams.forEach(e => {
        const total = e.total && e.total > 0 ? e.total : 100
        totalAcc += ((e.score || 0) / total) * 100
      })
      const avgAccuracy = examCount > 0 ? Math.round(totalAcc / examCount) : 0

      // 手机号严格校验（必须为 11 位合法手机号）
      const rawPhone = (u.phone || '').trim()
      const isPhoneValid = /^1[3-9]\d{9}$/.test(rawPhone)
      const displayPhone = isPhoneValid ? rawPhone : ''

      // 激活码绑定情况交叉索引
      let boundCode = u.examUnlockCode || null
      let boundAt = u.examUnlockedAt || null
      if (!boundCode && Array.isArray(d.activationCodes)) {
        const matched = d.activationCodes.find(c => c.isUsed && (
          (c.usedByUserId && c.usedByUserId === u.id) ||
          (u.openid && c.usedByUserOpenid === u.openid) ||
          (u.realName && c.usedByUserRealName === u.realName && u.className && c.usedByUserClass === u.className)
        ))
        if (matched) {
          boundCode = matched.code
          boundAt = matched.usedAt
        }
      }
      const isExamUnlocked = Boolean(u.isExamUnlocked || boundCode)

      return {
        ...u,
        phone: displayPhone,
        rawPhone: u.phone || '',
        studentId: u.studentId || '',
        isProfileCompleted: Boolean(u.realName && u.className && displayPhone),
        isExamUnlocked,
        boundCode: boundCode || null,
        boundAt: boundAt || null,
        examCount,
        maxScore,
        avgScore,
        avgAccuracy,
        practiceCount: userPractices.length,
      }
    }).sort((a, b) => (b.lastLoginAt || 0) - (a.lastLoginAt || 0))

    // 班级统计聚合
    const classGroupMap = {}
    enrichedUsers.forEach(u => {
      const cName = (u.className || '').trim() || '未填写班级'
      if (!classGroupMap[cName]) {
        classGroupMap[cName] = {
          className: cName,
          studentCount: 0,
          completedCount: 0,
          examCount: 0,
          totalScoreSum: 0,
          maxScore: 0,
        }
      }
      const group = classGroupMap[cName]
      group.studentCount++
      if (u.isProfileCompleted) group.completedCount++
      group.examCount += u.examCount
      group.totalScoreSum += u.avgScore * u.examCount
      if (u.maxScore > group.maxScore) group.maxScore = u.maxScore
    })

    const classStats = Object.values(classGroupMap).map(c => ({
      className: c.className,
      studentCount: c.studentCount,
      completedCount: c.completedCount,
      completedRate: Math.round((c.completedCount / c.studentCount) * 100),
      examCount: c.examCount,
      avgScore: c.examCount > 0 ? Math.round(c.totalScoreSum / c.examCount) : 0,
      maxScore: c.maxScore,
    })).sort((a, b) => b.studentCount - a.studentCount)

    // 全量模考成绩明细单（最近 200 条）
    const allExams = examEvents.slice().reverse().slice(0, 200).map(e => {
      const user = userMap.get(e.userId) || (e.openid ? userMap.get(e.openid) : null)
      const total = e.total && e.total > 0 ? e.total : 100
      const score = e.score || 0
      const accuracy = Math.round((score / total) * 100)
      return {
        id: e.id,
        userId: e.userId,
        realName: (user && user.realName) || (user && user.nickname) || '未知考生',
        className: (user && user.className) || '--',
        phone: (user && (user.phone || user.studentId)) || '--',
        bankId: e.bankId || 'default',
        bankTitle: e.bankTitle || '默认题库',
        score,
        total,
        accuracy,
        duration: e.meta && e.meta.duration ? e.meta.duration : (e.meta && e.meta.durationMinutes ? `${e.meta.durationMinutes}分钟` : '--'),
        isPassed: accuracy >= 60,
        createdAt: e.createdAt,
      }
    })

    // 最近 50 条实时流水
    const recentLogs = d.events.slice(-50).reverse().map(e => {
      const user = userMap.get(e.userId) || (e.openid ? userMap.get(e.openid) : null)
      let displayName = '未知用户'
      let displaySub = ''
      let avatarChar = ''

      if (user) {
        if (user.realName) {
          displayName = user.realName
          const phoneOrId = user.phone || user.studentId
          displaySub = `${user.className || ''} ${phoneOrId ? '· ' + phoneOrId : ''}`
          avatarChar = user.avatarText || user.realName.charAt(0)
        } else {
          displayName = user.nickname || '考生'
          avatarChar = (user.nickname || '考').charAt(0)
        }
      }

      return {
        ...e,
        userDisplayName: displayName,
        userDisplaySub: displaySub,
        userAvatarChar: avatarChar,
        isProfileCompleted: user ? user.isProfileCompleted : false,
      }
    })

    return {
      overview: {
        totalUsers,
        todayUsers,
        activeUsersToday,
        completedProfiles,
        uncompletedProfiles,
        totalEvents,
        todayEvents,
        totalExamsFinished: examEvents.length,
        totalPracticesStarted: practiceEvents.length,
        overallAvgScore,
        examPassRate,
      },
      popularBanks,
      recentLogs,
      users: enrichedUsers,
      classStats,
      allExams,
      activationStats: this.getActivationCodesStats(),
    }
  },

  getAllUsers() {
    const d = loadDb()
    return d.users
  },

  getUserDetail(userId) {
    const d = loadDb()
    const user = d.users.find(u => u.id === userId || u.openid === userId)
    if (!user) return null

    const exams = d.events.filter(e => {
      const isExam = e.eventType === 'finish_exam'
      const match = (user.id && e.userId === user.id) || (user.openid && e.openid === user.openid)
      return isExam && match
    }).map(e => {
      const total = e.total && e.total > 0 ? e.total : 100
      const score = e.score || 0
      return {
        id: e.id,
        bankTitle: e.bankTitle || '默认题库',
        score,
        total,
        accuracy: Math.round((score / total) * 100),
        duration: e.meta && e.meta.duration ? e.meta.duration : '--',
        createdAt: e.createdAt,
      }
    }).sort((a, b) => b.createdAt - a.createdAt)

    const events = d.events.filter(e => {
      return (user.id && e.userId === user.id) || (user.openid && e.openid === user.openid)
    }).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30)

    const maxScore = exams.length > 0 ? Math.max(...exams.map(x => x.score)) : 0
    const totalScore = exams.reduce((s, x) => s + x.score, 0)
    const avgScore = exams.length > 0 ? Math.round(totalScore / exams.length) : 0
    const avgAccuracy = exams.length > 0 ? Math.round(exams.reduce((s, x) => s + x.accuracy, 0) / exams.length) : 0

    return {
      user: {
        ...user,
        examCount: exams.length,
        maxScore,
        avgScore,
        avgAccuracy,
      },
      exams,
      recentEvents: events,
    }
  },

  getUserExamHistory(userId, openid) {
    const d = loadDb()
    const list = d.events.filter(e => {
      const isExam = e.eventType === 'finish_exam'
      const matchUser = (userId && e.userId === userId) || (openid && e.openid === openid)
      return isExam && matchUser
    })
    return list.slice().sort((a, b) => b.createdAt - a.createdAt)
  },

  /**
   * 读取开屏公告配置（返回 null 表示从未保存过，调用方使用内置默认值）
   */
  getAnnouncement() {
    const d = loadDb()
    return d.announcement && typeof d.announcement === 'object' ? d.announcement : null
  },

  /**
   * 保存开屏公告配置
   */
  saveAnnouncement(cfg) {
    const d = loadDb()
    d.announcement = {
      ...cfg,
      updatedAt: Date.now(),
    }
    saveDb()
    return d.announcement
  },

  // ───────────────────────── 上课提醒（微信订阅消息） ─────────────────────────

  /**
   * 读取提醒全局配置（null = 从未保存过，调用方使用内置默认值）
   */
  getReminderConfig() {
    const d = loadDb()
    return d.reminderConfig && typeof d.reminderConfig === 'object' ? d.reminderConfig : null
  },

  /**
   * 保存提醒全局配置
   */
  saveReminderConfig(cfg) {
    const d = loadDb()
    d.reminderConfig = { ...cfg, updatedAt: Date.now() }
    saveDb()
    return d.reminderConfig
  },

  /**
   * 全部提醒订阅（按更新时间倒序）
   */
  getReminders() {
    const d = loadDb()
    if (!Array.isArray(d.reminders)) d.reminders = []
    return d.reminders.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  },

  getReminderByOpenid(openid) {
    if (!openid) return null
    const d = loadDb()
    if (!Array.isArray(d.reminders)) d.reminders = []
    return d.reminders.find((r) => r.openid === openid) || null
  },

  /**
   * 新建或更新一条提醒订阅
   * 注意：quota 只在显式传 quotaDelta 时变化，避免前端并发覆盖导致次数丢失
   */
  upsertReminder(openid, patch = {}) {
    const d = loadDb()
    if (!Array.isArray(d.reminders)) d.reminders = []
    const now = Date.now()
    let item = d.reminders.find((r) => r.openid === openid)

    if (!item) {
      item = {
        openid,
        userId: '',
        className: '',
        enabled: false,
        aheadMinutes: null, // null = 跟随全局默认
        quota: 0,
        subscribeCount: 0,
        sentCount: 0,
        lastGrantAt: null,
        lastSentAt: null,
        createdAt: now,
        updatedAt: now,
      }
      d.reminders.push(item)
    }

    const { quotaDelta, ...rest } = patch
    Object.keys(rest).forEach((k) => {
      if (rest[k] !== undefined) item[k] = rest[k]
    })
    if (typeof quotaDelta === 'number' && quotaDelta !== 0) {
      item.quota = Math.max(0, Number(item.quota || 0) + quotaDelta)
      if (quotaDelta > 0) {
        item.subscribeCount = Number(item.subscribeCount || 0) + quotaDelta
        item.lastGrantAt = now
      }
    }
    item.updatedAt = now
    saveDb()
    return item
  },

  deleteReminder(openid) {
    const d = loadDb()
    if (!Array.isArray(d.reminders)) return false
    const idx = d.reminders.findIndex((r) => r.openid === openid)
    if (idx === -1) return false
    d.reminders.splice(idx, 1)
    saveDb()
    return true
  },

  /**
   * 写入一条下发日志，并把数组裁剪到 REMINDER_LOG_LIMIT 以内
   */
  addReminderLog(entry = {}) {
    const d = loadDb()
    if (!Array.isArray(d.reminderLogs)) d.reminderLogs = []
    const log = {
      id: `rlog_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      openid: entry.openid || '',
      userId: entry.userId || '',
      className: entry.className || '',
      courseName: entry.courseName || '',
      location: entry.location || '',
      startAt: entry.startAt || null,
      remindAt: entry.remindAt || null,
      status: entry.status || 'sent', // sent | failed | skipped
      reason: entry.reason || '',
      templateId: entry.templateId || '',
      errcode: typeof entry.errcode === 'number' ? entry.errcode : null,
      errmsg: entry.errmsg || '',
      createdAt: Date.now(),
    }
    d.reminderLogs.push(log)
    if (d.reminderLogs.length > REMINDER_LOG_LIMIT) {
      d.reminderLogs = d.reminderLogs.slice(-REMINDER_LOG_LIMIT)
    }
    saveDb()
    return log
  },

  getReminderLogs(limit = 100) {
    const d = loadDb()
    if (!Array.isArray(d.reminderLogs)) d.reminderLogs = []
    return d.reminderLogs.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
  },

  /**
   * 幂等判断：这节课+这个模板是否已经处理过（无论成功失败都不再重发）
   */
  hasReminderLogFor(openid, startAt, templateId) {
    const d = loadDb()
    if (!Array.isArray(d.reminderLogs)) return false
    return d.reminderLogs.some(
      (l) => l.openid === openid && l.startAt === startAt && (!templateId || l.templateId === templateId)
    )
  },

  /**
   * 某用户在上海时区"今天"已成功发送的条数（用于每日上限保护）
   * dayStartMs/dayEndMs 由调用方按时区算好传入
   */
  countReminderSentBetween(openid, dayStartMs, dayEndMs) {
    const d = loadDb()
    if (!Array.isArray(d.reminderLogs)) return 0
    return d.reminderLogs.filter(
      (l) => l.openid === openid && l.status === 'sent' && l.createdAt >= dayStartMs && l.createdAt < dayEndMs
    ).length
  },

  /**
   * 清空所有提醒订阅与日志（管理台用）
   */
  clearReminders(options = {}) {
    const d = loadDb()
    if (options.logs !== false) d.reminderLogs = []
    if (options.subscriptions) d.reminders = []
    saveDb()
    return true
  },

  /**
   * 批量导入并合并线上云托管真实考生数据
   */
  importCloudUsers(cloudUsers = []) {
    const d = loadDb()
    if (!Array.isArray(d.users)) d.users = []
    let updatedCount = 0

    const userMap = new Map()
    d.users.forEach((u) => {
      if (u.openid) userMap.set(u.openid, u)
      if (u.id) userMap.set(u.id, u)
    })

    cloudUsers.forEach((cu) => {
      const existing = (cu.openid && userMap.get(cu.openid)) || (cu.id && userMap.get(cu.id))
      const cleaned = {
        id: cu.id || `usr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        openid: cu.openid || '',
        nickname: cu.nickname || '考生',
        realName: cu.realName || '',
        className: cu.className || '',
        studentId: cu.studentId || '',
        phone: cu.phone || cu.displayPhone || '',
        avatarText: cu.avatarText || (cu.realName ? cu.realName[0] : '考'),
        avatarUrl: cu.avatarUrl || '',
        isProfileCompleted: Boolean(cu.isProfileCompleted || (cu.realName && cu.className && (cu.phone || cu.displayPhone))),
        isExamUnlocked: Boolean(cu.isExamUnlocked),
        examUnlockCode: cu.examUnlockCode || null,
        examUnlockedAt: cu.examUnlockedAt || null,
        createdAt: cu.createdAt || Date.now(),
        lastLoginAt: cu.lastLoginAt || Date.now(),
        loginCount: cu.loginCount || 1,
        lastIp: cu.lastIp || '',
      }

      if (existing) {
        Object.assign(existing, cleaned)
      } else {
        d.users.push(cleaned)
        if (cleaned.openid) userMap.set(cleaned.openid, cleaned)
        userMap.set(cleaned.id, cleaned)
      }
      updatedCount++
    })

    saveDb()
    return updatedCount
  },

  /**
   * 批量导入线上真实考试记录
   */
  importCloudExams(cloudExams = []) {
    const d = loadDb()
    if (!Array.isArray(d.events)) d.events = []
    let updatedCount = 0

    const existingEventIds = new Set(d.events.map((e) => e.id))

    cloudExams.forEach((ce) => {
      const id = ce.id || `evt_${ce.createdAt || Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      if (!existingEventIds.has(id)) {
        d.events.push({
          id,
          userId: ce.userId || '',
          openid: ce.openid || '',
          eventType: 'finish_exam',
          bankId: ce.bankId || 'bank-junli',
          bankTitle: ce.bankTitle || '军事理论',
          score: ce.score ?? 0,
          total: ce.total ?? 50,
          meta: {
            duration: ce.duration || null,
            accuracy: ce.accuracy || 0,
            realName: ce.realName || '',
            className: ce.className || '',
            phone: ce.phone || '',
          },
          createdAt: ce.createdAt || Date.now(),
        })
        existingEventIds.add(id)
        updatedCount++
      }
    })

    saveDb()
    return updatedCount
  },

  flushSync,
}

module.exports = db

