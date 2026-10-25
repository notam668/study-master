#!/usr/bin/env node
/**
 * 只读审计：数出 userSchedules 里有多少条"班级课表冒充个人课表"的污染记录
 *
 * 背景：2026-10-24 及以前，POST /api/schedule/import-jwxt 在直连教务失败时会
 * 静默降级为「按学号 → 班级课表」，并以 source='jwxt_student_verified' 写入
 * userSchedules。下一次导入命中"已保存"分支，班级课表就被永久当成个人课表。
 *
 * 本脚本 **只读**：不写库、不删记录、不改任何文件。要清理必须老板点头后另行执行。
 *
 * 用法：
 *   node tools/audit_polluted_schedules.js            # 审计当前 DATA_DIR 的库
 *   node tools/audit_polluted_schedules.js --json     # 机器可读输出
 *   node tools/audit_polluted_schedules.js --file D:/path/studymaster.json
 *
 * 退出码：0=审计完成（无论有没有污染）；2=库文件读不到
 */
const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const fileIdx = args.indexOf('--file')
let dbFile = null

if (fileIdx !== -1 && args[fileIdx + 1]) {
  dbFile = path.resolve(args[fileIdx + 1])
} else {
  const config = require('../config')
  dbFile = path.join(config.dataDir, 'studymaster.json')
  if (!fs.existsSync(dbFile)) {
    // 本地开发时 config.dataDir 可能就是 data/，兜底再来一次
    const alt = path.join(__dirname, '..', 'data', 'studymaster.json')
    if (fs.existsSync(alt)) dbFile = alt
  }
}

if (!fs.existsSync(dbFile)) {
  console.error(`[审计失败] 找不到数据库文件：${dbFile}`)
  process.exit(2)
}

const { inspectSchedule } = require('../services/scheduleIntegrity')

const raw = fs.readFileSync(dbFile, 'utf8')
let db
try {
  db = JSON.parse(raw)
} catch (e) {
  console.error(`[审计失败] JSON 解析失败：${e.message}`)
  process.exit(2)
}

const userSchedules = db.userSchedules && typeof db.userSchedules === 'object' ? db.userSchedules : {}
const allKeys = Object.keys(userSchedules)
const polluted = []
const clean = []

for (const key of allKeys) {
  const rec = userSchedules[key] || {}
  const sd = rec.scheduleData || {}
  const verdict = inspectSchedule(sd)
  const item = {
    userKey: key,
    source: verdict.source || null,
    isPersonal: verdict.isPersonal,
    reasons: verdict.reasons,
    matchedClassName: sd.matchedClassName || null,
    studentId: sd.studentId || null,
    studentName: sd.studentName || null,
    sessions: Array.isArray(sd.sessions) ? sd.sessions.length : 0,
    updatedAt: rec.updatedAt ? new Date(rec.updatedAt).toISOString() : null,
  }
  if (verdict.isPersonal) clean.push(item)
  else polluted.push(item)
}

const result = {
  auditedFile: dbFile,
  auditedAt: new Date().toISOString(),
  totalRecords: allKeys.length,
  pollutedCount: polluted.length,
  cleanCount: clean.length,
  polluted,
  clean,
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log('='.repeat(64))
  console.log(`审计文件：${dbFile}`)
  console.log(`userSchedules 总记录：${allKeys.length} 条`)
  console.log(`被污染（班级课表冒充个人课表）：${polluted.length} 条`)
  console.log(`干净（真个人课表）：${clean.length} 条`)
  console.log('='.repeat(64))
  if (polluted.length > 0) {
    console.log('污染明细（本次只报数，不删除）：')
    polluted.forEach((p, i) => {
      console.log(
        `  ${i + 1}. 键=${p.userKey} 来源=${p.source || '(空)'} 班级=${p.matchedClassName || '-'} ` +
          `课程节次=${p.sessions} 写入时间=${p.updatedAt || '-'}`
      )
      console.log(`     原因：${p.reasons.join('；')}`)
    })
  }
}

// 只读：不写任何文件
process.exitCode = 0
