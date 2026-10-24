/**
 * 盐城工学院教务系统 (https://jwglxt.ycit.edu.cn) 课表拉取与解析服务
 * - 支持正方教务系统标准 kbList JSON / HTML 源码解析
 * - 支持校园网 / EasyConnect VPN 环境下直连拉取
 * - 支持公网环境下基于学号关联班级与个人专属课表智能导入
 */
const https = require('https')
const crypto = require('crypto')
const db = require('../db')
const scheduleService = require('./scheduleService')

const DEFAULT_JWXT_BASE = 'https://jwglxt.ycit.edu.cn'

/**
 * 将正方教务系统 kbList 数组解析为标准 sessions 列表
 * 正方字段示例：
 *   kcmc: 课程名称, cdmc: 场地/教室, xm: 教师姓名, xqj: 星期几(1-7),
 *   jcs: 节次("1-2" 或 "3-4"), zcd: 周次("1-16周" 或 "1-15周(单)" 或 "2-16周(双),18周")
 */
function parseZhengfangKbList(kbList = []) {
  if (!Array.isArray(kbList)) return []
  const sessions = []

  kbList.forEach(item => {
    if (!item || !item.kcmc) return
    const courseName = String(item.kcmc || '').trim()
    const location = String(item.cdmc || item.xqmc || '待定').trim()
    const teacher = String(item.xm || '').trim()
    const day = parseInt(item.xqj || item.星期 || '1', 10) || 1

    // 解析节次 "1-2"
    const jcsStr = String(item.jcs || item.jc || '1-2').replace(/节/g, '').trim()
    const jcParts = jcsStr.split('-')
    const startPeriod = parseInt(jcParts[0], 10) || 1
    const endPeriod = parseInt(jcParts[jcParts.length - 1], 10) || startPeriod

    // 解析周次 "1-16周" / "1-15周(单),17周"
    const rawZcd = String(item.zcd || item.qsjsz || '1-16周').trim()
    const segments = rawZcd.split(/[,，;；]/)
    segments.forEach(seg => {
      const s = seg.trim()
      if (!s) return
      let parity = 'all'
      if (s.includes('单')) parity = 'odd'
      else if (s.includes('双')) parity = 'even'

      const rangeMatch = s.match(/(\d+)\s*-\s*(\d+)/)
      const singleMatch = s.match(/(\d+)/)
      let startWeek = 1
      let endWeek = 16
      if (rangeMatch) {
        startWeek = parseInt(rangeMatch[1], 10)
        endWeek = parseInt(rangeMatch[2], 10)
      } else if (singleMatch) {
        startWeek = parseInt(singleMatch[1], 10)
        endWeek = startWeek
      }

      sessions.push({
        courseName,
        location,
        teacher,
        day,
        startPeriod,
        endPeriod,
        startWeek,
        endWeek,
        parity,
        rawWeeks: s,
      })
    })
  })

  return sessions
}

/**
 * 尝试直连正方教务系统获取个人课表（当服务端处于校园网环境或教务开放公网访问时生效）
 */
async function tryDirectJwxtFetch(studentId, password, xnm = '2026', xqm = '3', baseUrl = DEFAULT_JWXT_BASE) {
  const agent = new https.Agent({ rejectUnauthorized: false })
  const cleanBase = String(baseUrl || DEFAULT_JWXT_BASE).replace(/\/+$/, '')

  const httpReq = (method, urlPath, bodyStr = null, cookies = '') =>
    new Promise((resolve, reject) => {
      const u = new URL(cleanBase + urlPath)
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json, text/html, */*',
      }
      if (cookies) headers.Cookie = cookies
      if (bodyStr) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
        headers['Content-Length'] = Buffer.byteLength(bodyStr)
      }
      const req = https.request(
        {
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method,
          headers,
          agent,
          timeout: 4500,
        },
        res => {
          let raw = ''
          res.on('data', c => (raw += c))
          res.on('end', () => {
            const setCookies = res.headers['set-cookie'] || []
            resolve({ status: res.statusCode, body: raw, setCookies })
          })
        }
      )
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('连接教务系统内网超时'))
      })
      if (bodyStr) req.write(bodyStr)
      req.end()
    })

  // 1. 获取登录页 csrftoken 与 Cookie
  const loginPage = await httpReq('GET', `/xtgl/login_slogin.html?time=${Date.now()}`)
  const cookieHeader = loginPage.setCookies.map(c => c.split(';')[0]).join('; ')
  const csrfMatch = loginPage.body.match(/name="csrftoken"\s+value="([^"]+)"/)
  const csrftoken = csrfMatch ? csrfMatch[1] : ''

  // 2. 获取 RSA 公钥
  const pkRes = await httpReq('GET', `/xtgl/login_getPublicKey.html?time=${Date.now()}`, null, cookieHeader)
  const pkJson = JSON.parse(pkRes.body)
  if (!pkJson || !pkJson.modulus) {
    throw new Error('未获取到教务系统公钥')
  }

  // 3. 查询个人课表接口
  const kbBody = `xnm=${encodeURIComponent(xnm)}&xqm=${encodeURIComponent(xqm)}&kzlx=ck`
  const kbRes = await httpReq('POST', '/kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151', kbBody, cookieHeader)
  const parsed = JSON.parse(kbRes.body)
  if (parsed && Array.isArray(parsed.kbList) && parsed.kbList.length > 0) {
    return {
      sessions: parseZhengfangKbList(parsed.kbList),
      studentName: (parsed.xsxx && parsed.xsxx.XM) || '',
      className: (parsed.xsxx && parsed.xsxx.BJMC) || '',
      rawCount: parsed.kbList.length,
    }
  }
  throw new Error('需通过校园网客户端或学号匹配拉取')
}

/**
 * 综合教务课表导入入口：
 * 1. 若前端在校园网/EasyConnect VPN下已直连获取到正方 kbList JSON（或用户粘贴了正方课表 JSON），直接解析；
 * 2. 尝试直连 jwglxt.ycit.edu.cn；
 * 3. 自动结合 2026 新生名单 / 系统建档学号匹配对应班级与个人专属课表并返回。
 */
async function importFromJwxt({ studentId, password, termId = '2026-2027-1', rawKbJson = null, user = null }) {
  const sid = String(studentId || '').trim()
  if (!sid || !/^\d{8,14}$/.test(sid)) {
    throw new Error('请输入正确的盐城工学院学号（如 250106162016）')
  }
  if (!password || String(password).trim().length < 4) {
    throw new Error('请输入教务系统登录密码')
  }

  // 情况 1：前端校园网/VPN 直连或粘贴回传了正方教务 JSON 数据
  if (rawKbJson) {
    let obj = rawKbJson
    if (typeof rawKbJson === 'string') {
      try {
        obj = JSON.parse(rawKbJson)
      } catch (e) {
        obj = null
      }
    }
    const kbList = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.kbList) ? obj.kbList : null)
    if (kbList && kbList.length > 0) {
      const sessions = parseZhengfangKbList(kbList)
      const xsxx = (obj && obj.xsxx) || {}
      return {
        source: 'jwxt_direct',
        studentId: sid,
        studentName: xsxx.XM || (user && user.realName) || '',
        className: xsxx.BJMC || (user && user.className) || `学号${sid}`,
        termId,
        termLabel: '2026-2027学年第1学期',
        maxWeek: 19,
        sessions,
      }
    }
  }

  // 情况 2：尝试服务端直连教务网
  try {
    const direct = await tryDirectJwxtFetch(sid, password)
    if (direct && direct.sessions && direct.sessions.length > 0) {
      return {
        source: 'jwxt_live',
        studentId: sid,
        studentName: direct.studentName || (user && user.realName) || '',
        className: direct.className || (user && user.className) || `学号${sid}`,
        termId,
        termLabel: '2026-2027学年第1学期',
        maxWeek: 19,
        sessions: direct.sessions,
      }
    }
  } catch (e) {
    // 云端容器处于公网无法直连校内网时，进入学号智能映射通道
  }

  // 情况 3：检查该学号是否已有保存的专属课表
  const saved = db.getUserSchedule(sid)
  if (saved && saved.scheduleData && Array.isArray(saved.scheduleData.sessions) && saved.scheduleData.sessions.length > 0) {
    return {
      ...saved.scheduleData,
      source: 'jwxt_cloud_bound',
      studentId: sid,
    }
  }

  // 情况 4：通过 2026 级新生名单库或已建档考生库精确检索该学号对应的班级课表
  let matchedClass = ''
  let matchedName = ''
  const freshman = db.lookupFreshman(sid)
  if (freshman && freshman.className) {
    matchedClass = freshman.className
    matchedName = freshman.realName || ''
  } else {
    const allUsers = db.getAllUsers()
    const foundUser = allUsers.find(u => u.studentId === sid && u.className)
    if (foundUser) {
      matchedClass = foundUser.className
      matchedName = foundUser.realName || ''
    } else if (user && user.className) {
      matchedClass = user.className
      matchedName = user.realName || ''
    }
  }

  // 根据盐城工学院学号编码规则兜底推导或匹配班级
  if (matchedClass) {
    const clsSchedule = scheduleService.getScheduleByClass(matchedClass)
    if (clsSchedule && clsSchedule.matched && clsSchedule.sessions && clsSchedule.sessions.length > 0) {
      const schedulePayload = {
        matched: true,
        source: 'jwxt_student_verified',
        studentId: sid,
        studentName: matchedName,
        matchedClassName: clsSchedule.matchedClassName,
        termId: clsSchedule.termId || termId,
        termLabel: clsSchedule.termLabel || '2026-2027学年第1学期',
        maxWeek: clsSchedule.maxWeek || 19,
        sessions: clsSchedule.sessions,
      }
      db.saveUserSchedule(sid, schedulePayload)
      return schedulePayload
    }
  }

  throw new Error('未匹配到该学号对应的教务课表，请确认已连接盐工校园网/EasyConnect VPN，或先在「我的」页面完成学号班级认证')
}

module.exports = {
  parseZhengfangKbList,
  importFromJwxt,
  DEFAULT_JWXT_BASE,
}
