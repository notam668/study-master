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
const electricityRouter = require('./routes/electricity')
// 2026-10-26 开发部：教务课表（P1 演示接口 /api/jwxt/timetable-demo）
const jwxtRouter = require('./routes/jwxt')
const practiceRouter = require('./routes/practice')
const { securityMiddleware } = require('./middleware/security')
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

// 安全防护与反爬虫中间件（速率限制、IP/OpenID 封禁、签名校验）
app.use(securityMiddleware)

// 路由挂载
app.use('/api/auth', authRouter)
app.use('/api/analytics', analyticsRouter)
app.use('/api/admin', analyticsRouter)
app.use('/api/schedule', scheduleRouter)
app.use('/api/announcement', announcementRouter)
app.use('/api/reminder', reminderRouter)
app.use('/api/electricity', electricityRouter)
app.use('/api/jwxt', jwxtRouter)
app.use('/api/practice', practiceRouter)

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
  db.initStore()
    .then(store => {
      if (store && store.enabled) {
        console.log(`🗄️ 存储: MySQL ${process.env.MYSQL_HOST}/${process.env.MYSQL_DATABASE || 'studymaster'}（${store.source}，用户 ${store.users ?? '-'}）`)
      } else {
        console.log(`🗄️ 存储: 本地文件 data/studymaster.json${store && store.reason ? '（' + store.reason + '）' : ''}`)
      }
    })
    .catch(e => console.warn('[MySQL] 启动初始化异常，按文件模式运行:', e.message))
    .finally(() => app.listen(PORT, () => {
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

    // 启动后台全自动实时轮询同步（间隔可由 CLOUD_SYNC_INTERVAL_SECONDS 调，默认 30 秒）
    const { startAutoSync } = require('./services/cloudSyncService')
    startAutoSync(Number(process.env.CLOUD_SYNC_INTERVAL_SECONDS) || 30)

    // 启动上课提醒定时扫描
    if (!config.isVercel) {
      reminderService.startScheduler()
    }

    // 启动电费会话保活（每 10 分钟打一次，防止学校 Session 过期）
    try {
      require('./services/electricityService').startSessionKeepalive()
    } catch (e) {
      console.warn('[Electricity] 会话保活启动失败:', e.message)
    }
    }))
}

