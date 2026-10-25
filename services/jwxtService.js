/**
 * 盐城工学院教务系统 (https://jwglxt.ycit.edu.cn) 课表解析服务
 *
 * ⚠️ 2026-10-25 起的口径（任务2c）：
 * 1. 教务登录被服务端强制的顶象滑块（zfcaptchaLogin）挡死，小程序没有 DOM，渲染不了滑块，
 *    「端上/云端全自动登录教务」这条路技术上不可行。2026-10-25 实测：真账号、以及
 *    不存在的账号，POST 登录都返回「请先滑动图片进行验证！」，说明滑块与口令无关。
 * 2. 因此服务端 **不再接收、不再使用教务口令**（口令不进服务器），也 **不再向教务发起任何登录请求**。
 * 3. 旧实现在直连失败时会静默降级成「按学号 → 班级课表」，并把班级课表当个人课表写库，
 *    造成永久污染。该降级通道已于 2026-10-25 整段删除，未命中就报错，绝不拿班级课表顶替。
 *
 * 现在允许的数据来源只有两种：
 *   A. 端上（校园网 / EasyConnect VPN 内）自己拿到、回传给服务端的正方 kbList JSON —— source=jwxt_direct
 *   B. 云端已保存、且通过 services/scheduleIntegrity 诚信校验的个人课表 —— servedFrom=cloud_saved
 */
const db = require('../db')
const { inspectSchedule } = require('./scheduleIntegrity')

const TERM_LABEL = '2026-2027学年第1学期'
const MAX_WEEK = 19

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
 * 教务课表导入入口（无口令、无降级）
 * @param {object} opts
 * @param {string} opts.studentId 学号（仅用于归档键与展示，不做班级推导）
 * @param {string} [opts.termId]
 * @param {object|string} [opts.rawKbJson] 端上带回的正方 kbList / {kbList, xsxx} JSON
 * @param {object} [opts.user] 当前登录用户（用于补全姓名/班级展示）
 */
async function importFromJwxt({ studentId, termId = '2026-2027-1', rawKbJson = null, user = null }) {
  const sid = String(studentId || '').trim()
  if (!sid || !/^\d{8,14}$/.test(sid)) {
    throw new Error('请输入正确的盐城工学院学号（如 250106162016）')
  }

  // ── A. 端上直连带回的正方原始数据（唯一"真个人课表"来源） ──
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
    if (!kbList || kbList.length === 0) {
      throw new Error('带回的教务数据格式不正确（需要 kbList 数组或 {kbList:[...]} 结构）')
    }
    const sessions = parseZhengfangKbList(kbList)
    if (sessions.length === 0) {
      throw new Error('带回的教务课表 JSON 里没解析出任何课程，请确认是"学生个人课表"页面的数据')
    }
    const xsxx = (obj && obj.xsxx) || {}
    return {
      source: 'jwxt_direct',
      sourceLabel: '教务个人课表原始数据（由端上带回）',
      isPersonal: true,
      studentId: sid,
      studentName: xsxx.XM || (user && user.realName) || '',
      className: xsxx.BJMC || (user && user.className) || '',
      termId,
      termLabel: TERM_LABEL,
      maxWeek: MAX_WEEK,
      sessions,
    }
  }

  // ── B. 云端已保存的个人课表（必须通过诚信校验才算数） ──
  const saved = db.getUserSchedule(sid)
  if (saved && saved.scheduleData) {
    const verdict = inspectSchedule(saved.scheduleData)
    const sessionCount = Array.isArray(saved.scheduleData.sessions) ? saved.scheduleData.sessions.length : 0
    if (!verdict.isPersonal) {
      // 不返回、不删除、不覆盖：只把问题说清楚
      throw new Error(
        `该学号云端保存的是班级课表，不是个人课表（${verdict.reasons.join('；')}）。` +
          '已停止返回这份数据，请改用「上传课表文件」或「拍照识别」导入你自己的课表。'
      )
    }
    if (sessionCount > 0) {
      return {
        ...saved.scheduleData,
        source: saved.scheduleData.source || 'cloud_saved',
        sourceLabel: saved.scheduleData.sourceLabel || '云端已保存的个人课表',
        isPersonal: true,
        servedFrom: 'cloud_saved',
        studentId: sid,
      }
    }
  }

  throw new Error(
    '没有拿到你的个人课表：教务登录需要滑块验证，服务端无法代办。' +
      '请在「上传课表文件 / 拍照识别」里导入你自己的课表。'
  )
}

module.exports = {
  parseZhengfangKbList,
  importFromJwxt,
}
