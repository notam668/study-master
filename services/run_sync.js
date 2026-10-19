/**
 * 独立的命令行全自动同步与冷备脚本
 */
const { syncFromCloudBase } = require('./cloudSyncService')
const db = require('../db')

async function run() {
  console.log('[1/2] 正在连接微信云托管线上服务器拉取最新数据...')
  try {
    const res = await syncFromCloudBase()
    if (res.success) {
      db.flushSync()
      console.log(`[成功] 全量拉取完成！共导入/校验 ${res.userCount} 位考生与 ${res.examCount} 条成绩记录`)
      console.log('[2/2] 本地数据已同步并安全冷备归档至 data/backups 目录！')
      process.exit(0)
    } else {
      console.error('[失败] 云端同步异常:', res.error)
      process.exit(1)
    }
  } catch (err) {
    console.error('[失败] 网络或脚本错误:', err.message)
    process.exit(1)
  }
}

run()
