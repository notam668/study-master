const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const db = require('../db')
const electricity = require('../services/electricityService')

const BOSS_ROOM = {
  campus: '南校区',
  campusId: 1,
  building: '12号楼',
  buildingId: 303,
  room: '12505',
  roomId: 3253,
}

const CONFIG_PATH = '/isims_room/configThisIsimsRoom.action'
const ACQUIRE_PATH = '/isims_room/acquireThisIsimsRoom.action'
const SHARED_TICKET = 'sharedfb-fallback-0001'
const TICKET_A = 'aaaaaaa1-openid-aaa'
const TICKET_B = 'bbbbbbb2-openid-bbb'
const TICKET_B2 = 'ccccccc3-openid-bbb'

function resetSessions() {
  electricity.__resetUserSessionsForTest()
  electricity.__setFinanceSessionForTest(SHARED_TICKET)
  electricity.__setFinanceTransportForTest(null)
}

function installTransport(handler) {
  const calls = []
  electricity.__setFinanceTransportForTest(async (actionPath, method, formBody, sid) => {
    calls.push({ actionPath, method, formBody: String(formBody || ''), sid: String(sid || '') })
    return handler(actionPath, calls, sid)
  })
  return calls
}

function matchingAcquire(remainElec) {
  return { returnCode: 'SUCCESS', remainElec, roomId: 3253, campusId: 1 }
}

async function waitUntil(predicate) {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for electricity session condition')
}

function requestJson(port, method, urlPath, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
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

test('per-user finance session isolation', async (t) => {
  resetSessions()
  try {
    await t.test('two userKeys do not overwrite each other', () => {
      assert.equal(electricity.setUserSession('openid-aaa', `JSESSIONID=${TICKET_A}`, 'test'), true)
      assert.equal(electricity.setUserSession('openid-bbb', TICKET_B, 'test'), true)
      assert.equal(electricity.setUserSession('openid-bbb', TICKET_B2, 'test'), true)
      assert.equal(electricity.setUserSession('', TICKET_A), false)
      assert.equal(electricity.setUserSession('openid-aaa', ''), false)

      assert.equal(electricity.getUserSession('openid-aaa').jsessionId, TICKET_A)
      assert.equal(electricity.getUserSession('openid-bbb').jsessionId, TICKET_B2)
      assert.equal(electricity.getSessionStatus().sessionPrefix, 'sharedfb...')
      assert.equal(electricity.getUserSession('openid-aaa').sessionPrefix, 'aaaaaaaa...')
    })

    await t.test('balance query uses each user ticket and leaves the shared ticket alone', async () => {
      electricity.setUserSession('openid-aaa', TICKET_A, 'test')
      electricity.setUserSession('openid-bbb', TICKET_B, 'test')
      const calls = installTransport((actionPath, _calls, sid) => {
        if (actionPath === CONFIG_PATH) return { returnCode: 'SUCCESS' }
        return matchingAcquire(sid === TICKET_A ? 11.1 : 22.2)
      })

      const resultA = await electricity.fetchLiveRoomBalanceFromFinance({
        campusId: 1,
        roomId: 3253,
        userKey: 'openid-aaa',
      })
      const resultB = await electricity.fetchLiveRoomBalanceFromFinance({
        campusId: 1,
        roomId: 3253,
        userKey: 'openid-bbb',
      })

      assert.equal(resultA.remainElec, 11.1)
      assert.equal(resultB.remainElec, 22.2)
      assert.deepEqual(
        calls.map((call) => call.sid),
        [TICKET_A, TICKET_A, TICKET_B, TICKET_B]
      )
      assert.equal(electricity.getUserSession('openid-aaa').jsessionId, TICKET_A)
      assert.equal(electricity.getUserSession('openid-bbb').jsessionId, TICKET_B)
      assert.equal(electricity.getSessionStatus().sessionPrefix, 'sharedfb...')
    })

    await t.test('different user tickets are not stuck on one global queue', async () => {
      electricity.setUserSession('openid-aaa', TICKET_A, 'test')
      electricity.setUserSession('openid-bbb', TICKET_B, 'test')
      let releaseA
      const gate = new Promise((resolve) => {
        releaseA = resolve
      })
      let aHolding = false
      installTransport(async (actionPath, _calls, sid) => {
        if (actionPath === CONFIG_PATH && sid === TICKET_A) {
          aHolding = true
          await gate
        }
        if (actionPath === CONFIG_PATH) return { returnCode: 'SUCCESS' }
        return matchingAcquire(sid === TICKET_A ? 1.5 : 2.5)
      })

      const pendingA = electricity.fetchLiveRoomBalanceFromFinance({
        campusId: 1,
        roomId: 3253,
        userKey: 'openid-aaa',
      })
      await waitUntil(() => aHolding)
      const resultB = await electricity.fetchLiveRoomBalanceFromFinance({
        campusId: 1,
        roomId: 3253,
        userKey: 'openid-bbb',
      })
      assert.equal(resultB.remainElec, 2.5)
      releaseA()
      const resultA = await pendingA
      assert.equal(resultA.remainElec, 1.5)
      assert.equal(electricity.getUserSession('openid-aaa').jsessionId, TICKET_A)
      assert.equal(electricity.getUserSession('openid-bbb').jsessionId, TICKET_B)
    })

    await t.test('missing user session falls back to the shared ticket without copying it', async () => {
      const calls = installTransport((actionPath) => {
        if (actionPath === CONFIG_PATH) return { returnCode: 'SUCCESS' }
        return matchingAcquire(4.25)
      })

      const result = await electricity.fetchLiveRoomBalanceFromFinance({
        campusId: 1,
        roomId: 3253,
        userKey: 'openid-nobody',
      })

      assert.equal(result.remainElec, 4.25)
      assert.deepEqual(
        calls.map((call) => call.sid),
        [SHARED_TICKET, SHARED_TICKET]
      )
      assert.equal(electricity.getUserSession('openid-nobody'), null)
      assert.equal(electricity.getSessionStatus().sessionPrefix, 'sharedfb...')
    })

    await t.test('missing user session and missing shared ticket returns null', async () => {
      electricity.__setFinanceSessionForTest('')
      const calls = installTransport(() => {
        throw new Error('transport should not be called')
      })

      const result = await electricity.fetchLiveRoomBalanceFromFinance({
        campusId: 1,
        roomId: 3253,
        userKey: 'openid-nobody',
      })

      assert.equal(result, null)
      assert.equal(calls.length, 0)
      electricity.__setFinanceSessionForTest(SHARED_TICKET)
    })

    await t.test('an explicit ticket without userKey does not replace the shared fallback', async () => {
      const calls = installTransport((actionPath) => {
        if (actionPath === CONFIG_PATH) return { returnCode: 'SUCCESS' }
        return matchingAcquire(6)
      })

      const result = await electricity.fetchLiveRoomBalanceFromFinance({
        campusId: 1,
        roomId: 3253,
        jsessionId: 'oneshot9-explicit',
      })

      assert.equal(result.remainElec, 6)
      assert.equal(calls[0].sid, 'oneshot9-explicit')
      assert.equal(electricity.getSessionStatus().sessionPrefix, 'sharedfb...')
      assert.equal(electricity.getUserSession('oneshot9-explicit'), null)
    })

    await t.test('legacy dorm ticket is kept on that user and still enforces room mismatch', async () => {
      electricity.setUserSession('openid-bbb', TICKET_B, 'test')
      const calls = installTransport((actionPath) => {
        if (actionPath === CONFIG_PATH) return { returnCode: 'SUCCESS' }
        return { returnCode: 'SUCCESS', remainElec: 88.88, roomId: 3256, campusId: 1 }
      })

      const result = await electricity.fetchLiveRoomBalanceFromFinance({
        campusId: 1,
        roomId: 3253,
        userKey: 'openid-aaa',
        jsessionId: TICKET_A,
      })

      assert.equal(result.errorCode, 'ROOM_MISMATCH')
      assert.equal(result.requestedRoomId, 3253)
      assert.equal(result.returnedRoomId, 3256)
      assert.equal(Object.hasOwn(result, 'remainElec'), false)
      assert.equal(JSON.stringify(result).includes('88.88'), false)
      assert.deepEqual(
        calls.map((call) => call.actionPath),
        [CONFIG_PATH, ACQUIRE_PATH, CONFIG_PATH, ACQUIRE_PATH]
      )
      assert.ok(calls.every((call) => call.sid === TICKET_A))
      assert.equal(electricity.getUserSession('openid-aaa').jsessionId, TICKET_A)
      assert.equal(electricity.getUserSession('openid-bbb').jsessionId, TICKET_B)
      assert.equal(electricity.getSessionStatus().sessionPrefix, 'sharedfb...')

      const state = await electricity.computeRealtimeBalance({ ...BOSS_ROOM, userKey: 'openid-aaa' })
      assert.equal(state.errorCode, 'ROOM_MISMATCH')
      assert.equal(state.balance, null)
      assert.equal(state.balanceText, '--')
      assert.equal(state.hasValidBalance, false)
      assert.notEqual(state.syncSource, 'finance_live')
      assert.equal(JSON.stringify(state).includes('88.88'), false)
    })

    await t.test('shared fallback stays serial so two users cannot interleave one ticket', async () => {
      let firstHolding = false
      let secondEntered = false
      let releaseFirst
      const gate = new Promise((resolve) => {
        releaseFirst = resolve
      })
      installTransport(async (actionPath) => {
        if (actionPath === CONFIG_PATH && !firstHolding) {
          firstHolding = true
          await gate
          return { returnCode: 'SUCCESS' }
        }
        if (actionPath === CONFIG_PATH) {
          secondEntered = true
          return { returnCode: 'SUCCESS' }
        }
        return matchingAcquire(3)
      })

      const first = electricity.fetchLiveRoomBalanceFromFinance({
        campusId: 1,
        roomId: 3253,
        userKey: 'openid-no-ticket-1',
      })
      await waitUntil(() => firstHolding)
      let secondDone = false
      const second = electricity.fetchLiveRoomBalanceFromFinance({
        campusId: 1,
        roomId: 3253,
        userKey: 'openid-no-ticket-2',
      })
      second.then(() => {
        secondDone = true
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(secondEntered, false)
      assert.equal(secondDone, false)
      releaseFirst()
      const [result1, result2] = await Promise.all([first, second])
      assert.equal(result1.remainElec, 3)
      assert.equal(result2.remainElec, 3)
      assert.equal(secondEntered, true)
      assert.equal(electricity.getUserSession('openid-no-ticket-1'), null)
      assert.equal(electricity.getUserSession('openid-no-ticket-2'), null)
    })

    await t.test('user session file round-trips without touching another user', () => {
      const file = path.join(os.tmpdir(), `elec-user-sessions-${process.pid}-${Date.now()}.json`)
      try {
        electricity.__setUserSessionFileForTest(file)
        electricity.__setFinanceSessionForTest(SHARED_TICKET)
        assert.equal(electricity.setUserSession('openid-aaa', TICKET_A, 'disk'), true)
        assert.equal(electricity.setUserSession('openid-bbb', TICKET_B, 'disk'), true)
        electricity.__setUserSessionFileForTest(file)
        assert.equal(electricity.getUserSession('openid-aaa').jsessionId, TICKET_A)
        assert.equal(electricity.getUserSession('openid-bbb').jsessionId, TICKET_B)
        const raw = fs.readFileSync(file, 'utf8')
        assert.equal(raw.includes(TICKET_A), true)
        assert.equal(electricity.getSessionStatus().sessionPrefix, 'sharedfb...')
      } finally {
        fs.rmSync(file, { force: true })
        fs.rmSync(`${file}.tmp`, { force: true })
        resetSessions()
      }
    })

    await t.test('HTTP session API isolates userKeys and does not echo the ticket', async () => {
      const app = require('../server')
      const server = await new Promise((resolve) => {
        const listening = app.listen(0, () => resolve(listening))
      })
      try {
        const { port } = server.address()
        const savedA = await requestJson(port, 'POST', '/api/electricity/session?userKey=openid-aaa', {
          jsessionId: TICKET_A,
        })
        const savedB = await requestJson(port, 'POST', '/api/electricity/session?userKey=openid-bbb', {
          jsessionId: TICKET_B,
        })
        const replacedB = await requestJson(port, 'POST', '/api/electricity/session?userKey=openid-bbb', {
          jsessionId: TICKET_B2,
        })
        const readA = await requestJson(port, 'GET', '/api/electricity/session?userKey=openid-aaa')
        const readMissing = await requestJson(port, 'GET', '/api/electricity/session?userKey=openid-missing')

        assert.equal(savedA.status, 200)
        assert.equal(savedA.json.data.sessionPrefix, 'aaaaaaaa...')
        assert.equal(savedA.json.data.fallback, 'user')
        assert.equal(savedA.raw.includes(TICKET_A), false)
        assert.equal(savedB.raw.includes(TICKET_B), false)
        assert.equal(replacedB.json.data.sessionPrefix, 'ccccccc3...')
        assert.equal(readA.json.data.sessionPrefix, 'aaaaaaaa...')
        assert.equal(readA.json.data.hasUserSession, true)
        assert.equal(readA.raw.includes(TICKET_A), false)
        assert.equal(readA.raw.includes(SHARED_TICKET), false)
        assert.equal(readMissing.json.data.hasUserSession, false)
        assert.equal(readMissing.json.data.fallback, 'shared')
        assert.equal(readMissing.json.data.sessionPrefix, '')
        assert.equal(readMissing.raw.includes(SHARED_TICKET), false)
        assert.equal(electricity.getUserSession('openid-aaa').jsessionId, TICKET_A)
        assert.equal(electricity.getUserSession('openid-bbb').jsessionId, TICKET_B2)
        assert.equal(electricity.getSessionStatus().sessionPrefix, 'sharedfb...')
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }
    })

    await t.test('bind stores the ticket per user and a mismatched room still has no balance', async () => {
      const app = require('../server')
      const originalGetUserDorm = db.getUserDorm
      const originalSaveUserDorm = db.saveUserDorm
      db.getUserDorm = () => null
      db.saveUserDorm = (userKey, info) => ({ ...BOSS_ROOM, ...info, userKey })
      electricity.setUserSession('openid-bbb', TICKET_B, 'test')
      const calls = installTransport((actionPath) => {
        if (actionPath === CONFIG_PATH) return { returnCode: 'SUCCESS' }
        return { returnCode: 'SUCCESS', remainElec: 88.88, roomId: 3256, campusId: 1 }
      })
      const server = await new Promise((resolve) => {
        const listening = app.listen(0, () => resolve(listening))
      })
      try {
        const { port } = server.address()
        const body = await requestJson(port, 'POST', '/api/electricity/bind?userKey=openid-aaa', {
          campus: '南校区',
          campusId: 1,
          building: '12号楼',
          buildingId: 303,
          room: '12505',
          roomId: 3253,
          financeJsessionId: TICKET_A,
        })

        assert.equal(body.status, 200)
        assert.equal(body.json.data.errorCode, 'ROOM_MISMATCH')
        assert.equal(body.json.data.requestedRoomId, 3253)
        assert.equal(body.json.data.returnedRoomId, 3256)
        assert.equal(body.json.data.dorm.balance, null)
        assert.equal(body.json.data.dorm.unit, '元')
        assert.notEqual(body.json.data.dorm.syncSource, 'finance_live')
        assert.equal(body.raw.includes('88.88'), false)
        assert.equal(body.raw.includes(TICKET_A), false)
        assert.equal(body.raw.includes(SHARED_TICKET), false)
        assert.ok(calls.every((call) => call.sid === TICKET_A))
        assert.equal(electricity.getUserSession('openid-aaa').jsessionId, TICKET_A)
        assert.equal(electricity.getUserSession('openid-bbb').jsessionId, TICKET_B)
        assert.equal(electricity.getSessionStatus().sessionPrefix, 'sharedfb...')
      } finally {
        db.getUserDorm = originalGetUserDorm
        db.saveUserDorm = originalSaveUserDorm
        await new Promise((resolve) => server.close(resolve))
      }
    })
  } finally {
    resetSessions()
  }
})
