const express = require('express')
const router = express.Router()
const db = require('../db')
const { optionalAuth } = require('../middleware/auth')
const electricityService = require('../services/electricityService')

function resolveUserKey(req) {
  if (req.user) {
    return req.user.openid || req.user.id || req.user.studentId || ''
  }
  return (
    req.headers['x-wx-openid'] ||
    (req.query && req.query.userKey) ||
    (req.body && req.body.userKey) ||
    ''
  )
}

/**
 * 查询当前用户绑定的宿舍实时电费余量与预警状态
 * GET /api/electricity/status
 */
router.get('/status', optionalAuth, async (req, res) => {
  const userKey = resolveUserKey(req)
  const record = userKey ? db.getUserDorm(userKey) : null

  if (!record || !record.room) {
    return res.json({
      code: 0,
      data: {
        bound: false,
        officialMiniApp: electricityService.OFFICIAL_ELEC_APP,
      },
    })
  }

  const state = electricityService.computeRealtimeBalance(record)

  // 当余额低于 10 度且存在有效微信 openid 时，自动触发低电费微信服务通知
  const openid = (req.user && req.user.openid) || req.headers['x-wx-openid'] || record.openid || ''
  if (state.isLowBalance && openid && !openid.startsWith('mock_')) {
    electricityService.triggerLowElectricityAlertIfNeeded(openid, state).catch(() => {})
  }

  return res.json({
    code: 0,
    data: {
      bound: true,
      dorm: state,
      officialMiniApp: electricityService.OFFICIAL_ELEC_APP,
    },
  })
})

/**
 * 绑定寝室或同步电表电量与低电费预警设置
 * POST /api/electricity/bind
 * Body: { campus, building, room, meterId?, alertEnabled?, calibratedBalance? }
 */
router.post('/bind', optionalAuth, async (req, res) => {
  const { campus = '北校区', building = '', room = '', meterId = '', alertEnabled = true, calibratedBalance } = req.body || {}
  const cleanBuilding = String(building || '').trim()
  const cleanRoom = String(room || '').trim()

  if (!cleanBuilding || !cleanRoom) {
    return res.status(400).json({ code: 400, message: '请选择或填写宿舍楼栋与寝室号（如 5号楼 302）' })
  }

  const userKey = resolveUserKey(req) || `dorm_${campus}_${cleanBuilding}_${cleanRoom}`
  const openid = (req.user && req.user.openid) || req.headers['x-wx-openid'] || ''

  const patch = {
    campus,
    building: cleanBuilding,
    room: cleanRoom,
    meterId: String(meterId || '').trim(),
    alertEnabled: alertEnabled !== false,
    openid: openid || undefined,
  }

  if (calibratedBalance !== undefined && calibratedBalance !== '' && !isNaN(Number(calibratedBalance))) {
    patch.baseBalance = Math.max(0, Number(calibratedBalance))
    patch.baseUpdatedAt = Date.now()
  }

  const saved = db.saveUserDorm(userKey, patch)
  const state = electricityService.computeRealtimeBalance(saved)

  // 若绑定/校准后电量已低于 10 度，立即检测并推送预警通知
  let alertResult = null
  if (state.isLowBalance && openid && !openid.startsWith('mock_')) {
    alertResult = await electricityService.triggerLowElectricityAlertIfNeeded(openid, state).catch(() => null)
  }

  return res.json({
    code: 0,
    message: '寝室电表绑定成功',
    data: {
      bound: true,
      dorm: state,
      alertResult,
      officialMiniApp: electricityService.OFFICIAL_ELEC_APP,
    },
  })
})

module.exports = router
