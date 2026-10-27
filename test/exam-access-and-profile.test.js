const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ycit-backend-'))
process.env.DATA_DIR = testDataDir
fs.writeFileSync(
  path.join(testDataDir, 'studymaster.json'),
  JSON.stringify({
    users: [],
    events: [],
    activationCodes: [],
    userSchedules: {},
    userDorms: {},
  })
)

const db = require('../db')
const app = require('../server')
const officialClasses = require('../tools/official_classes.json')

function requestJson(port, method, urlPath, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          ...headers,
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          raw += chunk
        })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(raw), raw })
          } catch (err) {
            reject(err)
          }
        })
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function runIsolated(dir, code) {
  return spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    env: { ...process.env, DATA_DIR: dir },
  })
}

test('exam access, profile match, and user isolation', async (t) => {
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening))
  })
  const { port } = server.address()

  try {
    await t.test('login and /me unlock exams without an activation code', async () => {
      const login = await requestJson(port, 'POST', '/api/auth/login', { code: 'dev_code_exam_free' })
      assert.equal(login.status, 200)
      assert.equal(login.json.data.user.isExamUnlocked, true)

      const stored = db.getUserById(login.json.data.user.id)
      stored.isExamUnlocked = false
      const me = await requestJson(port, 'GET', '/api/auth/me', undefined, {
        authorization: `Bearer ${login.json.data.token}`,
      })
      assert.equal(me.status, 200)
      assert.equal(me.json.data.isExamUnlocked, true)

      const unlock = await requestJson(port, 'POST', '/api/auth/unlock-exam', {})
      assert.equal(unlock.status, 200)
      assert.equal(unlock.json.data.isExamUnlocked, true)
      assert.equal(unlock.json.message.includes('无需激活码'), true)

      const bogus = await requestJson(port, 'POST', '/api/auth/unlock-exam', { code: 'NOT-A-REAL-CODE' })
      assert.equal(bogus.status, 200)
      assert.equal(bogus.json.data.isExamUnlocked, true)
      const created = db.getActivationCodesStats().allList.find((item) => item.code === 'NOT-A-REAL-CODE')
      assert.equal(created, undefined)
    })

    await t.test('mock token cannot become the latest user', async () => {
      await requestJson(port, 'POST', '/api/auth/login', { code: 'dev_code_real_person' })
      const me = await requestJson(port, 'GET', '/api/auth/me', undefined, {
        authorization: 'Bearer mock_token_anyone',
      })
      assert.equal(me.status, 401)
    })

    await t.test('app login does not take over a wechat account', async () => {
      const login = await requestJson(port, 'POST', '/api/auth/login', { code: 'dev_code_wechat_owner' })
      const owner = db.getUserById(login.json.data.user.id)
      owner.studentId = '250199988877'
      const appLogin = await requestJson(port, 'POST', '/api/auth/app-login', { studentId: '250199988877' })
      assert.equal(appLogin.status, 200)
      assert.equal(appLogin.json.data.user.openid, 'app_250199988877')
      assert.notEqual(appLogin.json.data.user.id, owner.id)
      assert.equal(appLogin.json.data.user.isExamUnlocked, true)
      assert.equal(db.getUserById(owner.id).openid, owner.openid)
    })

    await t.test('freshman lookup checks the name and colleges cover upper grades', async () => {
      const matched = await requestJson(
        port,
        'GET',
        '/api/auth/freshman-lookup?studentId=260101011001&realName=' + encodeURIComponent('朱 者赤')
      )
      assert.equal(matched.status, 200)
      assert.equal(matched.json.data.found, true)
      assert.equal(matched.json.data.nameMatched, true)
      assert.equal(matched.json.data.student.className, 'B机制261')
      assert.equal(matched.json.data.student.major, '机械设计制造及其自动化')
      assert.equal(matched.json.data.student.college, '机械工程学院、优集学院(合署)')
      assert.equal(matched.json.data.student.campus, '北校区')
      assert.equal(matched.json.data.student.grade, '2026级')

      const mismatched = await requestJson(
        port,
        'GET',
        '/api/auth/freshman-lookup?studentId=260101011001&realName=' + encodeURIComponent('李四')
      )
      assert.equal(mismatched.json.data.found, true)
      assert.equal(mismatched.json.data.nameMatched, false)
      assert.equal(mismatched.json.data.student, null)
      assert.equal(mismatched.raw.includes('朱者赤'), false)
      assert.equal(mismatched.json.data.message.includes('对不上'), true)

      const missing = await requestJson(port, 'GET', '/api/auth/freshman-lookup?studentId=250106162016')
      assert.equal(missing.json.data.found, false)
      assert.equal(missing.json.data.fillMode, 'manual')

      const colleges = await requestJson(port, 'GET', '/api/auth/colleges')
      assert.equal(colleges.status, 200)
      const humanities = colleges.json.data.colleges.find((item) => item.college === '人文社会科学学院')
      assert.ok(humanities.majors.includes('汉语言文学'))
      assert.ok(humanities.classes.includes('B中文231'))
      assert.ok(humanities.classesByGrade['2023级'].includes('B中文231'))
      const covered = new Set()
      colleges.json.data.colleges.forEach((item) => item.classes.forEach((name) => covered.add(name)))
      const uncovered = officialClasses.filter((name) => !covered.has(name))
      assert.deepEqual(uncovered, [])
      assert.ok(colleges.json.data.campuses.includes('南校区'))
      assert.ok(colleges.json.data.campuses.includes('北校区'))
      const sophomore = colleges.json.data.grades.find((item) => item.grade === '2025级')
      const freshman = colleges.json.data.grades.find((item) => item.grade === '2026级')
      assert.equal(sophomore.label, '大二')
      assert.equal(sophomore.fillMode, 'manual')
      assert.equal(freshman.label, '大一')
      assert.equal(freshman.fillMode, 'roster')
    })

    await t.test('profile autofills a matched freshman and rejects a mismatched name', async () => {
      const login = await requestJson(port, 'POST', '/api/auth/login', { code: 'dev_code_freshman_profile' })
      const headers = { authorization: `Bearer ${login.json.data.token}` }
      const saved = await requestJson(
        port,
        'POST',
        '/api/auth/profile',
        {
          realName: '朱者赤',
          studentId: '260101011001',
          phone: '13912348765',
          className: '错误班级',
          college: '错误学院',
          grade: '大四',
        },
        headers
      )
      assert.equal(saved.status, 200)
      assert.equal(saved.json.data.className, 'B机制261')
      assert.equal(saved.json.data.college, '机械工程学院、优集学院(合署)')
      assert.equal(saved.json.data.major, '机械设计制造及其自动化')
      assert.equal(saved.json.data.campus, '北校区')
      assert.equal(saved.json.data.grade, '2026级')
      assert.equal(saved.json.data.isFreshmanVerified, true)
      assert.equal(saved.json.data.profileSource, 'freshman-roster')
      assert.equal(saved.json.data.isExamUnlocked, true)

      const wrong = await requestJson(
        port,
        'POST',
        '/api/auth/profile',
        {
          realName: '李四',
          studentId: '260101011001',
          phone: '13912348765',
          className: 'B机制261',
        },
        headers
      )
      assert.equal(wrong.status, 400)
      assert.equal(wrong.json.message.includes('对不上'), true)
      assert.equal(db.getUserById(login.json.data.user.id).realName, '朱者赤')
    })

    await t.test('upper grades can save a manual profile and cannot take another student id', async () => {
      const senior = await requestJson(port, 'POST', '/api/auth/login', { code: 'dev_code_senior_profile' })
      const saved = await requestJson(
        port,
        'POST',
        '/api/auth/profile',
        {
          realName: '张伟',
          studentId: '250106162016',
          phone: '13712348765',
          className: 'B中文241',
          college: '人文社会科学学院',
          major: '汉语言文学',
          campus: '南校区',
          grade: '大三',
        },
        { authorization: `Bearer ${senior.json.data.token}` }
      )
      assert.equal(saved.status, 200)
      assert.equal(saved.json.data.grade, '2024级')
      assert.equal(saved.json.data.className, 'B中文241')
      assert.equal(saved.json.data.profileSource, 'manual')
      assert.equal(saved.json.data.isFreshmanVerified, false)

      const other = await requestJson(port, 'POST', '/api/auth/login', { code: 'dev_code_other_student' })
      const conflict = await requestJson(
        port,
        'POST',
        '/api/auth/profile',
        {
          realName: '王磊',
          studentId: '250106162016',
          phone: '13612348765',
          className: 'B中文241',
          college: '人文社会科学学院',
          grade: '大三',
        },
        { authorization: `Bearer ${other.json.data.token}` }
      )
      assert.equal(conflict.status, 400)
      assert.equal(conflict.json.message.includes('学号已绑定'), true)
    })

    await t.test('a mismatched exam event is not shown to both users', () => {
      const first = db.createOrUpdateUser('openid-event-a', {}).user
      const second = db.createOrUpdateUser('openid-event-b', {}).user
      db.addEvent({
        userId: first.id,
        openid: second.openid,
        eventType: 'finish_exam',
        score: 80,
        total: 100,
      })
      assert.equal(db.getUserExamHistory(first.id, first.openid).length, 0)
      assert.equal(db.getUserExamHistory(second.id, second.openid).length, 0)
      const own = db.addEvent({
        userId: first.id,
        openid: first.openid,
        eventType: 'finish_exam',
        score: 90,
        total: 100,
      })
      const history = db.getUserExamHistory(first.id, first.openid)
      assert.equal(history.some((item) => item.id === own.id), true)
      assert.equal(db.getUserExamHistory(second.id, second.openid).some((item) => item.id === own.id), false)
    })

    await t.test('schedule save does not write onto another student id or a phone key', async () => {
      const login = await requestJson(port, 'POST', '/api/auth/login', { code: 'dev_code_sched_owner' })
      const owner = db.getUserById(login.json.data.user.id)
      owner.studentId = '250106162099'
      owner.phone = '13812348761'
      const other = db.createOrUpdateUser('openid-sched-other', { studentId: '260101019999' }).user
      const saved = await requestJson(
        port,
        'POST',
        '/api/schedule/user-schedule',
        {
          userKey: other.studentId,
          scheduleData: { studentId: other.studentId, sessions: [{ course: '高等数学' }] },
        },
        { authorization: `Bearer ${login.json.data.token}` }
      )
      assert.equal(saved.status, 200)
      assert.equal(db.getUserSchedule(other.studentId), null)
      assert.equal(db.getUserSchedule(owner.phone), null)
      assert.ok(db.getUserSchedule(owner.openid))
      assert.ok(db.getUserSchedule(owner.studentId))
    })

    await t.test('electricity bind requires a personal key and does not keep another openid balance', async () => {
      const missing = await requestJson(port, 'POST', '/api/electricity/bind', {
        campus: '南校区',
        campusId: 1,
        building: '12号楼',
        buildingId: 303,
        room: '12505',
        roomId: 3253,
      })
      assert.equal(missing.status, 400)
      assert.equal(missing.json.message.includes('本人账号'), true)
      assert.equal(db.saveUserDorm('dorm_南校区_12号楼_12505', { room: '12505', baseBalance: 50 }), null)

      db.saveUserDorm('elec-user-a', { openid: 'elec-user-a', room: '101', baseBalance: 88, meterId: 'meter-a' })
      const replaced = db.saveUserDorm('elec-user-a', { openid: 'elec-user-b', room: '202' })
      assert.equal(replaced.room, '202')
      assert.equal(replaced.openid, 'elec-user-b')
      assert.equal(replaced.baseBalance, undefined)
      assert.equal(replaced.meterId, undefined)
      db.saveUserDorm('elec-user-b', { openid: 'elec-user-b', room: '303', baseBalance: 6 })
      assert.equal(db.getUserDorm('elec-user-b').room, '303')
      assert.equal(db.getUserDorm('elec-user-a').room, '202')
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('cloud import does not merge a user when an openid string equals someone else id', () => {
  const kept = db.createOrUpdateUser('openid-import-kept', { realName: '甲同学' }).user
  db.importCloudUsers([
    { id: 'cloud-new-user', openid: kept.id, realName: '外来考生', nickname: '外来' },
  ])
  assert.equal(db.getUserById(kept.id).openid, 'openid-import-kept')
  assert.equal(db.getUserById(kept.id).realName, '甲同学')
  const imported = db.getUserByOpenid(kept.id)
  assert.ok(imported)
  assert.notEqual(imported.id, kept.id)
  assert.equal(imported.realName, '外来考生')
  assert.equal(imported.isExamUnlocked, true)
})

test('corrupt main database falls back to the daily backup instead of wiping it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ycit-corrupt-'))
  fs.mkdirSync(path.join(dir, 'backups'))
  fs.writeFileSync(
    path.join(dir, 'backups', 'studymaster_2026-10-01.json'),
    JSON.stringify({
      users: [{ id: 'kept-user', openid: 'openid-kept', phone: '', studentId: '' }],
      events: [],
      activationCodes: [],
    })
  )
  fs.writeFileSync(path.join(dir, 'studymaster.json'), '{ this is broken')
  const dbPath = JSON.stringify(path.join(__dirname, '../db.js'))
  const result = runIsolated(
    dir,
    `const db = require(${dbPath}); const users = db.getAllUsers(); console.log(JSON.stringify({ count: users.length, id: users[0] && users[0].id }))`
  )
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout.trim().split('\n').pop())
  assert.equal(payload.count >= 1, true)
  assert.equal(payload.id, 'kept-user')
  const backups = fs.readdirSync(path.join(dir, 'backups'))
  const corrupt = backups.find((name) => name.startsWith('studymaster.corrupt-'))
  assert.ok(corrupt)
  assert.equal(fs.readFileSync(path.join(dir, 'backups', corrupt), 'utf8').includes('this is broken'), true)
})

test('an empty in-memory user list cannot overwrite a populated database file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ycit-nowipe-'))
  fs.writeFileSync(
    path.join(dir, 'studymaster.json'),
    JSON.stringify({
      users: [{ id: 'stay-user', openid: 'openid-stay', phone: '', studentId: '', realName: '保留' }],
      events: [],
      activationCodes: [],
    })
  )
  const dbPath = JSON.stringify(path.join(__dirname, '../db.js'))
  const result = runIsolated(
    dir,
    `const db = require(${dbPath}); const users = db.getAllUsers(); users.splice(0, users.length); db.flushSync(); const raw = JSON.parse(require('fs').readFileSync(require('path').join(process.env.DATA_DIR, 'studymaster.json'), 'utf8')); console.log(String(raw.users.length))`
  )
  assert.equal(result.status, 0, result.stderr)
  const count = Number(result.stdout.trim().split('\n').pop())
  assert.equal(count, 1)
})
