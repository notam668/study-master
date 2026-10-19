const fs = require('fs')
const path = require('path')

const cachePath = path.join(__dirname, '..', 'server', 'data', 'timetable_cache.json')
const outPath = path.join(__dirname, '..', 'miniprogram', 'utils', 'localScheduleData.js')

if (!fs.existsSync(cachePath)) {
  console.error('未找到课表官方数据缓存，请先运行: python tools/build_official_schedule.py')
  process.exit(1)
}

console.log('正在从官方课表缓存构建小程序离线数据:', cachePath)
const d = JSON.parse(fs.readFileSync(cachePath, 'utf8'))

const termId = (d.index && d.index.defaultTermId) || '2026-2027-1'
const termLabel = (d.index && d.index.terms && d.index.terms.find(t => t.id === termId))?.label || '2026-2027学年第1学期'
const catalog = (d.catalogs && d.catalogs[termId]) || {}
const classNames = catalog.classNames || []
const maxWeek = catalog.maxWeek || 19
const termStartDate = catalog.termStartDate || '2026-09-07'

const pool = []
const poolMap = new Map()
function poolStr(str) {
  if (typeof str !== 'string') str = String(str || '')
  if (!poolMap.has(str)) {
    poolMap.set(str, pool.length)
    pool.push(str)
  }
  return poolMap.get(str)
}

const schedules = {}

for (const k in d.queries) {
  const q = d.queries[k]
  if (!q || !q.name || !Array.isArray(q.courses)) continue

  const list = []
  for (const c of q.courses) {
    if (!Array.isArray(c.sessions)) continue
    for (const s of c.sessions) {
      const segments = (s.weeks && Array.isArray(s.weeks.segments) && s.weeks.segments.length > 0)
        ? s.weeks.segments
        : [{ start: 1, end: maxWeek }]

      for (const seg of segments) {
        list.push([
          poolStr(c.courseName || ''),
          poolStr(s.location || c.location || ''),
          poolStr((c.teachers || []).join(',')),
          s.day,
          s.startPeriod,
          s.endPeriod,
          seg.start,
          seg.end,
          poolStr((s.weeks && s.weeks.parity) || 'all'),
          poolStr((s.weeks && s.weeks.raw) || ''),
        ])
      }
    }
  }
  schedules[q.name] = list
}

const exportedCode = `'use strict';

module.exports = {
  termId: ${JSON.stringify(termId)},
  termLabel: ${JSON.stringify(termLabel)},
  termStartDate: ${JSON.stringify(termStartDate)},
  maxWeek: ${maxWeek},
  classNames: ${JSON.stringify(classNames)},
  pool: ${JSON.stringify(pool)},
  schedules: ${JSON.stringify(schedules)}
};
`

fs.writeFileSync(outPath, exportedCode, 'utf8')
const outSize = fs.statSync(outPath).size
console.log('小程序离线课表数据构建成功!')
console.log('输出路径:', outPath)
console.log('班级总数:', classNames.length)
console.log('文件大小:', (outSize / 1024).toFixed(1), 'KB')
