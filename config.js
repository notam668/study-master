const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') })

const isVercel = Boolean(process.env.VERCEL || process.env.NOW_REGION)
const defaultDataDir = isVercel ? path.join('/tmp', 'studymaster-data') : path.join(__dirname, 'data')

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET || 'studymaster_jwt_secret_key_default',
  wxAppId: process.env.WX_APPID || 'wx83e4351eecff8a27',
  wxAppSecret: process.env.WX_APPSECRET || '',
  dataDir: process.env.DATA_DIR || defaultDataDir,
  isVercel,

  // 公告管理后台的写操作口令（改公告内容 / 上传配图时需要）
  // 生产环境请在 .env 里改成自己的复杂字符串
  adminToken: process.env.ADMIN_TOKEN || 'studymaster_admin_2026',

  // 上传文件的对外访问前缀，留空则按请求 Host 自动拼接
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',

  // ── 上课提醒（微信订阅消息） ──────────────────────────────
  // 微信接口域名，测试时可指向本机 mock 服务
  wxApiBase: process.env.WX_API_BASE || 'https://api.weixin.qq.com',
  // 课表作息时间所属时区（容器多为 UTC，服务端一律按该时区算"今天几点的课"）
  timezoneOffsetMinutes: parseInt(process.env.TZ_OFFSET_MINUTES || '480', 10),
  // 上课提醒模板 ID。可在这里配置，也可留空后到 /reminder.html 后台填写（后台优先）
  wxReminderTemplateId: process.env.WX_REMINDER_TEMPLATE_ID || 'm1-5CUHw4HjSfUE0PuP6wJwuBw5ywTn8xkJ7oibxcy0',
  // 容器内是否跑定时扫描（关掉则只能靠外部定时任务打 /api/reminder/cron）
  enableReminderScheduler: process.env.ENABLE_REMINDER_SCHEDULER !== '0',
  examActivationCodes: (process.env.EXAM_ACTIVATION_CODES || 'VIP888,STUDY666,YCIT888,2026888,SM888,EXAM888')
    .split(',')
    .map((s) => s.trim().toUpperCase()),
}
