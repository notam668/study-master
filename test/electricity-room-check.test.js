const assert = require('node:assert/strict')
const http = require('node:http')
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

function installTransport(handler) {
  const calls = []
  electricity.__setFinanceSessionForTest('unit-test-session')
  electricity.__setFinanceTransportForTest(async (actionPath, method, formBody) => {
    calls.push({ actionPath, method, formBody: String(formBody || '') })
    return handler(actionPath, calls)
  })
  return calls
}

function assertConfiguredForBossRoom(calls) {
  const configs = calls.filter((call) => call.actionPath === CONFIG_PATH)
  assert.ok(configs.length >= 1)
  for (const call of configs) {
    assert.equal(call.method, 'POST')
    assert.ok(call.formBody.includes('isimsRoom.campusId=1'))
    assert.ok(call.formBody.includes('isimsRoom.roomId=3253'))
  }
}

test('shared finance session room consistency', async (t) => {
  try {
    await t.test('mismatch fails and does not return the foreign balance', async () => {
      const calls = installTransport((actionPath) => {
        if (actionPath === CONFIG_PATH) return { returnCode: 'SUCCESS' }
        return {
          returnCode: 'SUCCESS',
          remainElec: 88.88,
          roomId: 3256,
          campusId: 1,
          isimsRoomName: '125053kt',
        }
      })

      const result = await electricity.fetchLiveRoomBalanceFromFinance({ campusId: 1, roomId: 3253 })

      assert.equal(result.errorCode, 'ROOM_MISMATCH')
      assert.equal(result.requestedRoomId, 3253)
      assert.equal(result.returnedRoomId, 3256)
      assert.equal(Object.hasOwn(result, 'remainElec'), false)
      assert.equal(JSON.stringify(result).includes('88.88'), false)
      assert.deepEqual(
        calls.map((call) => call.actionPath),
        [CONFIG_PATH, ACQUIRE_PATH, CONFIG_PATH, ACQUIRE_PATH]
      )
      assertConfiguredForBossRoom(calls)
    })

    await t.test('same room id on another campus is still a mismatch', async () => {
      installTransport((actionPath) => {
        if (actionPath === CONFIG_PATH) return { returnCode: 'SUCCESS' }
        return { returnCode: 'SUCCESS', remainElec: 66.66, roomId: '3253', campusId: 2 }
      })

      const result = await electricity.fetchLiveRoomBalanceFromFinance({ campusId: 1, roomId: 3253 })

      assert.equal(result.errorCode, 'ROOM_MISMATCH')
      assert.equal(result.requestedRoomId, 3253)
      assert.equal(result.returnedRoomId, 3253)
      assert.equal(result.returnedCampusId, 2)
      assert.equal(JSON.stringify(result).includes('66.66'), false)
    })

    await t.test('missing returned room id fails closed', async () => {
      installTransport((actionPath) => {
        if (actionPath === CONFIG_PATH) return { returnCode: 'SUCCESS' }
        return { returnCode: 'SUCCESS', remainElec: 12.5, campusId: 1 }
      })

      const result = await electricity.fetchLiveRoomBalanceFromFinance({ campusId: 1, roomId: 3253 })

      assert.equal(result.errorCode, 'ROOM_MISMATCH')
      assert.equal(result.requestedRoomId, 3253)
      assert.equal(result.returnedRoomId, null)
      assert.equal(Object.hasOwn(result, 'remainElec'), false)
    })

    await t.test('matching room succeeds', async () => {
      const calls = installTransport((actionPath) => {
        if (actionPath === CONFIG_PATH) return { returnCode: 'SUCCESS' }
        return { returnCode: 'SUCCESS', remainElec: '19.20', roomId: '3253', campusId: '1' }
      })

      const result = await electricity.fetchLiveRoomBalanceFromFinance({ campusId: 1, roomId: 3253 })

      assert.equal(result.remainElec, 19.2)
      assert.equal(result.errorCode, undefined)
      assert.equal(result.requestedRoomId, 3253)
      assert.equal(result.returnedRoomId, 3253)
      assert.deepEqual(
        calls.map((call) => call.actionPath),
        [CONFIG_PATH, ACQUIRE_PATH]
      )
    })

    await t.test('one mismatch then a matching retry succeeds', async () => {
      let acquires = 0
      installTransport((actionPath) => {
        if (actionPath === CONFIG_PATH) return { returnCode: 'SUCCESS' }
        acquires += 1
        if (acquires === 1) return { returnCode: 'SUCCESS', remainElec: 88.88, roomId: 3256, campusId: 1 }
        return { returnCode: 'SUCCESS', remainElec: 19.2, roomId: 3253, campusId: 1 }
      })

      const result = await electricity.fetchLiveRoomBalanceFromFinance({ campusId: 1, roomId: 3253 })

      assert.equal(acquires, 2)
      assert.equal(result.remainElec, 19.2)
      assert.equal(result.requestedRoomId, 3253)
      assert.equal(result.returnedRoomId, 3253)
      assert.equal(result.errorCode, undefined)
    })

    await t.test('status balance ignores a mismatched live room', async () => {
      installTransport((actionPath) => {
        if (actionPath === CONFIG_PATH) return { returnCode: 'SUCCESS' }
        return { returnCode: 'SUCCESS', remainElec: 88.88, roomId: 3256, campusId: 1 }
      })

      const state = await electricity.computeRealtimeBalance(BOSS_ROOM)

      assert.equal(state.errorCode, 'ROOM_MISMATCH')
      assert.equal(state.requestedRoomId, 3253)
      assert.equal(state.returnedRoomId, 3256)
      assert.equal(state.balance, null)
      assert.equal(state.balanceText, '--')
      assert.equal(state.hasValidBalance, false)
      assert.notEqual(state.syncSource, 'finance_live')
      assert.equal(state.unit, '元')
      assert.equal(JSON.stringify(state).includes('88.88'), false)

      const calibrated = await electricity.computeRealtimeBalance({ ...BOSS_ROOM, baseBalance: 3.5 })
      assert.equal(calibrated.errorCode, 'ROOM_MISMATCH')
      assert.equal(calibrated.balance, 3.5)
      assert.equal(calibrated.syncSource, 'user_calibrated')
      assert.equal(calibrated.unit, '元')
      assert.equal(JSON.stringify(calibrated).includes('88.88'), false)
    })

    await t.test('matching live balance is returned in yuan', async () => {
      installTransport((actionPath) => {
        if (actionPath === CONFIG_PATH) return { returnCode: 'SUCCESS' }
        return { returnCode: 'SUCCESS', remainElec: 19.2, roomId: 3253, campusId: 1 }
      })

      const state = await electricity.computeRealtimeBalance(BOSS_ROOM)

      assert.equal(state.balance, 19.2)
      assert.equal(state.syncSource, 'finance_live')
      assert.equal(state.unit, '元')
      assert.equal(state.requestedRoomId, 3253)
      assert.equal(state.returnedRoomId, 3253)
      assert.equal(state.errorCode, undefined)
      assert.equal(state.room, '12505')
    })

    await t.test('guard strips a finance_live balance that arrived with ROOM_MISMATCH', () => {
      const safe = electricity.guardRoomMismatch({
        balance: 88.88,
        balanceText: '88.88',
        hasValidBalance: true,
        isLowBalance: false,
        syncSource: 'finance_live',
        errorCode: 'ROOM_MISMATCH',
        requestedRoomId: 3253,
        returnedRoomId: 3256,
        unit: '度',
      })

      assert.equal(safe.balance, null)
      assert.equal(safe.balanceText, '--')
      assert.equal(safe.hasValidBalance, false)
      assert.equal(safe.syncSource, 'room_mismatch')
      assert.equal(safe.unit, '元')
      assert.equal(safe.requestedRoomId, 3253)
      assert.equal(safe.returnedRoomId, 3256)
      assert.equal(JSON.stringify(safe).includes('88.88'), false)
    })

    await t.test('GET /api/electricity/status does not fill a mismatched balance', async () => {
      const app = require('../server')
      const originalGetUserDorm = db.getUserDorm
      db.getUserDorm = (userKey) => (userKey ? { ...BOSS_ROOM } : null)
      installTransport((actionPath) => {
        if (actionPath === CONFIG_PATH) return { returnCode: 'SUCCESS' }
        return {
          returnCode: 'SUCCESS',
          remainElec: 88.88,
          roomId: 3256,
          campusId: 1,
          isimsRoomName: '125053kt',
        }
      })

      const server = await new Promise((resolve) => {
        const listening = app.listen(0, () => resolve(listening))
      })
      try {
        const { port } = server.address()
        const body = await new Promise((resolve, reject) => {
          const req = http.get(
            { hostname: '127.0.0.1', port, path: '/api/electricity/status?userKey=boss-12505' },
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
        })

        assert.equal(body.status, 200)
        assert.equal(body.json.code, 0)
        assert.equal(body.json.data.errorCode, 'ROOM_MISMATCH')
        assert.equal(body.json.data.requestedRoomId, 3253)
        assert.equal(body.json.data.returnedRoomId, 3256)
        assert.equal(body.json.data.dorm.balance, null)
        assert.equal(body.json.data.dorm.unit, '元')
        assert.notEqual(body.json.data.dorm.syncSource, 'finance_live')
        assert.equal(body.raw.includes('88.88'), false)
      } finally {
        db.getUserDorm = originalGetUserDorm
        await new Promise((resolve) => server.close(resolve))
      }
    })
  } finally {
    electricity.__setFinanceTransportForTest(null)
    electricity.__setFinanceSessionForTest('')
  }
})
