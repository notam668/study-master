/**
 * 上课提醒（微信订阅消息）
 * ------------------------------------------------------------
 * 业务流程：
 *   小程序端用户在课表页点击「上课提醒」→ 用户点击时调用 wx.requestSubscribeMessage 拿到授权
 *   → 上报 /api/reminder/grant（一次性模板次数 +1，长期模板不计数）
 *   → 服务端按班级课表 + 作息时间表算出每节课的开始时刻
 *   → 定时扫描（容器内 setInterval 或外部 cron 打 /api/reminder/cron）
 *   → 到点前 aheadMinutes 分钟调用 subscribeMessage.send 下发
 *
 * 三个容易踩的坑，这里都处理了：
 *   1. 时区：云托管容器 TZ 默认是 UTC，直接用 new Date() 算「今天第几节课」会整体偏 8 小时。
 *      所有日期时间一律走下面的 shParts / shDayStart，按配置时区（默认 +480 分钟）换算，
 *      完全不依赖容器本地时区，也不受 DST 影响（中国无夏令时）。
 *   2. 幂等：同一节课只发一次。以 openid + 课程开始时刻 + 模板 ID 为指纹，成功失败都落日志，
 *      容器重启/多实例并发都不会重复轰炸用户。
 *   3. 模板字段长度：thing 类型最多 20 个字符，超了微信直接报 47003，
 *      所以所有文本值统一走 truncate。
 */

const db = require('../db')
const config = require('../config')
const wxApi = require('./wxApiService')
const scheduleService = require('./scheduleService')

const MS_MINUTE = 60 * 1000
const MS_DAY = 24 * 60 * 60 * 1000

/** ------------------------------------------------------------ 时区工具 */

function tzOffsetMs() {
  // 配置里是「分钟」，默认 480 = UTC+8
  const minutes = Number.isFinite(config.timezoneOffsetMinutes) ? config.timezoneOffsetMinutes : 480
  return minutes * MS_MINUTE
}

/** 把真实时间戳换算成目标时区的"墙上时间"各字段 */
function shParts(ts) {
  const d = new Date(ts + tzOffsetMs())
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    date: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    // 0=周日 … 6=周六
    weekday: d.getUTCDay(),
  }
}

/** 目标时区当天 00:00 对应的真实时间戳 */
function shDayStart(ts) {
  const p = shParts(ts)
  return Date.UTC(p.year, p.month - 1, p.date, 0, 0, 0) - tzOffsetMs()
}

/** '2026-09-07' / '2026/09/07' → 该日 00:00 的真实时间戳；非法返回 null */
function parseDateToMs(text) {
  const m = String(text || '').trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return Date.UTC(y, mo - 1, d, 0, 0, 0) - tzOffsetMs()
}

/** 'HH:mm' / 'H:mm' → 距当天 00:00 的毫秒数；非法返回 null */
function parseTimeToMs(text) {
  const m = String(text || '').trim().match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/)
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null
  return (h * 60 + mi) * MS_MINUTE
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n)
}

/** 时间戳 → 'YYYY-MM-DD HH:mm'（目标时区） */
function formatDateTime(ts) {
  if (!ts) return ''
  const p = shParts(ts)
  return `${p.year}-${pad2(p.month)}-${pad2(p.date)} ${pad2(p.hour)}:${pad2(p.minute)}`
}

/** 时间戳 → 'HH:mm'（目标时区） */
function formatHm(ts) {
  if (!ts) return ''
  const p = shParts(ts)
  return `${pad2(p.hour)}:${pad2(p.minute)}`
}

/** 时间戳 → 'M月D日 周X'（目标时区） */
function formatDayLabel(ts) {
  const p = shParts(ts)
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return `${p.month}月${p.date}日 ${names[p.weekday]}`
}

/** 仅用于展示的"今天/明天"前缀 */
function relativeDayLabel(ts, now = Date.now()) {
  const diff = Math.round((shDayStart(ts) - shDayStart(now)) / MS_DAY)
  if (diff === 0) return '今天'
  if (diff === 1) return '明天'
  if (diff === 2) return '后天'
  if (diff === -1) return '昨天'
  return formatDayLabel(ts)
}

/** ------------------------------------------------------------ 默认配置 */

const DEFAULT_PERIODS = [
  { startPeriod: 1, endPeriod: 2, start: '08:00', end: '09:40' },
  { startPeriod: 3, endPeriod: 4, start: '10:00', end: '11:40' },
  { startPeriod: 5, endPeriod: 6, start: '14:00', end: '15:40' },
  { startPeriod: 7, endPeriod: 8, start: '16:00', end: '17:40' },
  { startPeriod: 9, endPeriod: 10, start: '19:00', end: '20:35' },
]

const DEFAULT_FIELDS = {
  course: 'thing5',
  time: 'time3',
  location: 'thing2',
  teacher: 'thing4',
  remark: 'thing5',
}

const DEFAULT_CONFIG = {
  enabled: true,
  templateId: config.wxReminderTemplateId || '',
  templateType: 'once', // long = 长期订阅（教育政务等专属类目） | once = 一次性订阅（大部分通用类目，每次授权下发一次）
  miniprogramState: 'formal', // formal | trial | developer
  page: 'pages/schedule/schedule',
  aheadMinutes: 30,
  termStartDate: '2026-09-07',
  maxWeek: 19,
  periods: DEFAULT_PERIODS,
  fields: DEFAULT_FIELDS,
  // 模板实际声明的字段：地点(thing2)、时间(time3)、课程(thing5)、教师(thing4)
  templateFieldCodes: ['thing2', 'time3', 'thing5', 'thing4'],
  remarkTemplate: '记得提前到教室，别迟到啦～',
  // true = time 字段发 "14:00~15:40" 完整时段（微信上课提醒模板的官方示例就是这种格式）
  timeFieldRange: true,
  dailyLimitPerUser: 8,
  onlyForEnabledUsers: true,
}

/** ------------------------------------------------------------ 配置读写 */

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base }
  if (!patch || typeof patch !== 'object') return out
  Object.keys(patch).forEach((k) => {
    if (patch[k] === undefined) return
    if (
      patch[k] &&
      typeof patch[k] === 'object' &&
      !Array.isArray(patch[k]) &&
      base &&
      typeof base[k] === 'object' &&
      !Array.isArray(base[k])
    ) {
      out[k] = deepMerge(base[k], patch[k])
    } else {
      out[k] = patch[k]
    }
  })
  return out
}

function normalizeAheadMinutes(value, fallback = 30) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.round(n), 1), 24 * 60)
}

function normalizePeriods(input) {
  if (!Array.isArray(input)) return DEFAULT_PERIODS.slice()
  const cleaned = input
    .map((p) => {
      const startPeriod = Number(p && p.startPeriod)
      const endPeriod = Number(p && p.endPeriod)
      const startMs = parseTimeToMs(p && p.start)
      const endMs = parseTimeToMs(p && p.end)
      if (!Number.isFinite(startPeriod) || startMs === null) return null
      return {
        startPeriod,
        endPeriod: Number.isFinite(endPeriod) && endPeriod >= startPeriod ? endPeriod : startPeriod + 1,
        start: p.start,
        end: endMs === null ? '' : p.end,
        startMs,
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.startPeriod - b.startPeriod)

  if (cleaned.length === 0) return DEFAULT_PERIODS.slice()
  return cleaned.map((p) => ({ startPeriod: p.startPeriod, endPeriod: p.endPeriod, start: p.start, end: p.end }))
}

function normalizeFields(input) {
  const out = { ...DEFAULT_FIELDS }
  if (input && typeof input === 'object') {
    Object.keys(DEFAULT_FIELDS).forEach((k) => {
      const v = input[k]
      if (typeof v === 'string' && /^[a-zA-Z0-9_]{2,32}$/.test(v.trim())) {
        out[k] = v.trim()
      } else if (v === '' || v === null) {
        out[k] = '' // 允许显式置空：该模板没有这个字段
      }
    })
  }
  return out
}

/** 读取生效配置（默认值 + 后台保存值的深合并） */
function getEffectiveConfig() {
  const stored = db.getReminderConfig()
  const cfg = deepMerge(DEFAULT_CONFIG, stored || {})
  cfg.aheadMinutes = normalizeAheadMinutes(cfg.aheadMinutes, DEFAULT_CONFIG.aheadMinutes)
  cfg.periods = normalizePeriods(cfg.periods)
  cfg.fields = normalizeFields(cfg.fields)
  cfg.templateFieldCodes = Array.isArray(cfg.templateFieldCodes)
    ? cfg.templateFieldCodes.filter((c) => typeof c === 'string' && /^[a-zA-Z0-9_]{2,32}$/.test(c))
    : []
  cfg.maxWeek = Math.min(Math.max(Number(cfg.maxWeek) || DEFAULT_CONFIG.maxWeek, 1), 40)
  cfg.dailyLimitPerUser = Math.min(Math.max(Number(cfg.dailyLimitPerUser) || DEFAULT_CONFIG.dailyLimitPerUser, 0), 50)
  if (!parseDateToMs(cfg.termStartDate)) cfg.termStartDate = DEFAULT_CONFIG.termStartDate
  if (!['long', 'once'].includes(cfg.templateType)) cfg.templateType = DEFAULT_CONFIG.templateType
  if (!['formal', 'trial', 'developer'].includes(cfg.miniprogramState)) {
    cfg.miniprogramState = DEFAULT_CONFIG.miniprogramState
  }
  return cfg
}

/** 清洗后台提交的配置 */
function sanitizeConfig(input, current) {
  const base = current || getEffectiveConfig()
  const src = input && typeof input === 'object' ? input : {}
  const next = deepMerge(base, {
    enabled: src.enabled === undefined ? base.enabled : Boolean(src.enabled),
    templateId: src.templateId === undefined ? base.templateId : String(src.templateId).trim(),
    templateType: src.templateType === undefined ? base.templateType : src.templateType,
    miniprogramState: src.miniprogramState === undefined ? base.miniprogramState : src.miniprogramState,
    page: src.page === undefined ? base.page : String(src.page).trim().replace(/^\//, ''),
    aheadMinutes: src.aheadMinutes === undefined ? base.aheadMinutes : normalizeAheadMinutes(src.aheadMinutes),
    termStartDate: src.termStartDate === undefined ? base.termStartDate : String(src.termStartDate).trim(),
    maxWeek: src.maxWeek === undefined ? base.maxWeek : src.maxWeek,
    periods: src.periods === undefined ? base.periods : normalizePeriods(src.periods),
    fields: src.fields === undefined ? base.fields : normalizeFields(src.fields),
    templateFieldCodes:
      src.templateFieldCodes === undefined
        ? base.templateFieldCodes
        : (Array.isArray(src.templateFieldCodes) ? src.templateFieldCodes : [])
            .map((c) => String(c || '').trim())
            .filter((c) => /^[a-zA-Z0-9_]{2,32}$/.test(c)),
    remarkTemplate: src.remarkTemplate === undefined ? base.remarkTemplate : String(src.remarkTemplate).slice(0, 60),
    timeFieldRange: src.timeFieldRange === undefined ? base.timeFieldRange : Boolean(src.timeFieldRange),
    dailyLimitPerUser:
      src.dailyLimitPerUser === undefined ? base.dailyLimitPerUser : src.dailyLimitPerUser,
  })

  if (!parseDateToMs(next.termStartDate)) {
    const err = new Error('学期开始日期格式不正确，应为 2026-09-07 这样的格式')
    err.code = 400
    throw err
  }
  if (next.templateId && !/^[A-Za-z0-9_-]{10,64}$/.test(next.templateId)) {
    const err = new Error('模板 ID 看起来不正确（应为字母数字组合，通常 40 位左右）')
    err.code = 400
    throw err
  }
  if (!['long', 'once'].includes(next.templateType)) next.templateType = 'long'
  if (!['formal', 'trial', 'developer'].includes(next.miniprogramState)) next.miniprogramState = 'formal'
  return next
}

/** ------------------------------------------------------------ 课表计算 */

/** 单双周 / 周次区间判断 */
function weekMatches(weeks, week) {
  if (!weeks) return false
  const segments = Array.isArray(weeks.segments) ? weeks.segments : []
  const inAny = segments.some((s) => week >= Number(s.start) && week <= Number(s.end))
  if (!inAny) return false
  if (weeks.parity === 'odd' && week % 2 === 0) return false
  if (weeks.parity === 'even' && week % 2 !== 0) return false
  return true
}

function findPeriodStart(startPeriod, periods) {
  const list = periods || DEFAULT_PERIODS
  const exact = list.find((p) => Number(p.startPeriod) === Number(startPeriod))
  if (exact) return exact.start
  const covering = list.find(
    (p) => Number(startPeriod) >= Number(p.startPeriod) && Number(startPeriod) <= Number(p.endPeriod)
  )
  if (covering) return covering.start
  const next = list.find((p) => Number(p.startPeriod) > Number(startPeriod))
  return next ? next.start : ''
}

/**
 * 找出第 endPeriod 节的下课时刻。
 * 注意别写成「找第 endPeriod+1 节的开始时间」—— 那样 7-8 节的结束会错算成 19:00（第9节开始），
 * 正确值是作息表里 7-8 大节的 end（17:40）。
 */
function findPeriodEnd(endPeriod, periods) {
  const list = periods || DEFAULT_PERIODS
  const covering = list.find(
    (p) => Number(endPeriod) >= Number(p.startPeriod) && Number(endPeriod) <= Number(p.endPeriod)
  )
  if (covering && covering.end) return covering.end
  const next = list.find((p) => Number(p.startPeriod) > Number(endPeriod))
  return next ? next.start : ''
}

/**
 * 算出某个班级在"某一时刻所在的那一天"要上的所有课（含开始/结束时刻与周次）
 * @returns {Array} [{ courseName, teacher, location, day, startPeriod, endPeriod, week, startAt, endAt, rawWeeks }]
 */
function getLessonsOnDay(className, dateTs, cfg = null) {
  const conf = cfg || getEffectiveConfig()
  const result = scheduleService.getScheduleByClass(className)
  if (!result || !result.matched || !result.classInfo) return []
  if (!Array.isArray(result.classInfo.courses)) return []

  const termStart = parseDateToMs(conf.termStartDate)
  if (termStart === null) return []

  const dayStart = shDayStart(dateTs)
  const diffDays = Math.round((dayStart - termStart) / MS_DAY)
  // 学期开始日可能不是周一，换算成以周一为第 0 天的偏移，保证周次口径与课表一致
  const startWeekday = shParts(termStart).weekday // 0=周日
  const mondayOffset = (startWeekday + 6) % 7
  const week = Math.floor((diffDays + mondayOffset) / 7) + 1
  if (week < 1) return []

  const parts = shParts(dateTs)
  const day = parts.weekday === 0 ? 7 : parts.weekday // 1=周一 … 7=周日
  if (week > conf.maxWeek) return []

  const lessons = []
  result.classInfo.courses.forEach((course) => {
    const sessions = Array.isArray(course.sessions) ? course.sessions : []
    sessions.forEach((s) => {
      if (Number(s.day) !== day) return
      if (!weekMatches(s.weeks, week)) return
      const startHm = findPeriodStart(s.startPeriod, conf.periods)
      if (!startHm) return
      const startOfDay = parseTimeToMs(startHm)
      const endPeriod = Number(s.endPeriod) || Number(s.startPeriod)
      const endHm = findPeriodEnd(endPeriod, conf.periods)
      const endOfDay = endHm ? parseTimeToMs(endHm) : null
      lessons.push({
        courseName: course.courseName || '未命名课程',
        teacher: Array.isArray(course.teachers) ? course.teachers.join('、') : String(course.teachers || ''),
        location: s.location || course.location || '',
        day,
        startPeriod: Number(s.startPeriod),
        endPeriod,
        week,
        startAt: dayStart + startOfDay,
        endAt: endOfDay === null ? null : dayStart + endOfDay,
        endText: endHm || '',
        timeText: endHm ? `${startHm}~${endHm}` : startHm,
        rawWeeks: (s.weeks && s.weeks.raw) || '',
      })
    })
  })

  lessons.sort((a, b) => a.startAt - b.startAt)
  return lessons
}

/** 取"下一节课"：从 now 往后最多找 lookaheadDays 天 */
function getNextLesson(className, now = Date.now(), lookaheadDays = 14) {
  const cfg = getEffectiveConfig()
  for (let i = 0; i < lookaheadDays; i++) {
    const ts = shDayStart(now) + i * MS_DAY + 12 * 60 * MS_MINUTE // 取当天正午，避开边界
    const lessons = getLessonsOnDay(className, ts, cfg)
    const upcoming = lessons.find((l) => l.startAt > now)
    if (upcoming) return upcoming
  }
  return null
}

/** ------------------------------------------------------------ 模板数据 */

/** thing 类型最多 20 字符；空值用兜底文案，否则微信会报 data format error */
function truncate(text, max = 20, fallback = '') {
  const s = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim()
  if (!s) return fallback
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function renderRemark(template, lesson, aheadMinutes) {
  const raw = String(template || '')
  if (!raw) return ''
  return raw
    .replace(/\{course\}/g, lesson.courseName)
    .replace(/\{location\}/g, lesson.location || '教室待定')
    .replace(/\{teacher\}/g, lesson.teacher || '')
    .replace(/\{time\}/g, formatHm(lesson.startAt))
    .replace(/\{period\}/g, `第${lesson.startPeriod}-${lesson.endPeriod}节`)
    .replace(/\{ahead\}/g, String(aheadMinutes))
}

let templateCache = null
let templateCacheFetchedAt = 0

async function fetchAndCacheTemplates(force = false) {
  if (!force && templateCacheFetchedAt > 0 && Date.now() - templateCacheFetchedAt < 15 * 60 * 1000) {
    return templateCache || []
  }
  templateCacheFetchedAt = Date.now()
  try {
    const list = await wxApi.getTemplateList()
    if (Array.isArray(list) && list.length > 0) {
      templateCache = list
      return list
    }
  } catch (err) {
    console.warn('[Reminder] 拉取微信模板列表失败，将使用智能兜底映射并冷却15分钟:', err.message)
  }
  return templateCache || []
}

function formatWechatTime(lesson) {
  const ts = lesson && lesson.startAt ? lesson.startAt : Date.now()
  const p = shParts(ts)
  return `${p.year}年${pad2(p.month)}月${pad2(p.date)}日 ${pad2(p.hour)}:${pad2(p.minute)}`
}

function matchFieldValue(fieldDef, lesson, aheadMinutes, cfg) {
  const code = (fieldDef.code || '').toLowerCase()
  const label = (fieldDef.label || '').trim()

  // 1. 中文语义优先精准匹配（必须先匹配 地点/时间/教师，避免"上课地点/上课时间/授课教师"被"课"字误伤！）
  if (/地|室|房|楼|校区|址|所/.test(label)) {
    return truncate(lesson.location, 20, '教室待定')
  }
  if (/时|期|日|分|段/.test(label)) {
    return lesson.timeText || formatHm(lesson.startAt)
  }
  if (/师|教|讲/.test(label)) {
    return truncate(lesson.teacher, 20, '详见课表')
  }
  if (/提|示|备|注|说|温|内容/.test(label)) {
    return truncate(renderRemark(cfg.remarkTemplate, lesson, aheadMinutes), 20, '记得准时上课')
  }
  if (/课|名|目|学科|专业/.test(label)) {
    return truncate(lesson.courseName, 20, '课程')
  }

  // 2. 字段代码惯例匹配（对准当前模板的真实定义）
  if (code === 'thing2') return truncate(lesson.location, 20, '教室待定')
  if (code === 'time3') return lesson.timeText || formatHm(lesson.startAt)
  if (code === 'thing5') return truncate(lesson.courseName, 20, '课程')
  if (code === 'thing4') return truncate(lesson.teacher, 20, '详见课表')
  if (code === 'thing1') return truncate(lesson.courseName, 20, '课程')
  if (code === 'thing3') return truncate(lesson.location, 20, '教室待定')
  if (code.startsWith('time')) return lesson.timeText || formatHm(lesson.startAt)

  return truncate(lesson.courseName, 20, '上课提醒')
}

/**
 * 组装订阅消息 data
 * 优先采用从微信拉取的真实模板字段结构进行智能语义匹配，确保 100% 格式满足要求且不遗漏
 *
 * @returns {{ data:object, missing:string[] }}
 */
function buildTemplateData(cfg, lesson, aheadMinutes, parsedFields = null) {
  const fields =
    parsedFields ||
    (templateCache && templateCache.find((t) => t.templateId === cfg.templateId)?.fields)

  if (Array.isArray(fields) && fields.length > 0) {
    const data = {}
    const missing = []
    fields.forEach((f) => {
      const val = matchFieldValue(f, lesson, aheadMinutes, cfg)
      if (val) {
        data[f.code] = { value: val }
      } else {
        missing.push(f.code)
      }
    })
    return { data, missing }
  }

  // 静态兜底映射（严格对准模板真实字段：地点thing2, 时间time3, 课程thing5, 教师thing4）
  const timeValue = lesson.timeText || formatHm(lesson.startAt)
  const course = truncate(lesson.courseName, 20, '课程')
  const location = truncate(lesson.location, 20, '教室待定')
  const teacher = truncate(lesson.teacher, 20, '详见课表')
  const remark = truncate(renderRemark(cfg.remarkTemplate, lesson, aheadMinutes), 20, '记得准时上课')

  const fallbackData = {
    thing2: { value: location },
    time3: { value: timeValue },
    thing5: { value: course },
    thing4: { value: teacher },
    thing1: { value: course },
    thing3: { value: location },
    time2: { value: timeValue },
  }

  const declared = Array.isArray(cfg.templateFieldCodes) ? cfg.templateFieldCodes : []
  const data = {}
  if (declared.length > 0) {
    declared.forEach((c) => {
      if (fallbackData[c]) data[c] = fallbackData[c]
    })
  } else {
    data.thing2 = { value: location }
    data.time3 = { value: timeValue }
    data.thing5 = { value: course }
    data.thing4 = { value: teacher }
  }

  return { data, missing: [] }
}

/** ------------------------------------------------------------ 扫描与下发 */

let scanRunning = false
let lastScan = null

function isMockOpenid(openid) {
  return !openid || /^(mock_wx_|wx_dev_|wx_cloud_|local_)/.test(openid)
}

/**
 * 扫描一轮并下发到点的提醒
 * @param {object} options
 *   now      指定"当前时间"（测试用）
 *   dryRun   只算不发
 *   openid   只处理某个用户（测试用）
 *   force    忽略 enabled 总开关（手动测试用）
 */
async function scanOnce(options = {}) {
  if (scanRunning) {
    return { skipped: true, reason: '上一轮扫描尚未结束' }
  }
  scanRunning = true

  const now = Number(options.now) || Date.now()
  const cfg = getEffectiveConfig()
  const result = {
    now,
    nowText: formatDateTime(now),
    dryRun: Boolean(options.dryRun),
    totalSubscriptions: 0,
    checked: 0,
    due: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    details: [],
    reason: '',
  }

  try {
    if (!cfg.enabled && !options.force) {
      result.reason = '总开关已关闭'
      return result
    }
    if (!cfg.templateId) {
      result.reason = '尚未配置订阅消息模板 ID'
      return result
    }

    const templates = await fetchAndCacheTemplates()
    const currentTmpl = templates && templates.find((t) => t.templateId === cfg.templateId)
    const tmplFields = currentTmpl ? currentTmpl.fields : null

    let subs = db.getReminders()
    if (options.openid) subs = subs.filter((s) => s.openid === options.openid)
    else if (cfg.onlyForEnabledUsers) subs = subs.filter((s) => s.enabled)
    result.totalSubscriptions = subs.length

    const dayStart = shDayStart(now)
    const dayEnd = dayStart + MS_DAY

    for (const sub of subs) {
      let className = (sub.className || '').trim()
      if (!className) {
        const u = db.getUserByOpenid(sub.openid)
        if (u && u.className) {
          className = u.className.trim()
          sub.className = className
          try { db.upsertReminder(sub.openid, { className }) } catch (_) {}
        }
      }
      if (!className) continue
      result.checked++

      const ahead = normalizeAheadMinutes(
        Number.isFinite(sub.aheadMinutes) && sub.aheadMinutes !== null ? sub.aheadMinutes : cfg.aheadMinutes,
        cfg.aheadMinutes
      )

      let lessons = []
      try {
        lessons = getLessonsOnDay(className, now, cfg)
      } catch (err) {
        result.details.push({ openid: sub.openid, status: 'error', reason: `课表读取失败: ${err.message}` })
        continue
      }

      for (const lesson of lessons) {
        const remindAt = lesson.startAt - ahead * MS_MINUTE
        // 到点窗口：已到提醒时刻，且课还没开始（容器重启后可补发，但不追发已开课的）
        if (!(now >= remindAt && now < lesson.startAt)) continue

        result.due++

        const fingerprintHit = db.hasReminderLogFor(sub.openid, lesson.startAt, cfg.templateId)
        if (fingerprintHit) {
          result.skipped++
          continue
        }

        const baseLog = {
          openid: sub.openid,
          userId: sub.userId || '',
          className,
          courseName: lesson.courseName,
          location: lesson.location,
          startAt: lesson.startAt,
          remindAt,
          templateId: cfg.templateId,
        }

        // 一次性订阅模板需要消耗授权次数
        if (cfg.templateType === 'once' && Number(sub.quota || 0) <= 0) {
          result.skipped++
          if (!options.dryRun) {
            db.addReminderLog({ ...baseLog, status: 'skipped', reason: '订阅次数已用尽，用户需再次授权' })
          }
          result.details.push({
            openid: sub.openid,
            courseName: lesson.courseName,
            startAtText: formatDateTime(lesson.startAt),
            status: 'skipped',
            reason: '订阅次数已用尽',
          })
          continue
        }

        // 每日上限保护，防止配置错误导致用户被刷屏
        if (cfg.dailyLimitPerUser > 0) {
          const sentToday = db.countReminderSentBetween(sub.openid, dayStart, dayEnd)
          if (sentToday >= cfg.dailyLimitPerUser) {
            result.skipped++
            if (!options.dryRun) {
              db.addReminderLog({ ...baseLog, status: 'skipped', reason: `已达每日上限 ${cfg.dailyLimitPerUser} 条` })
            }
            continue
          }
        }

        const { data, missing } = buildTemplateData(cfg, lesson, ahead, tmplFields)
        if (Object.keys(data).length === 0) {
          result.failed++
          if (!options.dryRun) {
            db.addReminderLog({ ...baseLog, status: 'failed', reason: '模板字段全部为空' })
          }
          continue
        }

        if (options.dryRun) {
          result.details.push({
            openid: sub.openid,
            className: sub.className,
            courseName: lesson.courseName,
            startAtText: formatDateTime(lesson.startAt),
            remindAtText: formatDateTime(remindAt),
            status: 'dry-run',
            data,
            missing,
          })
          continue
        }

        // 本地 mock 的 openid 不可能下发成功，跳过以避免刷失败日志
        if (isMockOpenid(sub.openid) && !options.force) {
          result.skipped++
          result.details.push({
            openid: sub.openid,
            status: 'skipped',
            reason: '本地模拟 openid，跳过下发',
          })
          continue
        }

        let sendResult
        try {
          sendResult = await wxApi.sendSubscribeMessage({
            openid: sub.openid,
            templateId: cfg.templateId,
            data,
            page: cfg.page,
            miniprogramState: cfg.miniprogramState,
          })
        } catch (err) {
          sendResult = { ok: false, errcode: -1, errmsg: err.message }
        }

        if (sendResult.ok) {
          result.sent++
          db.addReminderLog({ ...baseLog, status: 'sent', errcode: 0, errmsg: '' })
          db.upsertReminder(sub.openid, {
            lastSentAt: Date.now(),
            sentCount: Number(sub.sentCount || 0) + 1,
            quotaDelta: cfg.templateType === 'once' ? -1 : 0,
          })
          result.details.push({
            openid: sub.openid,
            courseName: lesson.courseName,
            startAtText: formatDateTime(lesson.startAt),
            status: 'sent',
          })
        } else {
          result.failed++
          db.addReminderLog({
            ...baseLog,
            status: 'failed',
            errcode: sendResult.errcode,
            errmsg: sendResult.errmsg,
            reason: friendlyErr(sendResult.errcode),
          })
          result.details.push({
            openid: sub.openid,
            courseName: lesson.courseName,
            status: 'failed',
            errcode: sendResult.errcode,
            errmsg: sendResult.errmsg,
          })
        }
      }
    }

    lastScan = { ...result, finishedAt: Date.now() }
    return result
  } finally {
    scanRunning = false
  }
}

/** 把微信错误码翻译成人话，方便在管理台直接看懂 */
function friendlyErr(errcode) {
  const map = {
    40003: 'openid 不正确（用户可能未关注/非本小程序用户）',
    40037: '模板 ID 无效',
    43101: '用户拒绝接收该消息（需重新引导授权）',
    47003: '模板参数不满足格式要求（多为字段长度或类型不符）',
    41030: 'page 路径不正确',
    40001: 'access_token 无效，已自动刷新重试仍失败',
    45009: '接口调用频率超限',
    45011: '接口调用频率超限（限频较严）',
  }
  return map[Number(errcode)] || ''
}

/** ------------------------------------------------------------ 定时调度 */

let schedulerTimer = null
let bootTimer = null

function startScheduler() {
  if (schedulerTimer) return false
  if (!config.enableReminderScheduler) {
    console.log('[Reminder] 容器内定时扫描已关闭（ENABLE_REMINDER_SCHEDULER=0），请用外部定时任务打 /api/reminder/cron')
    return false
  }
  // 每 30 秒扫一次：比起 1 分钟，边界更不容易漏（同一节课有 fingerprint 兜底，不会重复发）
  schedulerTimer = setInterval(() => {
    scanOnce().catch((err) => console.error('[Reminder] 定时扫描异常:', err.message))
  }, 30 * 1000)
  if (schedulerTimer.unref) schedulerTimer.unref()

  // 启动 20 秒后先跑一次，覆盖"容器刚启动/重启"的补发场景
  bootTimer = setTimeout(() => {
    scanOnce().catch((err) => console.error('[Reminder] 启动扫描异常:', err.message))
  }, 20 * 1000)
  if (bootTimer.unref) bootTimer.unref()

  console.log('[Reminder] 上课提醒定时扫描已启动（每 30 秒一轮）')
  return true
}

function stopScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer)
  if (bootTimer) clearTimeout(bootTimer)
  schedulerTimer = null
  bootTimer = null
}

function getRuntimeStatus() {
  return {
    schedulerRunning: Boolean(schedulerTimer),
    scanRunning,
    lastScan: lastScan
      ? {
          nowText: lastScan.nowText,
          finishedAt: lastScan.finishedAt,
          totalSubscriptions: lastScan.totalSubscriptions,
          checked: lastScan.checked,
          due: lastScan.due,
          sent: lastScan.sent,
          failed: lastScan.failed,
          skipped: lastScan.skipped,
          reason: lastScan.reason,
        }
      : null,
  }
}

/** ------------------------------------------------------------ 面向小程序端的状态 */

/**
 * 返回某个用户在小程序端需要的提醒状态
 */
function getPublicState(openid, now = Date.now(), customClassName = '') {
  const cfg = getEffectiveConfig()
  const sub = openid ? db.getReminderByOpenid(openid) : null
  const user = openid ? db.getUserByOpenid(openid) : null
  const className = customClassName || (sub && sub.className) || (user && user.className) || ''

  let nextLesson = null
  let nextRemindAt = null
  if (className && cfg.enabled) {
    try {
      nextLesson = getNextLesson(className, now)
      if (nextLesson) {
        const ahead = normalizeAheadMinutes(
          sub && sub.aheadMinutes !== null && sub.aheadMinutes !== undefined ? sub.aheadMinutes : cfg.aheadMinutes,
          cfg.aheadMinutes
        )
        nextRemindAt = nextLesson.startAt - ahead * MS_MINUTE
      }
    } catch (err) {
      console.warn('[Reminder] 计算下节课失败:', err.message)
    }
  }

  const aheadMinutes = normalizeAheadMinutes(
    sub && sub.aheadMinutes !== null && sub.aheadMinutes !== undefined ? sub.aheadMinutes : cfg.aheadMinutes,
    cfg.aheadMinutes
  )

  return {
    serverTime: now,
    serverTimeText: formatDateTime(now),
    available: Boolean(cfg.templateId) && cfg.enabled,
    unavailableReason: !cfg.enabled ? '管理员已暂停上课提醒' : !cfg.templateId ? '管理员尚未配置订阅消息模板' : '',
    // 模板 ID 必须下发给小程序：wx.requestSubscribeMessage 要用它发起授权
    templateId: cfg.templateId,
    templateType: cfg.templateType,
    aheadMinutes,
    defaultAheadMinutes: cfg.aheadMinutes,
    enabled: Boolean(sub && sub.enabled),
    quota: cfg.templateType === 'once' ? Number((sub && sub.quota) || 0) : -1,
    unlimited: cfg.templateType === 'long',
    subscribeCount: Number((sub && sub.subscribeCount) || 0),
    sentCount: Number((sub && sub.sentCount) || 0),
    className,
    lastSentAt: (sub && sub.lastSentAt) || null,
    nextLesson: nextLesson
      ? {
          courseName: nextLesson.courseName,
          location: nextLesson.location,
          teacher: nextLesson.teacher,
          startAt: nextLesson.startAt,
          startText: formatDateTime(nextLesson.startAt),
          timeText: nextLesson.timeText || formatHm(nextLesson.startAt),
          dayLabel: relativeDayLabel(nextLesson.startAt, now),
          periodText: `第${nextLesson.startPeriod}-${nextLesson.endPeriod}节`,
          week: nextLesson.week,
        }
      : null,
    nextRemindAt,
    nextRemindText: nextRemindAt ? `${relativeDayLabel(nextRemindAt, now)} ${formatHm(nextRemindAt)}` : '',
  }
}

/** 管理台用的完整数据 */
function getAdminPayload(req) {
  const cfg = getEffectiveConfig()
  const stored = db.getReminderConfig()
  const reminders = db.getReminders()
  const userMap = {}
  db.getAllUsers().forEach((u) => {
    userMap[u.openid] = u
  })

  const list = reminders.map((r) => {
    const u = userMap[r.openid] || null
    return {
      ...r,
      realName: u ? u.realName || '' : '',
      nickname: u ? u.nickname || '' : '',
      phone: u ? u.phone || '' : '',
      effectiveClassName: r.className || (u ? u.className || '' : ''),
      mockOpenid: isMockOpenid(r.openid),
    }
  })

  const now = Date.now()
  const dayStart = shDayStart(now)

  return {
    config: cfg,
    storedConfig: stored,
    stats: {
      total: list.length,
      enabled: list.filter((r) => r.enabled).length,
      unlimited: cfg.templateType === 'long',
      remainingQuota: list.reduce((s, r) => s + Number(r.quota || 0), 0),
      sentToday: db.getReminderLogs(800).filter((l) => l.status === 'sent' && l.createdAt >= dayStart).length,
      sentTotal: list.reduce((s, r) => s + Number(r.sentCount || 0), 0),
    },
    runtime: getRuntimeStatus(),
    credentials: {
      appId: config.wxAppId,
      hasAppSecret: Boolean(config.wxAppSecret),
      apiBase: config.wxApiBase,
      timezoneOffsetMinutes: config.timezoneOffsetMinutes,
    },
    classNamesSample: scheduleService.getAllClassNames().slice(0, 20),
    totalClassNames: scheduleService.getAllClassNames().length,
    subscriptions: list,
    logs: db.getReminderLogs(120),
    nowText: formatDateTime(now),
  }
}

module.exports = {
  // 配置
  DEFAULT_CONFIG,
  DEFAULT_PERIODS,
  DEFAULT_FIELDS,
  getEffectiveConfig,
  sanitizeConfig,
  // 时间工具（测试与其它模块复用）
  tzOffsetMs,
  shParts,
  shDayStart,
  parseDateToMs,
  parseTimeToMs,
  formatDateTime,
  formatHm,
  relativeDayLabel,
  // 课表计算
  weekMatches,
  findPeriodStart,
  findPeriodEnd,
  getLessonsOnDay,
  getNextLesson,
  buildTemplateData,
  fetchAndCacheTemplates,
  // 扫描
  scanOnce,
  friendlyErr,
  isMockOpenid,
  // 调度
  startScheduler,
  stopScheduler,
  getRuntimeStatus,
  // 对外
  getPublicState,
  getAdminPayload,
  normalizeAheadMinutes,
}
