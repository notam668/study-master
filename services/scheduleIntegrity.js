/**
 * 课表来源诚信判定（服务端唯一入口）
 *
 * 背景（2026-10-25 事故）：
 *   services/jwxtService.js 旧实现在"直连教务失败"时会静默降级为
 *   「按学号查班级 → 返回班级课表」，并把结果以 source='jwxt_student_verified'
 *   写入 userSchedules，冒充「已绑定个人课表」。下一次导入直接命中
 *   "已保存" 分支，永久复用班级课表，用户看不出任何异常。
 *
 * 本模块只做判定，不写库、不删数据。任何要把课表写进 userSchedules 的地方
 * 都必须先过 inspectSchedule()，isPersonal !== true 一律拒收。
 */

// 由班级课表直接派生的来源：一律不是个人课表
const CLASS_DERIVED_SOURCES = [
  'jwxt_student_verified', // 旧降级通道写入的标记
  'jwxt_class_fallback', // 预留别名
  'class_official', // 官方班级课表
  'class_query', // 班级查询结果
]

// 允许被认定为个人课表的来源（新增来源请登记在这里，否则默认按个人处理）
const PERSONAL_SOURCES = [
  'jwxt_direct', // 端上/校园网直连教务拿到的 kbList 原样 JSON
  'jwxt_live', // 服务端直连（本版已停用，仅为历史记录兼容）
  'schedule_import_file', // 用户上传官方 .xls 课表文件
  'ocr_import', // 用户拍照/截图识别
  'user_upload', // 手动录入/上传
  'cloud_saved', // 云端已保存（通过校验后回读）
]

function normSource(scheduleData) {
  if (!scheduleData || typeof scheduleData !== 'object') return ''
  return String(scheduleData.source || '').trim()
}

/**
 * 判定一条课表数据是不是"真·个人课表"
 * @param {object} scheduleData
 * @returns {{isPersonal:boolean, source:string, reasons:string[]}}
 */
function inspectSchedule(scheduleData) {
  const reasons = []
  if (!scheduleData || typeof scheduleData !== 'object') {
    return { isPersonal: false, source: '', reasons: ['课表数据为空或格式不正确'] }
  }

  const source = normSource(scheduleData)

  if (scheduleData.isPersonal === false) {
    reasons.push('数据自身声明 isPersonal=false')
  }
  if (source && CLASS_DERIVED_SOURCES.includes(source)) {
    reasons.push(`来源 ${source} 属于班级课表派生数据`)
  }
  if (scheduleData.matchedClassName) {
    reasons.push(`带 matchedClassName=${scheduleData.matchedClassName}（班级匹配产物，非个人课表）`)
  }
  // 旧数据可能没有 source 字段，但有 matched=true 却没有任何个人标识：按污染处理
  if (!source && scheduleData.matched === true && !scheduleData.isPersonal) {
    reasons.push('matched=true 且无来源标记，来源不可信')
  }

  // 已知个人来源 → 明确放行（即便带 matched 字段，OCR/导入也会带 matched）
  if (reasons.length === 0 && source && PERSONAL_SOURCES.includes(source)) {
    return { isPersonal: true, source, reasons: [] }
  }

  return { isPersonal: reasons.length === 0, source, reasons }
}

function isPersonalSchedule(scheduleData) {
  return inspectSchedule(scheduleData).isPersonal === true
}

module.exports = {
  CLASS_DERIVED_SOURCES,
  PERSONAL_SOURCES,
  inspectSchedule,
  isPersonalSchedule,
}
