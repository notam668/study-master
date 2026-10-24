/**
 * 线上腾讯云托管真实数据拉取与同步服务
 */
const fs = require('fs')
const path = require('path')
const axios = require('axios')
const db = require('../db')
const config = require('../config')
const wxApi = require('./wxApiService')

const REMOTE_URL = 'https://studymaster-299598-11-1471610879.sh.run.tcloudbase.com'
const MIN_SYNC_INTERVAL_MS = 15 * 1000

let lastSyncInfo = {
  lastSyncAt: null,
  lastStatus: 'pending',
  pingMs: 0,
  error: null,
  userCount: 0,
  examCount: 0,
}

// 自动备份
function createDailyBackup() {
  try {
    const backupDir = path.join(config.dataDir, 'backups')
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true })
    }
    const today = new Date().toISOString().slice(0, 10)
    const backupPath = path.join(backupDir, `studymaster_${today}.json`)
    const srcPath = path.join(config.dataDir, 'studymaster.json')
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, backupPath)
    }
  } catch (err) {
    console.warn('[CloudSync] 每日冷备提示:', err.message)
  }
}

async function checkCloudStatus() {
  const t0 = Date.now()
  try {
    const res = await axios.get(`${REMOTE_URL}/health`, {
      timeout: 5000,
      headers: { 'User-Agent': 'StudyMaster-Ping/1.0' },
    })
    const pingMs = Date.now() - t0
    return {
      healthy: res.status === 200,
      statusCode: res.status,
      pingMs,
      envId: 'prod-d0g39zvr13ada49af',
      serviceName: 'studymaster',
      remoteUrl: REMOTE_URL,
      appId: config.wxAppId,
    }
  } catch (err) {
    return {
      healthy: false,
      error: err.message,
      pingMs: Date.now() - t0,
      envId: 'prod-d0g39zvr13ada49af',
      serviceName: 'studymaster',
      remoteUrl: REMOTE_URL,
      appId: config.wxAppId,
    }
  }
}

async function syncFromCloudBase(force = false) {
  if (!force && lastSyncInfo.lastSyncAt && Date.now() - lastSyncInfo.lastSyncAt < MIN_SYNC_INTERVAL_MS) {
    return {
      success: true,
      cached: true,
      userCount: lastSyncInfo.userCount,
      examCount: lastSyncInfo.examCount,
      pingMs: lastSyncInfo.pingMs,
      lastSyncAt: lastSyncInfo.lastSyncAt,
    }
  }

  const t0 = Date.now()
  console.log('[CloudSync] 正在从腾讯云托管与微信官方接口拉取最新考生及统计数据...')
  try {
    const [cloudRes, wxOfficial] = await Promise.all([
      axios
        .get(`${REMOTE_URL}/api/admin/dashboard`, {
          timeout: 15000,
          params: { token: 'studymaster2026' },
          headers: {
            'User-Agent': 'StudyMaster-Sync/1.0',
            'x-admin-token': config.adminToken || 'studymaster2026',
          },
        })
        .catch((err) => {
          console.warn('[CloudSync] 云托管请求告警:', err.message)
          return null
        }),
      wxApi.getWechatOfficialAnalytics(force).catch(() => null),
    ])

    let importedUsers = 0
    let importedExams = 0

    if (cloudRes && cloudRes.data && cloudRes.data.code === 0 && cloudRes.data.data) {
      const cloudData = cloudRes.data.data
      importedUsers = db.importCloudUsers(cloudData.users || [])
      importedExams = db.importCloudExams(cloudData.allExams || [])
      db.importCloudSnapshot(cloudData)
    }

    if (wxOfficial) {
      db.saveWechatOfficialCache(wxOfficial)
    }

    // 强制原子落盘
    db.flushSync()
    // 每日备份
    createDailyBackup()

    const pingMs = Date.now() - t0
    lastSyncInfo = {
      lastSyncAt: Date.now(),
      lastStatus: 'success',
      pingMs,
      error: null,
      userCount: importedUsers,
      examCount: importedExams,
    }

    // 触发云端上课提醒扫描并保活
    axios.get(`${REMOTE_URL}/api/reminder/cron?token=${config.adminToken}`, { timeout: 8000 }).catch(() => {})

    console.log(`[CloudSync] 成功同步 ${importedUsers} 位真实考生与 ${importedExams} 份新交卷及微信官方指标 (耗时 ${pingMs}ms)！`)
    return {
      success: true,
      userCount: importedUsers,
      examCount: importedExams,
      pingMs,
      lastSyncAt: lastSyncInfo.lastSyncAt,
    }
  } catch (err) {
    console.error('[CloudSync] 同步线上数据失败:', err.message)
    lastSyncInfo = {
      lastSyncAt: lastSyncInfo.lastSyncAt,
      lastStatus: 'error',
      pingMs: Date.now() - t0,
      error: err.message,
      userCount: lastSyncInfo.userCount,
      examCount: lastSyncInfo.examCount,
    }
    return {
      success: false,
      error: err.message,
      lastSyncAt: lastSyncInfo.lastSyncAt,
    }
  }
}

let syncTimer = null

/**
 * 启动后台全自动实时轮询同步（默认每 30 秒自动抓取线上最新考生与模考流水）
 */
function startAutoSync(intervalSeconds = 30) {
  if (syncTimer) clearInterval(syncTimer)

  // 首次立即同步一次
  syncFromCloudBase().catch(() => {})

  // 随后每 intervalSeconds 秒自动静默拉取
  syncTimer = setInterval(() => {
    syncFromCloudBase().catch(() => {})
  }, intervalSeconds * 1000)

  console.log(`[CloudSync] 后台全自动实时同步器已就绪，每 ${intervalSeconds} 秒自动增量更新并原子落盘`)
}

function stopAutoSync() {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
}

function getLastSyncInfo() {
  return lastSyncInfo
}

module.exports = {
  syncFromCloudBase,
  startAutoSync,
  stopAutoSync,
  checkCloudStatus,
  getLastSyncInfo,
}
