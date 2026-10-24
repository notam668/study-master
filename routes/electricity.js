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
 * 级联查询盐城工学院官方电控系统 (finance.ycit.edu.cn) 的真实校区 / 楼栋 / 房间列表
 * GET /api/electricity/rooms-meta?campusId=1&buildingId=303
 */
router.get('/rooms-meta', async (req, res) => {
  try {
    const campusId = req.query.campusId ? Number(req.query.campusId) : null
    const buildingId = req.query.buildingId ? Number(req.query.buildingId) : null

    const campuses = await electricityService.listCampuses()
    const targetCampusId = campusId || (campuses[0] ? campuses[0].campusId : 1)
    const buildings = await electricityService.listBuildings(targetCampusId)
    const targetBuildingId = buildingId || (buildings[0] ? buildings[0].buildingId : 0)
    const rooms = targetBuildingId ? await electricityService.listRooms(targetBuildingId) : []

    return res.json({
      code: 0,
      data: {
        campuses,
        campusId: targetCampusId,
        buildings,
        buildingId: targetBuildingId,
        rooms,
      },
    })
  } catch (err) {
    return res.status(500).json({ code: 500, message: err.message || '获取宿舍列表失败' })
  }
})

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

  const state = await electricityService.computeRealtimeBalance(record)

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
 */
router.post('/bind', optionalAuth, async (req, res) => {
  const {
    campus = '南校区',
    campusId = 1,
    building = '',
    buildingId = 0,
    room = '',
    roomId = 0,
    meterId = '',
    alertEnabled = true,
    calibratedBalance,
    financeJsessionId = '',
  } = req.body || {}
  const cleanBuilding = String(building || '').trim()
  const cleanRoom = String(room || '').trim()

  if (!cleanBuilding || !cleanRoom) {
    return res.status(400).json({ code: 400, message: '请选择宿舍楼栋与寝室账户（如 南校区 12号楼 125053kt）' })
  }

  const officialDorm = electricityService.resolveOfficialDorm({
    campus,
    campusId,
    building: cleanBuilding,
    buildingId,
    room: cleanRoom,
    roomId,
  })
  if (!officialDorm) {
    return res.status(400).json({ code: 400, message: '官方电费小程序中不存在该房间代码，请核对后重新选择' })
  }

  const userKey = resolveUserKey(req) || `dorm_${officialDorm.campus}_${officialDorm.building}_${officialDorm.room}`
  const openid = (req.user && req.user.openid) || req.headers['x-wx-openid'] || ''

  const patch = {
    campus: officialDorm.campus,
    campusId: officialDorm.campusId,
    building: officialDorm.building,
    buildingId: officialDorm.buildingId,
    room: officialDorm.room,
    roomId: officialDorm.roomId,
    meterId: String(meterId || '').trim(),
    alertEnabled: alertEnabled !== false,
    openid: openid || undefined,
  }

  if (financeJsessionId && String(financeJsessionId).trim()) {
    patch.financeJsessionId = String(financeJsessionId).trim()
  }

  if (calibratedBalance !== undefined && calibratedBalance !== '' && !isNaN(Number(calibratedBalance))) {
    patch.baseBalance = Math.max(0, Number(calibratedBalance))
    patch.baseUpdatedAt = Date.now()
  } else {
    // 切换寝室时如未传校准值，清除旧寝室残留的 baseBalance，以使用真实网关或预置快照
    const existing = db.getUserDorm(userKey)
    if (existing && (existing.room !== cleanRoom || existing.building !== cleanBuilding || existing.campus !== campus)) {
      patch.baseBalance = null
      patch.baseUpdatedAt = null
    }
  }

  const saved = db.saveUserDorm(userKey, patch)
  const state = await electricityService.computeRealtimeBalance(saved)

  let alertResult = null
  if (state.isLowBalance && openid && !openid.startsWith('mock_')) {
    alertResult = await electricityService.triggerLowElectricityAlertIfNeeded(openid, state).catch(() => null)
  }

  return res.json({
    code: 0,
    message: '宿舍电表账户已更新',
    data: {
      bound: true,
      dorm: state,
      alertResult,
      officialMiniApp: electricityService.OFFICIAL_ELEC_APP,
    },
  })
})

module.exports = router
