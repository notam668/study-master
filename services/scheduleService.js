const fs = require('fs')
const path = require('path')
const config = require('../config')

const defaultCacheFile = path.join(__dirname, '..', 'data', 'timetable_cache.json')
const CACHE_FILE = fs.existsSync(defaultCacheFile)
  ? defaultCacheFile
  : path.join(config.dataDir, 'timetable_cache.json')

let scheduleMemory = null

/**
 * 加载并获取内存中的官方课表数据
 */
function getScheduleData() {
  if (scheduleMemory) return scheduleMemory
  if (fs.existsSync(CACHE_FILE)) {
    try {
      scheduleMemory = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
      console.log(`[Schedule] 成功加载官方课表数据，包含 ${getAllClassNames().length} 个班级。`)
      return scheduleMemory
    } catch (e) {
      console.error('[Schedule] 读取课表缓存失败:', e)
    }
  } else {
    console.warn('[Schedule] 未找到课表缓存文件:', CACHE_FILE)
  }
  return null
}

/**
 * 重新加载/同步官方课表数据（严格来自本地官方数据源，不再访问不可靠外网）
 */
async function syncScheduleData() {
  console.log('[Schedule] 正在重载官方课表数据...')
  try {
    if (!fs.existsSync(CACHE_FILE)) {
      throw new Error(`课表数据文件不存在: ${CACHE_FILE}`)
    }
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    scheduleMemory = cached
    const classCount = getAllClassNames().length
    console.log(`[Schedule] 官方课表重载成功！共加载 ${classCount} 个班级。`)
    return cached
  } catch (err) {
    console.error('[Schedule] 重载课表数据失败:', err)
    return null
  }
}

/**
 * 获取所有班级名称列表
 */
function getAllClassNames() {
  const data = getScheduleData()
  if (!data || !data.catalogs) return []
  const defaultTerm = (data.index && data.index.defaultTermId) || Object.keys(data.catalogs)[0]
  const catalog = data.catalogs[defaultTerm]
  return catalog && catalog.classNames ? catalog.classNames : []
}

/**
 * 班级模糊匹配算法
 */
function matchClassName(inputName) {
  if (!inputName || typeof inputName !== 'string') return null
  const rawInput = inputName.trim()
  if (!rawInput) return null

  const classList = getAllClassNames()
  if (classList.length === 0) return null

  // 1. 完全一致
  if (classList.includes(rawInput)) {
    return rawInput
  }

  // 2. 加 "B" 前缀匹配（例如用户输入 计算机231，库里是 B计算机231）
  const withB = `B${rawInput}`
  if (classList.includes(withB)) {
    return withB
  }

  // 3. 规范化四位班号（例如用户输入 计算机2301 -> 转换成 计算机231）
  const normalizedFourDigit = rawInput.replace(/(\d{2})0(\d)/, '$1$2')
  if (classList.includes(normalizedFourDigit)) {
    return normalizedFourDigit
  }
  const normalizedWithB = `B${normalizedFourDigit}`
  if (classList.includes(normalizedWithB)) {
    return normalizedWithB
  }

  // 4. 清理特殊字符后模糊匹配
  // 去除用户可能输入的 “级”、“班” 等字样，如 "23级计算机1班" -> "计算机231"
  let cleanInput = rawInput.replace(/[级班]/g, '')
  // 处理 "23计算机1" -> "计算机231" 倒装情况
  const reverseMatch = cleanInput.match(/^(\d{2})([^\d]+)(\d+)$/)
  if (reverseMatch) {
    cleanInput = `${reverseMatch[2]}${reverseMatch[1]}${reverseMatch[3]}`
  }

  if (classList.includes(cleanInput)) return cleanInput
  if (classList.includes(`B${cleanInput}`)) return `B${cleanInput}`

  for (const c of classList) {
    const cleanC = c.replace(/^[BDWZ]/, '')
    if (cleanC === cleanInput) return c
  }

  // 5. 包含关系智能匹配
  const candidate = classList.find(c => {
    const cleanC = c.replace(/^[BDWZ]/, '')
    return cleanInput.includes(cleanC) || cleanC.includes(cleanInput)
  })

  return candidate || null
}

function flattenSessions(classInfo) {
  if (!classInfo || !Array.isArray(classInfo.courses)) return []
  const list = []
  classInfo.courses.forEach(c => {
    if (!c.sessions) return
    c.sessions.forEach(s => {
      list.push({
        courseName: c.courseName,
        location: c.location || '待定',
        teacher: (c.teachers && c.teachers.join(',')) || '',
        day: s.day,
        startPeriod: s.startPeriod,
        endPeriod: s.endPeriod,
        startWeek: s.startWeek,
        endWeek: s.endWeek,
        parity: s.parity || 'all',
        rawWeeks: s.rawWeeks || `${s.startWeek}-${s.endWeek}周`,
      })
    })
  })
  return list
}

/**
 * 查询指定班级的课表详情
 */
function getScheduleByClass(className) {
  const data = getScheduleData()
  if (!data) return null

  const matchedName = matchClassName(className)
  if (!matchedName) {
    return {
      matched: false,
      inputName: className,
      queryKey: null,
      classInfo: null,
      sessions: [],
    }
  }

  const defaultTerm = (data.index && data.index.defaultTermId) || '2026-2027-1'
  const queryKey = `${defaultTerm}_class_${matchedName}`
  const classSchedule = data.queries && data.queries[queryKey]

  return {
    matched: true,
    inputName: className,
    matchedClassName: matchedName,
    termId: defaultTerm,
    termLabel: data.index && data.index.terms ? (data.index.terms.find(t => t.id === defaultTerm) || {}).label : defaultTerm,
    maxWeek: (data.catalogs && data.catalogs[defaultTerm] && data.catalogs[defaultTerm].maxWeek) || 19,
    classInfo: classSchedule || null,
    sessions: flattenSessions(classSchedule),
  }
}

module.exports = {
  syncScheduleData,
  getScheduleData,
  getAllClassNames,
  matchClassName,
  getScheduleByClass,
}
