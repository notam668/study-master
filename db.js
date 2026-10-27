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

// 每次返回全新对象，避免浅拷贝把 users/events 数组和默认模板串在一起
function emptyData() {
  return {
    users: [],       // { id, openid, realName, className, phone, studentId, avatarText, nickname, avatarUrl, isProfileCompleted, isExamUnlocked, createdAt, lastLoginAt, loginCount, ip }
    events: [],      // { id, userId, openid, eventType, bankId, bankTitle, score, total, meta, createdAt }
    activationCodes: [], // { id, code, isUsed, usedByUserId, usedByUserRealName, usedByUserClass, usedByUserPhone, usedByUserOpenid, usedAt, createdAt }
    announcement: null,  // 开屏公告配置，结构见 services/announcementService.js；null = 用内置默认值
    reminders: [],       // 上课提醒订阅 { openid, userId, className, enabled, aheadMinutes, quota, subscribeCount, ... }
    reminderLogs: [],    // 上课提醒下发日志 { id, openid, className, courseName, startAt, remindAt, status, errcode, errmsg, createdAt }
    reminderConfig: null, // 上课提醒全局配置，结构见 services/reminderService.js；null = 用内置默认值
    userSchedules: {},   // 用户保存的课表日程：key 为 openid / userId / studentId
    userDorms: {},       // 电费宿舍绑定：key 必须是用户本人标识，不能是宿舍房间
  }
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

function normalizeRealName(name) {
  return String(name || '')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[•・‧．.]/g, '·')
}

// 同一条流水不能同时算给两个用户。userId 和 openid 都在、但指向不同人时，这条记录不归任何一方。
function eventBelongsTo(event, userId, openid) {
  if (!event) return false
  const idMatch = Boolean(userId && event.userId && event.userId === userId)
  const openidMatch = Boolean(openid && event.openid && event.openid === openid)
  if (idMatch) {
    if (event.openid && openid && event.openid !== openid) return false
    return true
  }
  if (openidMatch) {
    if (userId && event.userId && event.userId !== userId) return false
    return true
  }
  return false
}

// 主库解析失败时禁止把空库写回去。备份成功后才允许用每日备份或空库继续服务。
let persistBlocked = false

function backupUnreadableDb() {
  try {
    const backupDir = path.join(DATA_DIR, 'backups')
    fs.mkdirSync(backupDir, { recursive: true })
    const dest = path.join(backupDir, `studymaster.corrupt-${Date.now()}.json`)
    fs.copyFileSync(DB_FILE, dest)
    console.error('[DB] 无法解析的主库已备份到', dest)
    return true
  } catch (err) {
    console.error('[DB] 损坏主库备份失败:', err.message)
    return false
  }
}

function readNewestDailyBackup() {
  const backupDir = path.join(DATA_DIR, 'backups')
  if (!fs.existsSync(backupDir)) return null
  let names = []
  try {
    names = fs.readdirSync(backupDir)
  } catch (err) {
    return null
  }
  const candidates = names
    .filter((name) => /^studymaster_\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => {
      const full = path.join(backupDir, name)
      let mtime = 0
      try {
        mtime = fs.statSync(full).mtimeMs
      } catch (err) {
        mtime = 0
      }
      return { full, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)

  for (const item of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(item.full, 'utf8'))
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.users)) {
        return parsed
      }
    } catch (err) {
      console.warn('[DB] 跳过无法解析的备份:', item.full)
    }
  }
  return null
}

function writeDbAtomic() {
  if (!memoryDb || persistBlocked) return
  const userCount = Array.isArray(memoryDb.users) ? memoryDb.users.length : 0
  if (userCount === 0 && fs.existsSync(DB_FILE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
      if (prev && Array.isArray(prev.users) && prev.users.length > 0) {
        console.error('[DB] 拒绝用空用户表覆盖已有主库')
        return
      }
    } catch (err) {
      // 主库当前不可解析。读取失败时已经另存副本，这里允许写回一份可解析的数据。
    }
  }
  const tmpFile = `${DB_FILE}.tmp`
  fs.writeFileSync(tmpFile, JSON.stringify(memoryDb, null, 2), 'utf8')
  fs.renameSync(tmpFile, DB_FILE)
}

function ensureCollections(data) {
  if (!Array.isArray(data.users)) data.users = []
  if (!Array.isArray(data.events)) data.events = []
  if (!Array.isArray(data.activationCodes)) data.activationCodes = []
  if (data.announcement === undefined) data.announcement = null
  if (!Array.isArray(data.reminders)) data.reminders = []
  if (!Array.isArray(data.reminderLogs)) data.reminderLogs = []
  if (data.reminderConfig === undefined) data.reminderConfig = null
  if (!data.userSchedules || typeof data.userSchedules !== 'object' || Array.isArray(data.userSchedules)) {
    data.userSchedules = {}
  }
  if (!data.userDorms || typeof data.userDorms !== 'object' || Array.isArray(data.userDorms)) {
    data.userDorms = {}
  }
}

function normalizeStoredDb() {
  ensureCollections(memoryDb)
  let userUpdated = false
  memoryDb.users.forEach((u) => {
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

  // 管理端仍可查看和导出历史激活码。用户能不能做题不再看这些码。
  const official50Codes = []
  for (let i = 1001; i <= 1050; i++) {
    official50Codes.push(`YCIT-2026-${i}`)
  }
  const presetCodes = [
    ...official50Codes,
    ...(config.examActivationCodes || ['VIP888', 'STUDY666', 'YCIT888', '2026888', 'SM888', 'EXAM888']),
  ]
  const existingCodes = new Set(memoryDb.activationCodes.map((c) => String(c.code || '').toUpperCase()))
  let addedNew = false
  presetCodes.forEach((p) => {
    const clean = String(p || '').toUpperCase().trim()
    if (!clean || existingCodes.has(clean)) return
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
  })
  return addedNew || userUpdated
}

function loadDb() {
  if (memoryDb) return memoryDb
  let loadedFromBackup = false
  if (!fs.existsSync(DB_FILE)) {
    memoryDb = emptyData()
  } else {
    try {
      memoryDb = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
      if (!memoryDb || typeof memoryDb !== 'object' || Array.isArray(memoryDb)) {
        throw new Error('主库结构不是对象')
      }
    } catch (err) {
      console.error('[DB] 主库解析失败，不会用空库覆盖原文件:', err.message)
      const backedUp = backupUnreadableDb()
      const restored = readNewestDailyBackup()
      if (restored) {
        memoryDb = restored
        loadedFromBackup = true
        console.error('[DB] 已从每日备份回退用户数据')
      } else {
        memoryDb = emptyData()
        persistBlocked = !backedUp
        if (persistBlocked) {
          console.error('[DB] 损坏文件备份失败，暂停落盘')
        }
      }
    }
  }

  const dirty = normalizeStoredDb()
  if ((dirty || loadedFromBackup || !fs.existsSync(DB_FILE)) && !persistBlocked) {
    saveDb()
  }
  return memoryDb
}

let saveTimer = null
function saveDb() {
  if (!memoryDb || persistBlocked) return
  // 防抖 + 原子化写入临时文件再重命名
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      writeDbAtomic()
    } catch (err) {
      console.error('持久化写入失败:', err)
    }
  }, 100)
}

function flushSync() {
  if (!memoryDb || persistBlocked) return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    writeDbAtomic()
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
        isExamUnlocked: true,
        examUnlockCode: null,
        examUnlockedAt: now,
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
      user.isExamUnlocked = true
    }

    saveDb()
    return { user, isNew }
  },

  updateUserProfile(userId, { realName, className, phone, studentId, nickname, avatarUrl, grade, college, major, campus, rankDisplayMode, isFreshmanVerified }) {
    const d = loadDb()
    const user = d.users.find(u => u.id === userId)
    if (!user) return null

    if (realName !== undefined) {
      user.realName = (realName || '').trim()
      user.avatarText = user.realName ? user.realName.charAt(0) : ''
    }
    if (className !== undefined) user.className = (className || '').trim()
    if (grade !== undefined) user.grade = String(grade || '').trim()
    if (college !== undefined) user.college = String(college || '').trim()
    if (major !== undefined) user.major = String(major || '').trim()
    if (campus !== undefined) user.campus = String(campus || '').trim()
    if (rankDisplayMode !== undefined) {
      user.rankDisplayMode = rankDisplayMode === 'realName' ? 'realName' : 'nickname'
    }
    if (isFreshmanVerified !== undefined) {
      user.isFreshmanVerified = Boolean(isFreshmanVerified)
    }

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
    if (code) user.examUnlockCode = code
    user.examUnlockedAt = user.examUnlockedAt || Date.now()

    saveDb()
    return user
  },

  // 题库和模考不再需要激活码。只把已有用户标成已开通，不核销、不覆盖历史激活码。
  grantExamAccess(userId) {
    const d = loadDb()
    const user = d.users.find((u) => u.id === userId)
    if (!user) return null
    if (!user.isExamUnlocked) {
      user.isExamUnlocked = true
      user.examUnlockedAt = user.examUnlockedAt || Date.now()
      saveDb()
    }
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
    // 统一按北京时间 (UTC+8) 计算今日零点与昨日零点，避免 Vercel (UTC) 时区偏差
    const tzOffsetMs = 8 * 3600 * 1000
    const todayZero = Math.floor((now + tzOffsetMs) / 86400000) * 86400000 - tzOffsetMs
    const yesterdayZero = todayZero - 86400000

    // 建立用户 ID 和 openid 到用户的快速索引
    const userMap = new Map()
    d.users.forEach(u => {
      userMap.set(u.id, u)
      if (u.openid) userMap.set(u.openid, u)
    })

    const totalUsers = d.users.length
    const todayUsers = d.users.filter(u => u.createdAt >= todayZero).length
    const yesterdayUsers = d.users.filter(u => u.createdAt >= yesterdayZero && u.createdAt < todayZero).length

    // 综合统计今日活跃人数（统一归并到唯一用户标识，消除 userId + openid 重复计数 Bug）
    const activeTodayUserSet = new Set(
      d.users
        .filter(u => (u.lastLoginAt && u.lastLoginAt >= todayZero) || (u.createdAt && u.createdAt >= todayZero))
        .map(u => u.id || u.openid)
    )
    d.events.filter(e => e.createdAt >= todayZero).forEach(e => {
      const matchedUser = (e.userId && userMap.get(e.userId)) || (e.openid && userMap.get(e.openid))
      if (matchedUser) {
        activeTodayUserSet.add(matchedUser.id || matchedUser.openid)
      } else if (e.openid) {
        activeTodayUserSet.add(e.openid)
      } else if (e.userId && e.userId !== 'anonymous') {
        activeTodayUserSet.add(e.userId)
      }
    })
    const activeUsersToday = activeTodayUserSet.size

    const completedProfiles = d.users.filter(u => u.isProfileCompleted).length
    const uncompletedProfiles = totalUsers - completedProfiles

    const localTotalEvents = d.events.length
    const localTodayEvents = d.events.filter(e => e.createdAt >= todayZero).length

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

    // 题库热度（合并本地事件与云托管全量统计，并过滤乱码题库名）
    const bankMap = {}
    const normalizeBankTitle = (rawTitle) => {
      const t = String(rawTitle || '').trim()
      if (!t || t.includes('??')) return ''
      if (t === '军事理论') return '军事理论题库'
      return t
    }
    d.events.forEach(e => {
      const cleanTitle = normalizeBankTitle(e.bankTitle)
      if (cleanTitle) {
        bankMap[cleanTitle] = (bankMap[cleanTitle] || 0) + 1
      }
    })
    if (d.cloudMetrics && Array.isArray(d.cloudMetrics.popularBanks)) {
      const cloudMerged = {}
      d.cloudMetrics.popularBanks.forEach(item => {
        const cleanTitle = normalizeBankTitle(item && item.title)
        if (cleanTitle) {
          cloudMerged[cleanTitle] = (cloudMerged[cleanTitle] || 0) + (Number(item.count) || 0)
        }
      })
      Object.keys(cloudMerged).forEach(k => {
        bankMap[k] = Math.max(bankMap[k] || 0, cloudMerged[k])
      })
    }
    const popularBanks = Object.keys(bankMap).map(k => ({ title: k, count: bankMap[k] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)

    // 丰富每个学生的做题统计情况
    const enrichedUsers = d.users.map(u => {
      const userExams = examEvents.filter((e) => eventBelongsTo(e, u.id, u.openid))
      const userPractices = practiceEvents.filter((e) => eventBelongsTo(e, u.id, u.openid))

      const localExamCount = userExams.length
      const examCount = Math.max(localExamCount, Number(u.cloudExamCount) || 0)
      const maxScore = localExamCount > 0 ? Math.max(...userExams.map(e => e.score || 0)) : (Number(u.cloudMaxScore) || 0)
      const totalScore = userExams.reduce((sum, e) => sum + (e.score || 0), 0)
      const avgScore = localExamCount > 0 ? Math.round(totalScore / localExamCount) : (Number(u.cloudAvgScore) || 0)

      let totalAcc = 0
      userExams.forEach(e => {
        const total = e.total && e.total > 0 ? e.total : 100
        totalAcc += ((e.score || 0) / total) * 100
      })
      const avgAccuracy = localExamCount > 0 ? Math.round(totalAcc / localExamCount) : (Number(u.cloudAvgAccuracy) || 0)
      const practiceCount = Math.max(userPractices.length, Number(u.cloudPracticeCount) || 0)

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
      return {
        ...u,
        phone: displayPhone,
        rawPhone: u.phone || '',
        studentId: u.studentId || '',
        isProfileCompleted: Boolean(u.realName && u.className && displayPhone),
        isExamUnlocked: true,
        boundCode: boundCode || null,
        boundAt: boundAt || null,
        examCount,
        maxScore,
        avgScore,
        avgAccuracy,
        practiceCount,
      }
    }).sort((a, b) => {
      const timeA = a.lastLoginAt || a.createdAt || 0
      const timeB = b.lastLoginAt || b.createdAt || 0
      return timeB - timeA
    })

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

    // 全量模考成绩明细单（按交卷时间严格倒序取最近 200 条）
    const allExams = examEvents.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 200).map(e => {
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

    const cloudOv = (d.cloudMetrics && d.cloudMetrics.overview) || {}
    const sumUserPractices = enrichedUsers.reduce((sum, u) => sum + (Number(u.practiceCount) || 0), 0)
    const totalEvents = Math.max(localTotalEvents, Number(cloudOv.totalEvents) || 0)
    const todayEvents = Math.max(localTodayEvents, Number(cloudOv.todayEvents) || 0)
    const totalExamsFinished = Math.max(examEvents.length, Number(cloudOv.totalExamsFinished) || 0)
    const totalPracticesStarted = Math.max(practiceEvents.length, Number(cloudOv.totalPracticesStarted) || 0, sumUserPractices)

    return {
      overview: {
        totalUsers,
        todayUsers,
        yesterdayUsers,
        activeUsersToday,
        completedProfiles,
        uncompletedProfiles,
        totalEvents,
        todayEvents,
        totalExamsFinished,
        totalPracticesStarted,
        overallAvgScore: overallAvgScore || Number(cloudOv.overallAvgScore) || 0,
        examPassRate: examPassRate || Number(cloudOv.examPassRate) || 0,
      },
      wechatOfficial: d.wechatOfficialCache || null,
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
      return isExam && eventBelongsTo(e, user.id, user.openid)
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

    const events = d.events.filter((e) => eventBelongsTo(e, user.id, user.openid))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 30)

    const maxScore = exams.length > 0 ? Math.max(...exams.map(x => x.score)) : 0
    const totalScore = exams.reduce((s, x) => s + x.score, 0)
    const avgScore = exams.length > 0 ? Math.round(totalScore / exams.length) : 0
    const avgAccuracy = exams.length > 0 ? Math.round(exams.reduce((s, x) => s + x.accuracy, 0) / exams.length) : 0

    return {
      user: {
        ...user,
        isExamUnlocked: true,
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
    const list = d.events.filter((e) => e.eventType === 'finish_exam' && eventBelongsTo(e, userId, openid))
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

    // openid 和 id 分开索引。混在同一个 Map 里时，云端 id 可能撞上另一个人的 openid，把两个人并成一条。
    const byOpenid = new Map()
    const byId = new Map()
    d.users.forEach((u) => {
      if (u.openid) byOpenid.set(u.openid, u)
      if (u.id) byId.set(u.id, u)
    })

    cloudUsers.forEach((cu) => {
      if (!cu || typeof cu !== 'object') return
      const existing = (cu.openid && byOpenid.get(cu.openid)) || (cu.id && byId.get(cu.id)) || null
      let openid = cu.openid || (existing && existing.openid) || ''
      if (existing && existing.openid && openid && openid !== existing.openid) {
        const owner = byOpenid.get(openid)
        if (owner && owner !== existing) openid = existing.openid
      }
      let id = (existing && existing.id) || cu.id || `usr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      const idOwner = id && byId.get(id)
      if (idOwner && idOwner !== existing) {
        id = (existing && existing.id) || `usr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      }
      const cleaned = {
        id,
        openid,
        nickname: cu.nickname || (existing && existing.nickname) || '考生',
        realName: cu.realName || (existing && existing.realName) || '',
        className: cu.className || (existing && existing.className) || '',
        studentId: cu.studentId || (existing && existing.studentId) || '',
        phone: cu.phone || cu.displayPhone || (existing && existing.phone) || '',
        avatarText: cu.avatarText || (cu.realName ? cu.realName[0] : (existing && existing.avatarText) || '考'),
        avatarUrl: cu.avatarUrl || (existing && existing.avatarUrl) || '',
        isProfileCompleted: Boolean(cu.isProfileCompleted || (cu.realName && cu.className && (cu.phone || cu.displayPhone))),
        isExamUnlocked: true,
        examUnlockCode: cu.examUnlockCode || cu.boundCode || (existing && existing.examUnlockCode) || null,
        examUnlockedAt: cu.examUnlockedAt || cu.boundAt || (existing && existing.examUnlockedAt) || null,
        createdAt: cu.createdAt || (existing && existing.createdAt) || Date.now(),
        lastLoginAt: Math.max(Number(cu.lastLoginAt) || 0, Number(existing && existing.lastLoginAt) || 0) || Date.now(),
        loginCount: Math.max(Number(cu.loginCount) || 1, Number(existing && existing.loginCount) || 1),
        lastIp: cu.lastIp || (existing && existing.lastIp) || '',
        cloudExamCount: Math.max(Number(cu.examCount) || 0, Number(existing && existing.cloudExamCount) || 0),
        cloudMaxScore: Math.max(Number(cu.maxScore) || 0, Number(existing && existing.cloudMaxScore) || 0),
        cloudAvgScore: Number(cu.avgScore) || Number(existing && existing.cloudAvgScore) || 0,
        cloudAvgAccuracy: Number(cu.avgAccuracy) || Number(existing && existing.cloudAvgAccuracy) || 0,
        cloudPracticeCount: Math.max(Number(cu.practiceCount) || 0, Number(existing && existing.cloudPracticeCount) || 0),
      }

      if (existing) {
        const previousOpenid = existing.openid
        Object.assign(existing, cleaned)
        if (previousOpenid && previousOpenid !== existing.openid) byOpenid.delete(previousOpenid)
        if (existing.openid) byOpenid.set(existing.openid, existing)
        if (existing.id) byId.set(existing.id, existing)
      } else {
        d.users.push(cleaned)
        if (cleaned.openid) byOpenid.set(cleaned.openid, cleaned)
        if (cleaned.id) byId.set(cleaned.id, cleaned)
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

  /**
   * 完整合并线上云托管快照（含 overview、popularBanks、recentLogs、activationStats 及清理乱码题库）
   */
  importCloudSnapshot(cloudData = {}) {
    if (!cloudData || typeof cloudData !== 'object') return
    const d = loadDb()
    if (!Array.isArray(d.events)) d.events = []

    // 清理早期测试产生的乱码题库名称
    d.events.forEach((e) => {
      if (e && typeof e.bankTitle === 'string' && e.bankTitle.includes('??')) {
        e.bankTitle = '军事理论题库'
      }
    })

    const existingEventIds = new Set(d.events.map((e) => e.id))
    if (Array.isArray(cloudData.recentLogs)) {
      cloudData.recentLogs.forEach((ev) => {
        if (ev && ev.id && !existingEventIds.has(ev.id)) {
          d.events.push({
            id: ev.id,
            userId: ev.userId || '',
            openid: ev.openid || '',
            eventType: ev.eventType || 'page_view',
            bankId: ev.bankId || '',
            bankTitle: (ev.bankTitle && !String(ev.bankTitle).includes('??')) ? ev.bankTitle : '',
            score: typeof ev.score === 'number' ? ev.score : null,
            total: typeof ev.total === 'number' ? ev.total : null,
            meta: ev.meta || {},
            createdAt: ev.createdAt || Date.now(),
          })
          existingEventIds.add(ev.id)
        }
      })
    }

    d.cloudMetrics = {
      overview: cloudData.overview || (d.cloudMetrics && d.cloudMetrics.overview) || {},
      popularBanks: Array.isArray(cloudData.popularBanks)
        ? cloudData.popularBanks.filter((b) => b && b.title && !String(b.title).includes('??'))
        : ((d.cloudMetrics && d.cloudMetrics.popularBanks) || []),
      syncedAt: Date.now(),
    }

    saveDb()
  },

  /**
   * 缓存与读取微信官方 DataCube 核心指标
   */
  saveWechatOfficialCache(wxOfficial) {
    if (!wxOfficial || typeof wxOfficial !== 'object') return null
    const d = loadDb()
    d.wechatOfficialCache = {
      ...wxOfficial,
      cachedAt: Date.now(),
    }
    saveDb()
    return d.wechatOfficialCache
  },

  getWechatOfficialCache() {
    const d = loadDb()
    return d.wechatOfficialCache && typeof d.wechatOfficialCache === 'object' ? d.wechatOfficialCache : null
  },

  /**
   * 保存特定用户的专属课表数据
   */
  saveUserSchedule(userKey, scheduleData) {
    if (!userKey) return null
    const d = loadDb()
    if (!d.userSchedules || typeof d.userSchedules !== 'object') {
      d.userSchedules = {}
    }
    const cleanKey = String(userKey).trim()
    d.userSchedules[cleanKey] = {
      scheduleData,
      updatedAt: Date.now(),
    }
    saveDb()
    return d.userSchedules[cleanKey]
  },

  /**
   * 读取特定用户的专属课表数据
   */
  getUserSchedule(userKey) {
    if (!userKey) return null
    const d = loadDb()
    if (!d.userSchedules || typeof d.userSchedules !== 'object') return null
    const cleanKey = String(userKey).trim()
    return d.userSchedules[cleanKey] || null
  },

  // ───────────────────────── 2026 新生名单自动认证与严格校验 ─────────────────────────
  _freshmenCache: null,
  _loadFreshmenData() {
    if (this._freshmenCache) return this._freshmenCache
    try {
      const fPath = path.join(__dirname, 'data', 'freshmen_2026.json')
      if (fs.existsSync(fPath)) {
        this._freshmenCache = JSON.parse(fs.readFileSync(fPath, 'utf8'))
        return this._freshmenCache
      }
    } catch (e) {
      console.error('[DB] 加载 2026 新生名单异常:', e.message)
    }
    this._freshmenCache = { colleges: [], students: {} }
    return this._freshmenCache
  },

  lookupFreshman(studentId) {
    const sid = String(studentId || '').trim()
    if (!sid) return null
    const data = this._loadFreshmenData()
    return (data.students && data.students[sid]) || null
  },

  /**
   * 学号查询，可选带上姓名做一致性校验。
   * 姓名没传时保持原行为（直接返回新生档案）。
   * 姓名对不上时不返回档案，避免把同学的学院班级回给填错学号的人。
   */
  lookupFreshmanChecked(studentId, realName) {
    const student = this.lookupFreshman(studentId)
    if (!student) {
      return {
        found: false,
        nameMatched: false,
        fillMode: 'manual',
        student: null,
        message: '未在2026级新生名单中找到该学号。请核对学号；如果是大二、大三或大四，请手动填写学院、专业、班级和校区。',
      }
    }
    const provided = normalizeRealName(realName)
    if (!provided) {
      return {
        found: true,
        nameMatched: null,
        fillMode: 'roster',
        student,
        message: '已找到该学号。填写姓名后会再核对是不是你本人，并自动带出学院、专业、班级和校区。',
      }
    }
    if (normalizeRealName(student.realName) !== provided) {
      return {
        found: true,
        nameMatched: false,
        fillMode: 'roster',
        student: null,
        message: '这个学号已在2026级新生名单中，但和你填的姓名对不上。请核对学号和姓名，避免填成同学的学号。',
      }
    }
    return {
      found: true,
      nameMatched: true,
      fillMode: 'roster',
      student: {
        studentId: student.studentId,
        realName: student.realName,
        className: student.className,
        major: student.major || '',
        college: student.college || '',
        campus: student.campus || '',
        grade: student.grade || '2026级',
      },
      message: '已匹配到你的学院、专业、班级和校区',
    }
  },

  normalizeGradeInput(input, rosterGrade) {
    if (rosterGrade) return String(rosterGrade).trim()
    const text = String(input || '').trim()
    const aliases = {
      大一: '2026级',
      大二: '2025级',
      大三: '2024级',
      大四: '2023级',
    }
    return aliases[text] || text
  },

  _profileFormMeta: null,
  getProfileFormMeta() {
    if (this._profileFormMeta) return this._profileFormMeta
    const data = this._loadFreshmenData()
    const rosterColleges = Array.isArray(data.colleges) ? data.colleges : []
    const students = data.students && typeof data.students === 'object' ? data.students : {}

    const classPrefix = (name) => String(name || '').trim().replace(/(?:-\d+)?$/, '').replace(/\d+$/, '')
    const classGrade = (name) => {
      const matched = String(name || '').match(/(\d{2})\d?(?:-\d+)?$/)
      return matched ? `20${matched[1]}级` : ''
    }
    const gradeMeta = {
      '2026级': { label: '大一', fillMode: 'roster' },
      '2025级': { label: '大二', fillMode: 'manual' },
      '2024级': { label: '大三', fillMode: 'manual' },
      '2023级': { label: '大四', fillMode: 'manual' },
    }
    // 新生名单里没有的旧班名前缀，按专业简称归到现有学院，方便大二到大四手选。
    const extraPrefixCollege = {
      B酒店: '人文社会科学学院',
      F中文: '人文社会科学学院',
      Y中文: '人文社会科学学院',
      B日语: '外国语学院',
      Y翻译: '外国语学院',
      Y会计: '经济管理学院',
      Y国商: '经济管理学院',
      B信管: '经济管理学院',
      B物管: '经济管理学院',
      B电商: '经济管理学院',
      F国贸: '经济管理学院',
      Y信息: '信息工程学院、华为信息与网络技术学院、西伏河人工智能学院（合署）',
      Y化工: '化学化工学院、应急管理与安全工程学院（合署）',
      Y土木: '土木工程学院',
      Y工管: '土木工程学院',
      B建筑: '土木工程学院',
      B建能: '土木工程学院',
      B电建: '电气工程学院、新能源学院（合署）',
      Y机械: '机械工程学院、优集学院(合署)',
      B机械: '机械工程学院、优集学院(合署)',
      S机电: '机械工程学院、优集学院(合署)',
      Y智能: '机械工程学院、优集学院(合署)',
      Y交通: '材料科学与工程学院',
      Y材化: '材料科学与工程学院',
      Y材料: '材料科学与工程学院',
      Y纳米: '材料科学与工程学院',
      B材物: '材料科学与工程学院',
      Y环科: '环境科学与工程学院、卓越环保学院（合署）',
      Y资环: '环境科学与工程学院、卓越环保学院（合署）',
      Y生物: '海洋与生物工程学院',
      Y食品: '海洋与生物工程学院',
      B海洋: '海洋与生物工程学院',
      Y能动: '汽车工程学院、盐城悦达汽车学院（合署）',
      C车辆: '汽车工程学院、盐城悦达汽车学院（合署）',
      D汽车: '汽车工程学院、盐城悦达汽车学院（合署）',
      Y设艺: '设计艺术学院',
    }

    const prefixCollege = new Map()
    rosterColleges.forEach((item) => {
      ;(item.classes || []).forEach((cls) => {
        const prefix = classPrefix(cls)
        if (prefix && !prefixCollege.has(prefix)) prefixCollege.set(prefix, item.college)
      })
    })
    Object.keys(extraPrefixCollege).forEach((prefix) => {
      if (!prefixCollege.has(prefix)) prefixCollege.set(prefix, extraPrefixCollege[prefix])
    })

    let officialClasses = []
    try {
      const classFile = path.join(__dirname, 'tools', 'official_classes.json')
      if (fs.existsSync(classFile)) {
        const parsed = JSON.parse(fs.readFileSync(classFile, 'utf8'))
        if (Array.isArray(parsed)) officialClasses = parsed
      }
    } catch (err) {
      console.warn('[DB] 读取官方班级列表失败:', err.message)
    }

    const classesByCollege = new Map()
    const majorsByCollege = new Map()
    const ensureCollege = (college) => {
      if (!classesByCollege.has(college)) classesByCollege.set(college, new Set())
      if (!majorsByCollege.has(college)) majorsByCollege.set(college, new Set())
    }
    rosterColleges.forEach((item) => ensureCollege(item.college))

    const addClass = (college, cls) => {
      const name = String(cls || '').trim()
      if (!college || !name) return
      ensureCollege(college)
      classesByCollege.get(college).add(name)
    }
    rosterColleges.forEach((item) => {
      ;(item.classes || []).forEach((cls) => addClass(item.college, cls))
    })
    officialClasses.forEach((cls) => {
      const college = prefixCollege.get(classPrefix(cls))
      if (college) addClass(college, cls)
    })
    Object.values(students).forEach((student) => {
      if (!student || !student.college) return
      ensureCollege(student.college)
      if (student.major) majorsByCollege.get(student.college).add(student.major)
      if (student.className) addClass(student.college, student.className)
    })

    const campuses = new Set(['南校区', '北校区'])
    Object.values(students).forEach((student) => {
      if (student && student.campus) campuses.add(student.campus)
    })

    const colleges = rosterColleges.map((item) => {
      const classNames = Array.from(classesByCollege.get(item.college) || []).sort((a, b) => a.localeCompare(b, 'zh-CN'))
      const classesByGrade = {}
      classNames.forEach((cls) => {
        const grade = classGrade(cls) || '其他'
        if (!classesByGrade[grade]) classesByGrade[grade] = []
        classesByGrade[grade].push(cls)
      })
      return {
        college: item.college,
        majors: Array.from(majorsByCollege.get(item.college) || []).sort((a, b) => a.localeCompare(b, 'zh-CN')),
        classes: classNames,
        classesByGrade,
      }
    })

    const gradeSet = new Set(Object.keys(gradeMeta))
    colleges.forEach((item) => {
      Object.keys(item.classesByGrade).forEach((grade) => {
        if (grade && grade !== '其他') gradeSet.add(grade)
      })
    })
    const grades = Array.from(gradeSet)
      .sort((a, b) => b.localeCompare(a, 'zh-CN'))
      .map((grade) => ({
        grade,
        label: (gradeMeta[grade] && gradeMeta[grade].label) || grade,
        fillMode: (gradeMeta[grade] && gradeMeta[grade].fillMode) || 'manual',
      }))

    this._profileFormMeta = {
      colleges,
      campuses: Array.from(campuses),
      grades,
    }
    return this._profileFormMeta
  },

  getCollegesMeta() {
    return this.getProfileFormMeta().colleges
  },

  findProfileConflict({ phone, studentId, exceptUserId } = {}) {
    const d = loadDb()
    const sid = String(studentId || '').trim()
    const ph = String(phone || '').trim()
    const except = exceptUserId || ''
    const current = except ? d.users.find((u) => u.id === except) : null
    if (sid) {
      const currentSid = current ? String(current.studentId || '').trim() : ''
      if (sid !== currentSid) {
        const other = d.users.find((u) => u.id !== except && String(u.studentId || '').trim() === sid)
        if (other) {
          return { field: 'studentId', message: '该学号已绑定其他微信账号，请核对是否填错学号' }
        }
      }
    }
    if (ph) {
      const currentPhone = current ? String(current.phone || '').trim() : ''
      if (ph !== currentPhone) {
        const other = d.users.find((u) => u.id !== except && String(u.phone || '').trim() === ph)
        if (other) {
          return { field: 'phone', message: '该手机号已绑定其他微信账号，请核对是否填错手机号' }
        }
      }
    }
    return null
  },

  /**
   * 严格校验用户提交的姓名、学号、手机号、班级，拦截一切敷衍/伪造输入
   */
  validateProfileInput({ realName, phone, studentId, className, grade }) {
    const name = String(realName || '').trim()
    const ph = String(phone || '').trim()
    const sid = String(studentId || '').trim()
    const cls = String(className || '').trim()

    // 1. 姓名校验：必须为 2~10 位合法汉字（支持少数民族间隔号 ·），拦截“1”、“测试”、“张张张”
    const nameRegex = /^[\u4e00-\u9fa5]{2,6}(?:[·•][\u4e00-\u9fa5]{1,6})?$/
    const forbiddenNames = new Set(['测试', '学生', '姓名', '匿名', '未知', '管理员', '用户', '哈哈', '啊啊', '啦啦'])
    if (!nameRegex.test(name) || forbiddenNames.has(name) || /^(.)\1+$/.test(name)) {
      return { valid: false, message: '请输入真实的中文姓名（2~10个汉字，不可为数字、符号或无效测试词）' }
    }

    // 2. 学号校验：若填写则必须为 8~14 位有效数字，且若选择 2026 级大一则核对 2026 新生库
    if (sid) {
      if (!/^\d{8,14}$/.test(sid) || /^(\d)\1{6,}$/.test(sid)) {
        return { valid: false, message: '请输入正确的盐城工学院学号（如 260101011001）' }
      }
      if (grade === '2026级' || grade === '大一' || sid.startsWith('26')) {
        const matched = this.lookupFreshman(sid)
        if (matched && matched.realName && normalizeRealName(matched.realName) !== normalizeRealName(name)) {
          return {
            valid: false,
            message: '这个学号已在2026级新生名单中，但和你填的姓名对不上。请核对学号和姓名，避免填成同学的学号。',
          }
        }
      }
    }

    // 3. 班级校验
    if (!cls || cls.length < 2 || /^\d+$/.test(cls)) {
      return { valid: false, message: '请选择或填写正确的班级名称（如 B机制261）' }
    }

    // 4. 手机号严格校验：11位合法号段 + 拦截连号/豹子号（如 17811111111、13800000000、13812345678）
    if (!/^1[3-9]\d{9}$/.test(ph)) {
      return { valid: false, message: '请输入正确的 11 位手机号码' }
    }
    const tail8 = ph.slice(3)
    if (
      /(\d)\1{5,}/.test(ph) ||
      tail8 === '12345678' ||
      tail8 === '87654321' ||
      tail8 === '01234567' ||
      /^(\d\d)\1{3}$/.test(tail8)
    ) {
      return { valid: false, message: '检测到无效或伪造手机号码（如连续重复数字），请填写真实常用手机号' }
    }

    return { valid: true }
  },

  // ───────────────────────── 分题库三维排行榜（速度榜 / 正确率榜 / 勤奋榜） ─────────────────────────
  getBankLeaderboard(bankId = 'bank-junli', currentUserId = '', currentOpenid = '') {
    const d = loadDb()
    const cleanBankId = String(bankId || 'bank-junli').trim()

    const bankTitleAlias = {
      'bank-junli': ['军事理论', '军事理论题库'],
      'bank-sixiu': ['思想道德与法治', '思修'],
      'bank-jindaishi': ['中国近现代史纲要', '近代史'],
      'bank-mayuan': ['马克思主义基本原理', '马原'],
      'bank-maogai': ['毛泽东思想和中国特色社会主义理论体系概论', '毛概'],
      'bank-computer': ['大学计算机基础', '计算机基础'],
    }
    const allowedTitles = bankTitleAlias[cleanBankId] || []

    const matchBank = (ev) => {
      if (!ev) return false
      if (cleanBankId === 'all') return true
      if (ev.bankId && ev.bankId === cleanBankId) return true
      if (ev.bankTitle && allowedTitles.some(t => String(ev.bankTitle).includes(t))) return true
      return false
    }

    const userMap = new Map()
    d.users.forEach(u => {
      if (u.id) userMap.set(u.id, u)
      if (u.openid) userMap.set(u.openid, u)
    })

    // 解析耗时字符串（如 "04:18"、"4分18秒"、"8分钟"）为秒数
    const parseDurationSec = (rawDur) => {
      if (!rawDur) return null
      if (typeof rawDur === 'number' && rawDur > 0) return rawDur
      const s = String(rawDur).trim()
      const mmss = s.match(/^(\d{1,3}):(\d{1,2})$/)
      if (mmss) return parseInt(mmss[1], 10) * 60 + parseInt(mmss[2], 10)
      const cnMinSec = s.match(/(\d+)\s*分(?:钟)?\s*(\d+)?\s*秒?/)
      if (cnMinSec) {
        return parseInt(cnMinSec[1], 10) * 60 + (cnMinSec[2] ? parseInt(cnMinSec[2], 10) : 0)
      }
      const secOnly = s.match(/^(\d+)\s*秒$/)
      if (secOnly) return parseInt(secOnly[1], 10)
      return null
    }

    const formatDurationSec = (sec) => {
      const s = Math.max(1, Math.round(Number(sec) || 0))
      const m = Math.floor(s / 60)
      const rem = s % 60
      return m > 0 ? `${m}分${String(rem).padStart(2, '0')}秒` : `${rem}秒`
    }

    // 格式化用户排行榜显示名称（严格保护隐私，按用户选择的 rankDisplayMode 展示）
    const getDisplayName = (u, fallbackName = '') => {
      if (!u) return fallbackName || '盐工同学'
      const mode = u.rankDisplayMode || 'nickname'
      if (mode === 'realName' && u.realName) {
        return u.realName
      }
      if (u.nickname && !u.nickname.startsWith('微信用户_') && u.nickname !== '考生') {
        return u.nickname
      }
      if (u.realName) {
        return `${u.realName.charAt(0)}*同学`
      }
      return `盐工同学_${String(u.id || u.openid || '001').slice(-3)}`
    }

    const statsByUserKey = new Map()
    const ensureEntry = (u, rawKey) => {
      const key = (u && (u.id || u.openid)) || rawKey
      if (!key) return null
      if (!statsByUserKey.has(key)) {
        const displayName = getDisplayName(u)
        statsByUserKey.set(key, {
          userKey: key,
          userId: (u && u.id) || '',
          openid: (u && u.openid) || '',
          displayName,
          avatarChar: displayName.charAt(0) || '学',
          className: (u && u.className) || '盐工考生',
          college: (u && u.college) || '',
          examCount: 0,
          practiceCount: 0,
          totalDiligence: 0,
          bestScore: 0,
          bestAccuracy: 0,
          sumAccuracy: 0,
          bestPassDurationSec: null,
          bestPassScore: 0,
        })
      }
      return statsByUserKey.get(key)
    }

    d.events.forEach(ev => {
      if (!matchBank(ev)) return
      const u = (ev.userId && userMap.get(ev.userId)) || (ev.openid && userMap.get(ev.openid)) || null
      const entry = ensureEntry(u, ev.userId || ev.openid)
      if (!entry) return

      if (ev.eventType === 'finish_exam') {
        const total = ev.total && ev.total > 0 ? ev.total : 100
        const score = Number(ev.score) || 0
        const acc = Math.min(100, Math.round((score / total) * 100))
        entry.examCount++
        entry.totalDiligence++
        entry.sumAccuracy += acc
        if (score > entry.bestScore) entry.bestScore = score
        if (acc > entry.bestAccuracy) entry.bestAccuracy = acc

        // 及格（>=60%）计入速度榜候选
        if (acc >= 60) {
          const durSec = parseDurationSec(
            (ev.meta && (ev.meta.durationSeconds || ev.meta.duration)) || ev.duration
          )
          // 若历史记录未传秒数，按题量与得分给合理基准秒数
          const effectiveSec = durSec && durSec >= 15 ? durSec : Math.max(120, Math.round(total * 4.5 - score * 1.2))
          if (
            entry.bestPassDurationSec === null ||
            effectiveSec < entry.bestPassDurationSec ||
            (effectiveSec === entry.bestPassDurationSec && score > entry.bestPassScore)
          ) {
            entry.bestPassDurationSec = effectiveSec
            entry.bestPassScore = score
          }
        }
      } else if (ev.eventType === 'start_practice') {
        entry.practiceCount++
        entry.totalDiligence++
      }
    })

    // 补充云托管同步过来的考生练习次数（针对主库军事理论或全量榜）
    if (cleanBankId === 'bank-junli' || cleanBankId === 'all') {
      d.users.forEach(u => {
        const cPrac = Number(u.cloudPracticeCount) || 0
        const cExam = Number(u.cloudExamCount) || 0
        if (cPrac > 0 || cExam > 0) {
          const entry = ensureEntry(u, u.id || u.openid)
          if (entry) {
            entry.practiceCount = Math.max(entry.practiceCount, cPrac)
            entry.examCount = Math.max(entry.examCount, cExam)
            entry.totalDiligence = Math.max(entry.totalDiligence, entry.practiceCount + entry.examCount)
            if (entry.bestAccuracy === 0 && Number(u.cloudAvgAccuracy) > 0) {
              entry.bestAccuracy = Math.min(100, Number(u.cloudAvgAccuracy))
              entry.sumAccuracy = entry.bestAccuracy * Math.max(1, entry.examCount)
              entry.bestScore = Number(u.cloudMaxScore) || entry.bestAccuracy
            }
          }
        }
      })
    }

    const allEntries = Array.from(statsByUserKey.values())

    // 1. 速度榜：及格且耗时最短
    const speedRaw = allEntries
      .filter(x => x.bestPassDurationSec !== null)
      .sort((a, b) => {
        if (a.bestPassDurationSec !== b.bestPassDurationSec) {
          return a.bestPassDurationSec - b.bestPassDurationSec
        }
        return b.bestPassScore - a.bestPassScore
      })

    // 2. 正确率榜：平均正确率 -> 最高正确率 -> 考试次数
    const accuracyRaw = allEntries
      .filter(x => x.examCount > 0 && x.bestAccuracy > 0)
      .map(x => ({
        ...x,
        avgAccuracy: Math.min(100, Math.round(x.sumAccuracy / x.examCount)),
      }))
      .sort((a, b) => {
        if (b.avgAccuracy !== a.avgAccuracy) return b.avgAccuracy - a.avgAccuracy
        if (b.bestAccuracy !== a.bestAccuracy) return b.bestAccuracy - a.bestAccuracy
        return b.examCount - a.examCount
      })

    // 3. 勤奋榜：刷题总次数 + 模考次数
    const diligenceRaw = allEntries
      .filter(x => x.totalDiligence > 0)
      .sort((a, b) => {
        if (b.totalDiligence !== a.totalDiligence) return b.totalDiligence - a.totalDiligence
        return b.examCount - a.examCount
      })

    const isMe = (x) =>
      Boolean(
        (currentUserId && (x.userId === currentUserId || x.userKey === currentUserId)) ||
        (currentOpenid && (x.openid === currentOpenid || x.userKey === currentOpenid))
      )

    const findMyRank = (list) => {
      const idx = list.findIndex(isMe)
      return idx >= 0 ? idx + 1 : null
    }

    return {
      bankId: cleanBankId,
      speedList: speedRaw.slice(0, 50).map((x, i) => ({
        rank: i + 1,
        displayName: x.displayName,
        avatarChar: x.avatarChar,
        className: x.className,
        valueText: formatDurationSec(x.bestPassDurationSec),
        subText: `最高 ${x.bestPassScore} 分`,
        isMe: isMe(x),
      })),
      accuracyList: accuracyRaw.slice(0, 50).map((x, i) => ({
        rank: i + 1,
        displayName: x.displayName,
        avatarChar: x.avatarChar,
        className: x.className,
        valueText: `${x.avgAccuracy}%`,
        subText: `模考 ${x.examCount} 次 · 最高 ${x.bestScore} 分`,
        isMe: isMe(x),
      })),
      diligenceList: diligenceRaw.slice(0, 50).map((x, i) => ({
        rank: i + 1,
        displayName: x.displayName,
        avatarChar: x.avatarChar,
        className: x.className,
        valueText: `${x.totalDiligence} 次`,
        subText: `练习 ${x.practiceCount} 次 · 模考 ${x.examCount} 次`,
        isMe: isMe(x),
      })),
      myRanks: {
        speedRank: findMyRank(speedRaw),
        accuracyRank: findMyRank(accuracyRaw),
        diligenceRank: findMyRank(diligenceRaw),
      },
      updatedAt: Date.now(),
    }
  },

  // ───────────────────────── 宿舍电费监控与低电费预警存储 ─────────────────────────
  saveUserDorm(userKey, dormInfo = {}) {
    const cleanKey = String(userKey || '').trim()
    // dorm_ 开头是旧的按房间共用键，继续写入会让同寝室的人互相覆盖余额和预警。
    if (!cleanKey || cleanKey.startsWith('dorm_')) return null
    const d = loadDb()
    if (!d.userDorms || typeof d.userDorms !== 'object' || Array.isArray(d.userDorms)) d.userDorms = {}
    const prev = d.userDorms[cleanKey] || {}
    const prevOpenid = String(prev.openid || '').trim()
    const nextOpenid = dormInfo.openid ? String(dormInfo.openid).trim() : ''
    const samePerson = !prevOpenid || !nextOpenid || prevOpenid === nextOpenid
    d.userDorms[cleanKey] = {
      ...(samePerson ? prev : {}),
      ...dormInfo,
      userKey: cleanKey,
      updatedAt: Date.now(),
    }
    saveDb()
    return d.userDorms[cleanKey]
  },

  getUserDorm(userKey) {
    const cleanKey = String(userKey || '').trim()
    if (!cleanKey || cleanKey.startsWith('dorm_')) return null
    const d = loadDb()
    if (!d.userDorms || typeof d.userDorms !== 'object') return null
    return d.userDorms[cleanKey] || null
  },

  getAllUserDorms() {
    const d = loadDb()
    if (!d.userDorms || typeof d.userDorms !== 'object') return []
    return Object.values(d.userDorms)
  },

  // ───────────────────────── 反爬虫 IP 与微信账号封禁管理 ─────────────────────────
  checkSecurityBlock(ip, openid) {
    const d = loadDb()
    if (!Array.isArray(d.securityBlocks)) return { blocked: false }
    const hit = d.securityBlocks.find(
      b => (ip && b.type === 'ip' && b.value === ip) || (openid && b.type === 'openid' && b.value === openid)
    )
    if (hit) {
      return { blocked: true, reason: hit.reason || '已被安全策略封禁', item: hit }
    }
    return { blocked: false }
  },

  addSecurityBlock({ type = 'ip', value = '', reason = '' }) {
    const cleanVal = String(value || '').trim()
    if (!cleanVal) return null
    const d = loadDb()
    if (!Array.isArray(d.securityBlocks)) d.securityBlocks = []
    let existing = d.securityBlocks.find(b => b.type === type && b.value === cleanVal)
    if (!existing) {
      existing = {
        id: `blk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type,
        value: cleanVal,
        reason: reason || '管理员手动封禁',
        createdAt: Date.now(),
      }
      d.securityBlocks.unshift(existing)
      saveDb()
    }
    return existing
  },

  removeSecurityBlock(idOrValue) {
    const d = loadDb()
    if (!Array.isArray(d.securityBlocks)) return false
    const before = d.securityBlocks.length
    d.securityBlocks = d.securityBlocks.filter(b => b.id !== idOrValue && b.value !== idOrValue)
    if (d.securityBlocks.length !== before) {
      saveDb()
      return true
    }
    return false
  },

  getSecurityBlocks() {
    const d = loadDb()
    return Array.isArray(d.securityBlocks) ? d.securityBlocks : []
  },

  flushSync,
}

module.exports = db

