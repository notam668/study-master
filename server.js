// 允许自签名证书（防止云托管容器内出口网关/代理拦截导致 self-signed certificate 报错）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const express = require('express')
const cors = require('cors')
const path = require('path')
const config = require('./config')
const authRouter = require('./routes/auth')
const analyticsRouter = require('./routes/analytics')
const scheduleRouter = require('./routes/schedule')
const announcementRouter = require('./routes/announcement')
const reminderRouter = require('./routes/reminder')
const scheduleService = require('./services/scheduleService')
const reminderService = require('./services/reminderService')
const db = require('./db')

const app = express()

// 云托管/反向代理场景下让 req.protocol 能正确识别 https（公告配图的预览地址依赖它）
app.set('trust proxy', true)

// 中间件配置
// 公告配图以 base64 形式提交，需要放宽默认的 100kb 请求体上限
app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// 静态资源托管（用于直接在浏览器查看监控看板）
app.use(express.static(path.join(__dirname, 'public')))

// 公告配图静态目录（与数据库同在 data 下，挂载持久化卷即可长期保留）
app.use(
  '/uploads',
  express.static(path.join(config.dataDir, 'uploads'), {
    maxAge: '7d',
    fallthrough: true,
  })
)

// 路由挂载
app.use('/api/auth', authRouter)
app.use('/api/analytics', analyticsRouter)
app.use('/api/admin', analyticsRouter)
app.use('/api/schedule', scheduleRouter)
app.use('/api/announcement', announcementRouter)
app.use('/api/reminder', reminderRouter)

// 根路由与健康检查（供云托管探活）
app.get('/health', (req, res) => {
  res.status(200).send('OK')
})

// 统一路由：所有旧后台地址均优雅重定向至统一综合控制台
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.get('/admin.html', (req, res) => {
  res.redirect('/#users')
})

app.get('/announcement.html', (req, res) => {
  res.redirect('/#announcement')
})

app.get('/reminder.html', (req, res) => {
  res.redirect('/#reminder')
})

// 优雅关闭持久化
process.on('SIGINT', () => {
  console.log('正在安全关闭服务，保存数据中...')
  db.flushSync()
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('正在安全关闭服务，保存数据中...')
  db.flushSync()
  process.exit(0)
})

// 导出 app 供 Vercel Serverless Function 使用
module.exports = app

// 如果直接由 node 运行，则监听本地端口
if (require.main === module) {
  const PORT = config.port
  app.listen(PORT, () => {
    console.log('====================================================')
    console.log(`🚀 StudyMaster 统一后端服务已成功启动！`)
    console.log(`📡 API 服务地址: http://localhost:${PORT}`)
    console.log(`📊 统一综合管理中枢: http://localhost:${PORT}`)
    console.log(`⚙️ 运行环境: ${config.isVercel ? 'Vercel Serverless' : '本地 Node.js'}`)
    console.log(`🔑 模式: ${config.wxAppSecret ? '微信官方接口模式' : '本地开发 Mock 模式 (未配置 WX_APPSECRET)'}`)
    console.log('====================================================')

    // 异步初始化或刷新课表缓存
    scheduleService.syncScheduleData().catch(err => {
      console.warn('[Schedule] 初始化课表缓存提示:', err.message)
    })

    // 启动后台全自动实时轮询同步（每 30 秒自动从线上同步真实考生与成绩流水）
    const { startAutoSync } = require('./services/cloudSyncService')
    startAutoSync(30)

    // 启动上课提醒定时扫描
    if (!config.isVercel) {
      reminderService.startScheduler()
    }
  })
}

