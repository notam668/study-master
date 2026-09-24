/**
 * 线上腾讯云托管真实数据拉取与同步服务
 */
const axios = require('axios')
const db = require('../db')

const REMOTE_URL = 'https://studymaster-299598-11-1471610879.sh.run.tcloudbase.com'

async function syncFromCloudBase() {
  console.log('[CloudSync] 正在从腾讯云托管线上服务拉取 500+ 真实考生数据...')
  try {
    const res = await axios.get(`${REMOTE_URL}/api/admin/dashboard`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'StudyMaster-Sync/1.0',
      },
    })

    if (!res.data || res.data.code !== 0 || !res.data.data) {
      throw new Error('云端服务返回数据格式不符合预期')
    }

    const { users, allExams, activationStats } = res.data.data
    const importedUsers = db.importCloudUsers(users || [])
    const importedExams = db.importCloudExams(allExams || [])

    console.log(`[CloudSync] 成功从云托管同步 ${importedUsers} 位真实考生与 ${importedExams} 份答题记录！`)
    return {
      success: true,
      userCount: importedUsers,
      examCount: importedExams,
      totalUsers: db.getStats().totalUsers,
    }
  } catch (err) {
    console.error('[CloudSync] 同步线上数据失败:', err.message)
    return {
      success: false,
      error: err.message,
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

  // 随后每 30 秒自动静默拉取
  syncTimer = setInterval(() => {
    syncFromCloudBase().catch(() => {})
  }, intervalSeconds * 1000)

  console.log(`[CloudSync] 后台全自动实时同步器已就绪，每 ${intervalSeconds} 秒自动增量更新一次`)
}

function stopAutoSync() {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
}

module.exports = {
  syncFromCloudBase,
  startAutoSync,
  stopAutoSync,
}

