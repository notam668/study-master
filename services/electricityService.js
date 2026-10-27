/**
 * 盐城工学院宿舍电费实时查询与低余额 (< 10 元) 微信订阅消息预警服务
 * 真实对接学校财务处电控接口：https://finance.ycit.edu.cn/smart-campus-wechat-server
 * 关联官方电费小程序：盐城工学院电费缴费 (AppID: wx778950b815ae1997, 原始ID: gh_814c29d01b7d)
 */
const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const db = require('../db')
const config = require('../config')
const wxApi = require('./wxApiService')

const OFFICIAL_ELEC_APP = {
  appId: 'wx778950b815ae1997',
  rawId: 'gh_814c29d01b7d',
  name: '盐城工学院电费缴费',
  serverBase: 'https://finance.ycit.edu.cn/smart-campus-wechat-server',
  alertThreshold: 10,
}

// 100% 同步自 finance.ycit.edu.cn 的官方校区-楼栋-房间权威字典
let OFFICIAL_DORM_TREE = []
try {
  const dictPath = path.join(__dirname, '../data/ycit_dorm_rooms.json')
  if (fs.existsSync(dictPath)) {
    OFFICIAL_DORM_TREE = JSON.parse(fs.readFileSync(dictPath, 'utf8'))
  }
} catch (e) {
  console.warn('[Electricity] Failed to load ycit_dorm_rooms.json:', e.message)
}

const metaCache = {
  campuses: null,
  buildingsByCampus: new Map(),
  roomsByBuilding: new Map(),
}

/**
 * 调用盐城工学院财务处电控系统接口 https://finance.ycit.edu.cn/smart-campus-wechat-server
 */
/**
 * 隧道模式（2026-10-26 上线）：云托管容器在公网，直连 finance.ycit.edu.cn 不通，
 * 由内网网关 43.142.152.33（EasyConnect 隧道）代为请求，本端只转发、不落盘票据。
 */
function requestViaBridge(actionPath, method, formBody, cleanCookie) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(process.env.ELEC_BRIDGE_BASE)
    } catch (e) {
      return reject(new Error('ELEC_BRIDGE_BASE 配置非法：' + process.env.ELEC_BRIDGE_BASE))
    }
    const payload = JSON.stringify({ u: actionPath, m: method || 'GET', b: formBody || '', sid: cleanCookie || '' })
    const req = http.request(
      {
        hostname: target.hostname,
        port: Number(target.port) || 80,
        path: target.pathname || '/elec',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        timeout: 25000,
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { raw += c })
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw))
          } catch {
            resolve({ returnCode: 'FAIL', raw: String(raw).slice(0, 300), via: 'bridge' })
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('电费隧道请求超时：' + (process.env.ELEC_BRIDGE_BASE || '')))
    })
    req.write(payload)
    req.end()
  })
}

function requestFinanceServer(actionPath, method = 'GET', formBody = '', jsessionId = '') {
  return new Promise((resolve, reject) => {
    const cleanCookie = String(jsessionId || '')
      .replace(/^Cookie:\s*/i, '')
      .replace(/^JSESSIONID\s*=\s*/i, '')
      .split(';')[0]
      .trim()

    // 配了隧道就走内网网关（云托管生产环境），否则直连（本地/内网调试）
    if (process.env.ELEC_BRIDGE_BASE) {
      return requestViaBridge(actionPath, method, formBody, cleanCookie).then(resolve).catch(reject)
    }

    const headers = {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40',
    }
    if (cleanCookie) {
      headers.Cookie = `JSESSIONID = ${cleanCookie}`
    }

    const req = https.request(
      {
        hostname: 'finance.ycit.edu.cn',
        path: `/smart-campus-wechat-server${actionPath}`,
        method,
        headers,
        timeout: 8000,
        rejectUnauthorized: false,
      },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => {
          raw += chunk
        })
        res.on('end', () => {
          if (res.statusCode === 302 && res.headers.location && res.headers.location.includes('notLogin')) {
            return resolve({ returnCode: 'FAIL', errorCode: 'NOT_LOGIN', errorCodeDesc: '电费系统会话未登录或已过期' })
          }
          try {
            const parsed = JSON.parse(raw)
            resolve(parsed)
          } catch {
            resolve({ returnCode: 'FAIL', raw })
          }
        })
      }
    )

    req.on('error', (err) => reject(err))
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('连接 finance.ycit.edu.cn 超时'))
    })
    if (formBody) req.write(formBody)
    req.end()
  })
}

/**
 * 1. 获取真实校区列表 (0ms 命中官方权威字典)
 */
async function listCampuses() {
  if (OFFICIAL_DORM_TREE.length > 0) {
    return OFFICIAL_DORM_TREE.map((c) => ({
      campusId: c.campusId,
      campusName: c.campusName,
    }))
  }
  if (metaCache.campuses && metaCache.campuses.length > 0) {
    return metaCache.campuses
  }
  try {
    const res = await requestFinanceServer('/isims_room/listCampus.action', 'GET')
    if (res && res.returnCode === 'SUCCESS' && Array.isArray(res.isimsRooms)) {
      metaCache.campuses = res.isimsRooms
      return res.isimsRooms
    }
  } catch (e) {
    console.warn('[Electricity] listCampuses error:', e.message)
  }
  return [
    { campusId: 1, campusName: '南校区' },
    { campusId: 2, campusName: '北校区' },
  ]
}

/**
 * 2. 根据 campusId 获取真实楼栋列表 (0ms 命中官方权威字典，已清理重复与换行符)
 */
async function listBuildings(campusId = 1) {
  const cid = Number(campusId) || 1
  if (OFFICIAL_DORM_TREE.length > 0) {
    const campus = OFFICIAL_DORM_TREE.find((c) => c.campusId === cid) || OFFICIAL_DORM_TREE[0]
    if (campus && Array.isArray(campus.buildings)) {
      return campus.buildings.map((b) => ({
        buildingId: b.buildingId,
        buildingName: b.buildingName,
      }))
    }
  }
  if (metaCache.buildingsByCampus.has(cid)) {
    return metaCache.buildingsByCampus.get(cid)
  }
  try {
    const res = await requestFinanceServer(
      '/isims_room/listBuildingByCampus.action',
      'POST',
      `isimsRoom.campusId=${encodeURIComponent(cid)}`
    )
    if (res && res.returnCode === 'SUCCESS' && Array.isArray(res.isimsRooms)) {
      metaCache.buildingsByCampus.set(cid, res.isimsRooms)
      return res.isimsRooms
    }
  } catch (e) {
    console.warn('[Electricity] listBuildings error:', e.message)
  }
  return []
}

/**
 * 3. 根据 buildingId 获取真实房间列表（含照明与 kt 空调电表）(0ms 命中官方权威字典)
 */
async function listRooms(buildingId) {
  const bid = Number(buildingId)
  if (!bid) return []
  if (OFFICIAL_DORM_TREE.length > 0) {
    for (const c of OFFICIAL_DORM_TREE) {
      const b = (c.buildings || []).find((item) => item.buildingId === bid)
      if (b && Array.isArray(b.rooms)) {
        return b.rooms
      }
    }
  }
  if (metaCache.roomsByBuilding.has(bid)) {
    return metaCache.roomsByBuilding.get(bid)
  }
  try {
    const res = await requestFinanceServer(
      '/isims_room/listRoomByBuilding.action',
      'POST',
      `isimsRoom.buildingId=${encodeURIComponent(bid)}`
    )
    if (res && res.returnCode === 'SUCCESS' && Array.isArray(res.isimsRooms)) {
      metaCache.roomsByBuilding.set(bid, res.isimsRooms)
      return res.isimsRooms
    }
  } catch (e) {
    console.warn('[Electricity] listRooms error:', e.message)
  }
  return []
}

/**
 * 校验并解析是否在官方「盐城工学院电费缴费」小程序中真实存在该楼栋与房间
 * 如果官方电费小程序中没有，严禁通过！
 */
function resolveOfficialDorm({ campus, campusId, building, buildingId, room, roomId }) {
  if (!OFFICIAL_DORM_TREE || OFFICIAL_DORM_TREE.length === 0) {
    return {
      campus: campus || '南校区',
      campusId: Number(campusId) || 1,
      building: String(building || '').trim(),
      buildingId: Number(buildingId) || 0,
      room: String(room || '').trim(),
      roomId: Number(roomId) || 0,
    }
  }

  const cid = Number(campusId) || (String(campus || '').includes('北') ? 2 : 1)
  const campusObj =
    OFFICIAL_DORM_TREE.find((c) => c.campusId === cid) ||
    OFFICIAL_DORM_TREE.find((c) => c.campusName === String(campus || '').trim())
  if (!campusObj) return null

  const bid = Number(buildingId) || 0
  const cleanBName = String(building || '').trim()
  const normBNum = cleanBName.replace(/号楼|栋/g, '').trim()

  const buildingObj =
    campusObj.buildings.find((b) => bid && b.buildingId === bid) ||
    campusObj.buildings.find((b) => b.buildingName === cleanBName) ||
    (normBNum ? campusObj.buildings.find((b) => b.buildingName === `${normBNum}号楼`) : null)
  if (!buildingObj) return null

  const rid = Number(roomId) || 0
  const cleanRName = String(room || '').trim().toLowerCase()
  const roomObj =
    buildingObj.rooms.find((r) => rid && r.roomId === rid) ||
    buildingObj.rooms.find((r) => r.roomName.toLowerCase() === cleanRName)
  if (!roomObj) return null

  return {
    campus: campusObj.campusName,
    campusId: campusObj.campusId,
    building: buildingObj.buildingName,
    buildingId: buildingObj.buildingId,
    room: roomObj.roomName,
    roomId: roomObj.roomId,
  }
}

// ───────────────────────── 会话票管理（真实登录态，禁止硬编码死票） ─────────────────────────
const SESSION_FILE = path.join(__dirname, '../data/elec-session.json')

function loadSessionFromDisk() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const j = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))
      if (j && j.jsessionId) return String(j.jsessionId).trim()
    }
  } catch (e) {
    console.warn('[Electricity] 读取会话文件失败:', e.message)
  }
  return ''
}

let financeSession = String(process.env.YCIT_FINANCE_JSESSIONID || '').trim() || loadSessionFromDisk()
let sessionSavedAt = Date.now()
let sessionOkAt = 0
let sessionFailAt = 0

function cleanSessionId(sid) {
  return String(sid || '')
    .replace(/^Cookie:\s*/i, '')
    .replace(/^JSESSIONID\s*=\s*/i, '')
    .split(';')[0]
    .trim()
}

/** 更新并落盘会话票（部署后容器重启也能读回） */
function setSession(sid, source = 'manual') {
  const clean = cleanSessionId(sid)
  if (!clean) return false
  financeSession = clean
  sessionSavedAt = Date.now()
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true })
    fs.writeFileSync(
      SESSION_FILE,
      JSON.stringify({ jsessionId: clean, updatedAt: Date.now(), source }, null, 1),
      'utf8'
    )
  } catch (e) {
    console.warn('[Electricity] 会话票落盘失败:', e.message)
  }
  console.log('[Electricity] 会话票已更新，来源:', source)
  return true
}

function getSessionStatus() {
  return {
    hasSession: Boolean(financeSession),
    sessionPrefix: financeSession ? financeSession.slice(0, 8) + '...' : '',
    savedAt: sessionSavedAt,
    lastOkAt: sessionOkAt,
    lastFailAt: sessionFailAt,
    alive: sessionOkAt > 0 && sessionOkAt > sessionFailAt,
  }
}

// 串行队列：学校系统一个会话只有一个"当前绑定房间"，
// 并发查不同房间会互相踩，必须串行。
let financeChain = Promise.resolve()
function enqueueFinance(task) {
  const run = financeChain.then(task, task)
  financeChain = run.then(
    () => {},
    () => {}
  )
  return run
}

// 测试可替换财务处传输层；生产路径始终走 requestFinanceServer（含隧道）。
let financeTransport = requestFinanceServer

function toRoomId(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) return null
  return n
}

function readAcquireRoom(res) {
  if (!res || typeof res !== 'object') return { roomId: null, campusId: null }
  return {
    roomId: toRoomId(res.roomId),
    campusId: toRoomId(res.campusId),
  }
}

/**
 * 请求房间与财务处 acquire 返回的当前房间必须是同一间。
 * 官方字典里 roomId 跨校区会重复（南校区 12505 与北校区另一间都是 3253），
 * 所以返回里带了 campusId 时也要一致。对不上、或缺 roomId，都不能采信余额。
 */
function isSameFinanceRoom(requestedCampusId, requestedRoomId, returnedCampusId, returnedRoomId) {
  if (requestedRoomId == null || returnedRoomId == null) return false
  if (requestedRoomId !== returnedRoomId) return false
  if (requestedCampusId != null && returnedCampusId != null && requestedCampusId !== returnedCampusId) {
    return false
  }
  return true
}

function mismatchResult(requestedCampusId, requestedRoomId, returnedCampusId, returnedRoomId) {
  return {
    errorCode: 'ROOM_MISMATCH',
    requestedRoomId,
    returnedRoomId,
    requestedCampusId,
    returnedCampusId,
  }
}

function isTrustedLiveBalance(liveData, campusId, roomId) {
  if (!liveData || liveData.errorCode) return false
  if (typeof liveData.remainElec !== 'number' || Number.isNaN(liveData.remainElec)) return false
  const requestedRoomId = toRoomId(liveData.requestedRoomId != null ? liveData.requestedRoomId : roomId)
  const returnedRoomId = toRoomId(liveData.returnedRoomId != null ? liveData.returnedRoomId : liveData.roomId)
  const requestedCampusId = toRoomId(
    liveData.requestedCampusId != null ? liveData.requestedCampusId : campusId
  )
  const returnedCampusId = toRoomId(liveData.returnedCampusId)
  return isSameFinanceRoom(requestedCampusId, requestedRoomId, returnedCampusId, returnedRoomId)
}

/**
 * 共享会话被改到别的房间时，不能把那笔余额当成 finance_live 成功结果。
 * 用户自己校准的余额（syncSource=user_calibrated）不受影响。
 */
function guardRoomMismatch(state) {
  if (!state || typeof state !== 'object') return state
  const next = { ...state, unit: '元' }
  if (next.errorCode !== 'ROOM_MISMATCH' || next.syncSource !== 'finance_live') return next
  return {
    ...next,
    balance: null,
    balanceText: '--',
    hasValidBalance: false,
    isLowBalance: false,
    syncSource: 'room_mismatch',
    statusText: '房间不一致，未采用实时余额',
    statusLevel: 'unknown',
    unit: '元',
  }
}

/**
 * 4. 通过 finance.ycit.edu.cn 查询指定寝室的实时剩余金额（串行执行）
 *    先 config 到目标房间再 acquire。返回房间与请求房间不一致时，
 *    在同一串行段内重试一次（重新 config + acquire）；仍然不一致则
 *    ROOM_MISMATCH，响应只带 requestedRoomId / returnedRoomId，不带余额。
 */
async function fetchLiveRoomBalanceFromFinance({ campusId, roomId, jsessionId }) {
  if (jsessionId) setSession(jsessionId, 'caller')
  if (!financeSession || !campusId || !roomId) return null

  return enqueueFinance(async () => {
    try {
      const requestedRoomId = toRoomId(roomId)
      const requestedCampusId = toRoomId(campusId)
      let mismatch = null

      for (let attempt = 1; attempt <= 2; attempt++) {
        const bind = await financeTransport(
          '/isims_room/configThisIsimsRoom.action',
          'POST',
          `isimsRoom.campusId=${encodeURIComponent(campusId)}&isimsRoom.roomId=${encodeURIComponent(roomId)}`,
          financeSession
        )
        if (bind && bind.errorCode === 'NOT_LOGIN') {
          sessionFailAt = Date.now()
          return null
        }

        const res = await financeTransport('/isims_room/acquireThisIsimsRoom.action', 'GET', '', financeSession)
        if (res && res.errorCode === 'NOT_LOGIN') {
          sessionFailAt = Date.now()
          return null
        }

        const looksLive =
          res && res.returnCode === 'SUCCESS' && res.remainElec !== undefined && res.remainElec !== null && res.remainElec !== ''
        if (!looksLive) {
          return mismatch || null
        }

        const returned = readAcquireRoom(res)
        if (!isSameFinanceRoom(requestedCampusId, requestedRoomId, returned.campusId, returned.roomId)) {
          mismatch = mismatchResult(requestedCampusId, requestedRoomId, returned.campusId, returned.roomId)
          console.warn(
            '[Electricity] ROOM_MISMATCH requestedRoom=%s returnedRoom=%s requestedCampus=%s returnedCampus=%s attempt=%s',
            requestedRoomId,
            returned.roomId,
            requestedCampusId,
            returned.campusId,
            attempt
          )
          continue
        }

        const amount = Number(res.remainElec)
        if (!Number.isFinite(amount)) return mismatch || null

        sessionOkAt = Date.now()
        return {
          remainElec: Number(amount.toFixed(2)),
          isimsRoomName: res.isimsRoomName || '',
          roomId: returned.roomId,
          campusId: returned.campusId || requestedCampusId,
          requestedRoomId,
          returnedRoomId: returned.roomId,
          requestedCampusId,
          returnedCampusId: returned.campusId,
        }
      }

      return mismatch
    } catch (e) {
      console.warn('[Electricity] fetchLiveRoomBalanceFromFinance failed:', e.message)
    }
    return null
  })
}

/**
 * 5. 会话保活：每 10 分钟打一次需登录接口，让学校 Session 不过期
 *    死票无法复活，只能从官方小程序重新抓；此函数保证活票一直活。
 */
async function keepaliveOnce() {
  if (!financeSession) return false
  try {
    const res = await requestFinanceServer('/wechat_user/acquireThisWechatUser.action', 'GET', '', financeSession)
    if (res && res.returnCode === 'SUCCESS') {
      sessionOkAt = Date.now()
      return true
    }
    sessionFailAt = Date.now()
    return false
  } catch (e) {
    sessionFailAt = Date.now()
    return false
  }
}

let keepaliveTimer = null
function startSessionKeepalive(intervalMs = 10 * 60 * 1000) {
  if (keepaliveTimer) return keepaliveTimer
  const tick = () => {
    keepaliveOnce().catch(() => {})
  }
  tick()
  keepaliveTimer = setInterval(tick, intervalMs)
  if (keepaliveTimer.unref) keepaliveTimer.unref()
  console.log('[Electricity] 电费会话保活已启动，间隔', Math.round(intervalMs / 60000), '分钟')
  return keepaliveTimer
}

/**
 * 计算/获取宿舍电表状态（严禁使用哈希随机数造假！）
 */
async function computeRealtimeBalance(dormRecord = {}) {
  const resolved = resolveOfficialDorm(dormRecord) || {
    campus: dormRecord.campus || '南校区',
    campusId: Number(dormRecord.campusId) || 1,
    building: dormRecord.building || '12号楼',
    buildingId: Number(dormRecord.buildingId) || 0,
    room: String(dormRecord.room || '').trim(),
    roomId: Number(dormRecord.roomId) || 0,
  }

  const { campus, campusId, building, buildingId, room, roomId } = resolved
  const now = Date.now()

  let liveBalance = null
  let syncSource = 'calibrated'
  let liveRoomCheck = null

  // 1. 优先尝试从 finance.ycit.edu.cn 实时拉取。房间不一致时不得把别人的余额标成 finance_live。
  if (campusId && roomId) {
    const liveData = await fetchLiveRoomBalanceFromFinance({
      campusId,
      roomId,
      jsessionId: dormRecord.financeJsessionId,
    })
    if (liveData && liveData.errorCode === 'ROOM_MISMATCH') {
      liveRoomCheck = {
        errorCode: 'ROOM_MISMATCH',
        requestedRoomId: liveData.requestedRoomId,
        returnedRoomId: liveData.returnedRoomId,
        requestedCampusId: liveData.requestedCampusId,
        returnedCampusId: liveData.returnedCampusId,
      }
    } else if (isTrustedLiveBalance(liveData, campusId, roomId)) {
      liveBalance = liveData.remainElec
      syncSource = 'finance_live'
      liveRoomCheck = {
        requestedRoomId: liveData.requestedRoomId,
        returnedRoomId: liveData.returnedRoomId,
        requestedCampusId: liveData.requestedCampusId,
        returnedCampusId: liveData.returnedCampusId,
      }
    }
  }

  // 2. 其次使用用户/管理员校准的真实电量
  if (liveBalance === null && typeof dormRecord.baseBalance === 'number' && !isNaN(dormRecord.baseBalance)) {
    liveBalance = Number(dormRecord.baseBalance.toFixed(2))
    syncSource = 'user_calibrated'
  }

  const hasValidBalance = typeof liveBalance === 'number' && !isNaN(liveBalance)
  const currentBalance = hasValidBalance ? liveBalance : null
  const balanceText = hasValidBalance ? liveBalance.toFixed(2) : '--'
  const isLow = hasValidBalance && currentBalance < OFFICIAL_ELEC_APP.alertThreshold

  const fullAccountName = `${campus}${building}${room}`

  return guardRoomMismatch({
    campus,
    campusId,
    building,
    buildingId,
    room,
    roomId,
    fullAccountName,
    meterId: dormRecord.meterId || (roomId ? `ISIMS-${campusId}-${roomId}` : fullAccountName),
    balance: currentBalance,
    balanceText,
    hasValidBalance,
    syncSource,
    unit: '元',
    alertThreshold: OFFICIAL_ELEC_APP.alertThreshold,
    isLowBalance: isLow,
    statusText:
      liveRoomCheck && liveRoomCheck.errorCode === 'ROOM_MISMATCH' && !hasValidBalance
        ? '房间不一致，未采用实时余额'
        : !hasValidBalance
        ? '待同步当前电量'
        : isLow
        ? `剩余 ${currentBalance} 元 · 低于${OFFICIAL_ELEC_APP.alertThreshold}元预警`
        : currentBalance < 25
        ? '余额偏低 · 建议留意'
        : `余额充足 · 低于${OFFICIAL_ELEC_APP.alertThreshold}元自动提醒`,
    statusLevel: !hasValidBalance ? 'unknown' : isLow ? 'danger' : currentBalance < 25 ? 'warning' : 'normal',
    alertEnabled: dormRecord.alertEnabled !== false,
    lastCheckedAt: now,
    officialMiniApp: OFFICIAL_ELEC_APP,
    ...(liveRoomCheck && liveRoomCheck.errorCode ? { errorCode: liveRoomCheck.errorCode } : {}),
    ...(liveRoomCheck
      ? {
          requestedRoomId: liveRoomCheck.requestedRoomId,
          returnedRoomId: liveRoomCheck.returnedRoomId,
          ...(liveRoomCheck.requestedCampusId != null
            ? { requestedCampusId: liveRoomCheck.requestedCampusId }
            : {}),
          ...(liveRoomCheck.returnedCampusId != null ? { returnedCampusId: liveRoomCheck.returnedCampusId } : {}),
        }
      : {}),
  })
}

/**
 * 当检测到电量 < 10 度时，向绑定该寝室的微信用户发送低电费预警服务通知
 */
async function triggerLowElectricityAlertIfNeeded(openid, dormState) {
  if (!openid || !dormState || !dormState.hasValidBalance || !dormState.isLowBalance || dormState.alertEnabled === false) {
    return { sent: false, reason: '未达预警条件或未开启提醒' }
  }

  const tzOffsetMs = 8 * 3600 * 1000
  const todayZero = Math.floor((Date.now() + tzOffsetMs) / 86400000) * 86400000 - tzOffsetMs
  if (dormState.lastAlertSentAt && dormState.lastAlertSentAt >= todayZero) {
    return { sent: false, reason: '今日已发送过低电费预警通知' }
  }

  const reminderCfg = db.getReminderConfig() || {}
  const templateId =
    reminderCfg.electricityTemplateId ||
    reminderCfg.templateId ||
    config.wxReminderTemplateId

  if (!templateId) {
    return { sent: false, reason: '尚未配置订阅消息模板 ID' }
  }

  const roomLabel = dormState.fullAccountName || `${dormState.campus}${dormState.building}${dormState.room}`
  const nowStr = new Date(Date.now() + tzOffsetMs).toISOString().slice(0, 16).replace('T', ' ')

  try {
    const sendRes = await wxApi.sendSubscribeMessage({
      openid,
      templateId,
      page: 'pages/home/home',
      data: {
        thing1: { value: `电费预警：${roomLabel}`.slice(0, 20) },
        time3: { value: nowStr },
        thing2: { value: `剩余电费${dormState.balance}元，即将用完`.slice(0, 20) },
      },
    })
    if (sendRes && sendRes.ok) {
      db.saveUserDorm(openid, { lastAlertSentAt: Date.now() })
      return { sent: true, msgid: sendRes.msgid }
    }
    return { sent: false, reason: sendRes ? sendRes.errmsg : '微信接口未返回成功' }
  } catch (err) {
    return { sent: false, reason: err.message }
  }
}

function __setFinanceTransportForTest(fn) {
  financeTransport = typeof fn === 'function' ? fn : requestFinanceServer
}

function __setFinanceSessionForTest(sid) {
  financeSession = cleanSessionId(sid)
  sessionOkAt = 0
  sessionFailAt = 0
}

module.exports = {
  OFFICIAL_ELEC_APP,
  listCampuses,
  listBuildings,
  listRooms,
  resolveOfficialDorm,
  computeRealtimeBalance,
  fetchLiveRoomBalanceFromFinance,
  guardRoomMismatch,
  triggerLowElectricityAlertIfNeeded,
  setSession,
  getSessionStatus,
  keepaliveOnce,
  startSessionKeepalive,
  __setFinanceTransportForTest,
  __setFinanceSessionForTest,
}
