/**
 * 线上腾讯云托管真实数据拉取与同步服务
 */
const fs = require('fs')
const path = require('path')
const axios = require('axios')
const db = require('../db')
const config = require('../config')

const REMOTE_URL = 'https://studymaster-299598-11-1471610879.sh.run.tcloudbase.com'

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

async function syncFromCloudBase() {
  const t0 = Date.now()
  console.log('[CloudSync] 正在从腾讯云托管线上服务拉取最新考生数据...')
  try {
    const res = await axios.get(`${REMOTE_URL}/api/admin/dashboard`, {
      timeout: 25000,
      headers: {
        'User-Agent': 'StudyMaster-Sync/1.0',
      },
    })

    if (!res.data || res.data.code !== 0 || !res.data.data) {
      throw new Error('云端服务返回数据格式不符合预期')
    }

    const { users, allExams } = res.data.data
    const importedUsers = db.importCloudUsers(users || [])
    const importedExams = db.importCloudExams(allExams || [])

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
    axios.get(`${REMOTE_URL}/api/reminder/cron?token=${config.adminToken}`, { timeout: 10000 }).catch(() => {})

    console.log(`[CloudSync] 成功从云托管同步 ${importedUsers} 位真实考生与 ${importedExams} 份答题记录 (耗时 ${pingMs}ms)！`)
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
