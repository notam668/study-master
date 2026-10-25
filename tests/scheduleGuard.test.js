/**
 * 课表诚信闸门冒烟测试（node --test tests/scheduleGuard.smoke.js）
 *
 * 覆盖 2026-10-25 任务2c 第1步的每条验收点：
 * 1. import-jwxt 不再接收教务口令 → 400；
 * 2. import-jwxt 不再把班级课表当个人课表返回 → 已污染学号直接报错；
 * 3. import-jwxt 端上带回的 kbList → source=jwxt_direct, isPersonal=true；
 * 4. user-schedule 拒收班级课表 → 400；
 * 5. user-schedule 收下 OCR/上传类个人课表 → 200 且落库带 isPersonal=true；
 * 6. 读取接口不把污染记录当个人课表返回 → data=null + polluted=true；
 * 7. 班级查询接口显式 isPersonal=false + 提示文案。
 *
 * 全程使用临时 DATA_DIR（复制一份库），不碰 D:/server/data/studymaster.json。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const SERVER_DIR = path.join(__dirname, '..')
const TMP_ROOT = process.env.TMPDIR || os.tmpdir()
const DATA_DIR = fs.mkdtempSync(path.join(TMP_ROOT, 'sm-schedule-guard-'))
fs.copyFileSync(path.join(SERVER_DIR, 'data', 'studymaster.json'), path.join(DATA_DIR, 'studymaster.json'))
process.env.DATA_DIR = DATA_DIR

const express = require('express')
const app = express()
app.use(express.json({ limit: '10mb' }))
app.use('/api/schedule', require('../routes/schedule'))

let server
let baseUrl

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

test.after(() => {
  if (server) server.close()
})

const post = (p, body) =>
  fetch(baseUrl + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json() }))

const get = p => fetch(baseUrl + p).then(async r => ({ status: r.status, body: await r.json() }))

const KB_SAMPLE = {
  xsxx: { XM: '测试同学', BJMC: 'B智能252' },
  kbList: [
    { kcmc: '高等数学A', cdmc: '博学楼A101', xm: '王老师', xqj: '1', jcs: '1-2', zcd: '1-16周' },
    { kcmc: '大学英语', cdmc: '博学楼B203', xm: '李老师', xqj: '3', jcs: '3-4', zcd: '1-8周,10-16周' },
  ],
}

test('1. import-jwxt 带口令一律 400，且不回显口令', async () => {
  const r = await post('/api/schedule/import-jwxt', { studentId: '250106162016', password: 'secret-should-not-travel' })
  assert.equal(r.status, 400)
  assert.match(r.body.message, /不再接收教务口令/)
  assert.equal(JSON.stringify(r.body).includes('secret-should-not-travel'), false, '响应里不得回显口令')
})

test('2. 已污染学号：不返回班级课表，明确报错', async () => {
  const r = await post('/api/schedule/import-jwxt', { studentId: '250106162016' })
  assert.equal(r.status, 400)
  assert.match(r.body.message, /班级课表/)
  assert.equal(r.body.data.isPersonal, false)
  assert.equal(r.body.data.source, null)
})

test('3. 端上带回 kbList：source=jwxt_direct, isPersonal=true', async () => {
  const r = await post('/api/schedule/import-jwxt', { studentId: '250106162017', rawKbJson: KB_SAMPLE })
  assert.equal(r.status, 200)
  assert.equal(r.body.data.source, 'jwxt_direct')
  assert.equal(r.body.data.isPersonal, true)
  assert.ok(r.body.data.sessions.length >= 3, `sessions 数量异常: ${r.body.data.sessions.length}`)
  assert.equal(r.body.data.studentName, '测试同学')
})

test('4. user-schedule 拒收班级课表', async () => {
  const r = await post('/api/schedule/user-schedule', {
    userKey: 'audit_probe_key',
    scheduleData: {
      matched: true,
      source: 'class_official',
      matchedClassName: 'B智能252',
      sessions: [{ courseName: '高等数学A', day: 1, startPeriod: 1, endPeriod: 2 }],
    },
  })
  assert.equal(r.status, 400)
  assert.match(r.body.message, /班级课表/)
  assert.equal(r.body.data.isPersonal, false)
})

test('4b. 无来源标记但带 matchedClassName 的历史数据同样被拒', async () => {
  const r = await post('/api/schedule/user-schedule', {
    userKey: 'audit_probe_key2',
    scheduleData: {
      matchedClassName: 'B智能252',
      sessions: [{ courseName: '高等数学A', day: 1, startPeriod: 1, endPeriod: 2 }],
    },
  })
  assert.equal(r.status, 400)
})

test('5. user-schedule 收下 OCR/上传类个人课表并打上 isPersonal=true', async () => {
  const r = await post('/api/schedule/user-schedule', {
    userKey: 'ocr_probe_key',
    scheduleData: {
      source: 'ocr_import',
      sessions: [{ courseName: '线性代数', day: 2, startPeriod: 3, endPeriod: 4, location: 'A302' }],
    },
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.data.scheduleData.isPersonal, true)
  assert.equal(r.body.data.scheduleData.source, 'ocr_import')
})

test('6. 读取接口不返回被污染的班级课表', async () => {
  const r = await get('/api/schedule/user-schedule?userKey=250106162016')
  assert.equal(r.status, 200)
  assert.equal(r.body.data, null)
  assert.equal(r.body.polluted, true)
  assert.match(r.body.message, /班级课表/)
})

test('6b. 读取接口正常返回个人课表', async () => {
  const r = await get('/api/schedule/user-schedule?userKey=250106162017')
  assert.equal(r.status, 200)
  assert.equal(r.body.data.isPersonal, true)
  assert.equal(r.body.data.source, 'jwxt_direct')
})

test('7. 班级查询显式标注 isPersonal=false + 提示文案', async () => {
  const r = await get('/api/schedule/query?className=' + encodeURIComponent('B智能252'))
  assert.equal(r.status, 200)
  assert.equal(r.body.data.isPersonal, false)
  assert.equal(r.body.data.source, 'class_official')
  assert.match(r.body.data.notice, /不是你的个人课表/)
})

test('8. 落库结果复核：临时库只剩 2 条干净记录 + 1 条污染(未被动过)', async () => {
  const dbModule = require('../db')
  dbModule.flushSync() // saveDb 有 100ms 防抖，落盘前先强制刷一次
  const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'studymaster.json'), 'utf8'))
  const keys = Object.keys(db.userSchedules || {})
  assert.equal(keys.includes('250106162016'), true, '污染记录必须原样保留（只报数，不删）')
  assert.equal(db.userSchedules['250106162016'].scheduleData.source, 'jwxt_student_verified')
  assert.equal(db.userSchedules['250106162017'].scheduleData.isPersonal, true)
  assert.equal(db.userSchedules['250106162017'].scheduleData.source, 'jwxt_direct')
  assert.equal(db.userSchedules['ocr_probe_key'].scheduleData.isPersonal, true)
  assert.equal(keys.includes('audit_probe_key'), false, '被拒的班级课表不得落库')
})
