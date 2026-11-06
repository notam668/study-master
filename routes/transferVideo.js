/**
 * 转专业视频配置接口（云托管 studymaster）
 *
 *   GET  /api/transfer/video             小程序拉当前启用视频（公开，callContainer）
 *   GET  /api/admin/transfer/videos      后台列表（x-admin-token）
 *   POST /api/admin/transfer/video       新建 / 更新元数据（x-admin-token）
 *   POST /api/admin/transfer/video/:id/status  上架/下架（x-admin-token）
 *
 * 挂载（server.js）：app.use('/api', transferVideoRouter)
 * 依赖环境变量：MYSQL_*（已有）、ADMIN_TOKEN（已有，与桥机同名变量保持同值）。
 * MEDIA_PUBLIC_BASE 为**可选**：缺省内置 https://media.ycgxy.xyz/media（非密钥），
 * 云托管 / Vercel 都**不需要**新增该变量；如日后换媒体域名再配环境变量覆盖即可。
 *
 * 视频文件不经过这里：浏览器直传桥机 /admin/upload，本接口只写 MySQL 元数据。
 */
'use strict'

const express = require('express')
const crypto = require('crypto')
const mysql = require('mysql2/promise')
const config = require('../config')

const router = express.Router()

/** 默认媒体地址前缀（非密钥；云托管/Vercel 无需配置对应环境变量） */
const DEFAULT_MEDIA_PUBLIC_BASE = 'https://media.ycgxy.xyz/media'
const MEDIA_PUBLIC_BASE = (process.env.MEDIA_PUBLIC_BASE || DEFAULT_MEDIA_PUBLIC_BASE).replace(/\/+$/, '')

let pool = null
function dbPool() {
  if (!process.env.MYSQL_HOST || !process.env.MYSQL_PASSWORD) return null
  if (!pool) {
    const useSSL = String(process.env.MYSQL_SSL || '') === '1'
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE || 'studymaster',
      waitForConnections: true,
      connectionLimit: 2,
      charset: 'utf8mb4',
      connectTimeout: Number(process.env.MYSQL_CONNECT_TIMEOUT || 10000),
      ...(useSSL ? { ssl: { rejectUnauthorized: false } } : {}),
    })
  }
  return pool
}

/**
 * 建表自动化：首次访问时幂等执行 CREATE TABLE IF NOT EXISTS（结构与 sql/transfer_videos.sql 一致）。
 * - 模块级 promise 缓存，正常情况只 DDL 一次，不会每个请求都建表
 * - 失败只记日志、不崩；本次请求按现状返回 503/500，且清空缓存允许下次请求重试
 * - MySQL 未配置时直接返回 false（沿用原 503 行为）
 */
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS \`transfer_videos\` (
  \`id\`           INT PRIMARY KEY AUTO_INCREMENT,
  \`title\`        VARCHAR(128)  NOT NULL,
  \`url\`          VARCHAR(512)  NOT NULL,
  \`poster_url\`   VARCHAR(512)  DEFAULT NULL,
  \`duration_sec\` INT           DEFAULT 5,
  \`status\`       TINYINT       DEFAULT 1,
  \`sort\`         INT           DEFAULT 0,
  \`created_at\`   DATETIME      DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\`   DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY \`idx_status_sort\` (\`status\`, \`sort\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`

let tableReady = null
function ensureTable() {
  const p = dbPool()
  if (!p) return Promise.resolve(false)
  if (!tableReady) {
    tableReady = p
      .query(CREATE_TABLE_SQL)
      .then(() => {
        console.log('[TransferVideo] transfer_videos 表就绪（首次初始化）')
        return true
      })
      .catch((e) => {
        console.error('[TransferVideo] 建表失败（下次请求重试）:', e.message)
        tableReady = null
        return false
      })
  }
  return tableReady
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8')
  const bb = Buffer.from(String(b || ''), 'utf8')
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

function adminOnly(req, res, next) {
  const token =
    req.headers['x-admin-token'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
    (req.body && req.body.adminToken) ||
    req.query.token ||
    ''
  if (!safeEqual(token, config.adminToken)) {
    return res.status(401).json({ code: 401, message: '管理口令不正确，请检查后重试' })
  }
  return next()
}

function publicRow(r) {
  if (!r) return null
  return {
    id: r.id,
    title: r.title,
    url: r.url,
    poster_url: r.poster_url || '',
    duration_sec: Number(r.duration_sec) || 5,
    updated_at: r.updated_at,
  }
}

function cleanText(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max)
}

/** 只接受 https 且落在媒体域名下的地址，防止把 app 引到任意站点 */
function validMediaUrl(url) {
  const u = String(url || '').trim()
  if (!u.startsWith('https://')) return false
  if (!u.startsWith(MEDIA_PUBLIC_BASE + '/') && u !== MEDIA_PUBLIC_BASE) return false
  return u.length <= 512
}

function validPosterUrl(url) {
  const u = String(url || '').trim()
  if (!u) return true // 可空
  if (!u.startsWith('https://')) return false
  return u.length <= 512
}

// ---------------- 小程序：当前启用视频 ----------------
router.get('/transfer/video', async (req, res) => {
  const ready = await ensureTable()
  if (!ready) return res.status(503).json({ code: 503, message: '视频配置服务暂不可用（MySQL 未配置或建表失败）', data: { video: null } })
  const p = dbPool()
  try {
    const [rows] = await p.query(
      'SELECT id,title,url,poster_url,duration_sec,sort,updated_at FROM transfer_videos ' +
        'WHERE status = 1 ORDER BY sort DESC, id DESC LIMIT 1'
    )
    return res.json({ code: 0, message: 'ok', data: { video: publicRow(rows && rows[0]) } })
  } catch (e) {
    console.error('[TransferVideo] 读取失败:', e.message)
    return res.status(500).json({ code: 500, message: '读取视频配置失败', data: { video: null } })
  }
})

// ---------------- 后台：列表 ----------------
router.get('/admin/transfer/videos', adminOnly, async (req, res) => {
  const ready = await ensureTable()
  if (!ready) return res.status(503).json({ code: 503, message: 'MySQL 未配置或建表失败' })
  const p = dbPool()
  try {
    const [rows] = await p.query(
      'SELECT id,title,url,poster_url,duration_sec,status,sort,created_at,updated_at ' +
        'FROM transfer_videos ORDER BY sort DESC, id DESC LIMIT 100'
    )
    return res.json({ code: 0, message: 'ok', data: { videos: rows } })
  } catch (e) {
    console.error('[TransferVideo] 列表失败:', e.message)
    return res.status(500).json({ code: 500, message: '读取列表失败' })
  }
})

// ---------------- 后台：新建/更新元数据 ----------------
router.post('/admin/transfer/video', adminOnly, async (req, res) => {
  const ready = await ensureTable()
  if (!ready) return res.status(503).json({ code: 503, message: 'MySQL 未配置或建表失败' })
  const p = dbPool()
  const b = req.body || {}
  const id = Number(b.id || 0)
  const title = cleanText(b.title, 128)
  const url = String(b.url || '').trim()
  const poster_url = String(b.poster_url || '').trim()
  const duration_sec = Math.max(1, Math.min(3600, Number(b.duration_sec) || 5))
  const sort = Number(b.sort) || 0
  const status = b.status === 0 || b.status === '0' ? 0 : 1
  if (!title) return res.status(400).json({ code: 400, message: '标题不能为空' })
  if (!validMediaUrl(url)) {
    return res.status(400).json({ code: 400, message: `视频地址必须是以 ${MEDIA_PUBLIC_BASE}/ 开头的 https 地址` })
  }
  if (!validPosterUrl(poster_url)) {
    return res.status(400).json({ code: 400, message: '海报必须是 https 地址或留空' })
  }
  try {
    if (id) {
      const [r] = await p.query(
        'UPDATE transfer_videos SET title=?, url=?, poster_url=?, duration_sec=?, sort=?, status=? WHERE id=?',
        [title, url, poster_url || null, duration_sec, sort, status, id]
      )
      if (!r.affectedRows) return res.status(404).json({ code: 404, message: '记录不存在' })
      return res.json({ code: 0, message: '已更新', data: { id } })
    }
    const [r] = await p.query(
      'INSERT INTO transfer_videos (title,url,poster_url,duration_sec,status,sort) VALUES (?,?,?,?,?,?)',
      [title, url, poster_url || null, duration_sec, status, sort]
    )
    return res.json({ code: 0, message: '已保存', data: { id: r.insertId } })
  } catch (e) {
    console.error('[TransferVideo] 保存失败:', e.message)
    return res.status(500).json({ code: 500, message: '保存失败：' + e.message })
  }
})

// ---------------- 后台：上架/下架 ----------------
router.post('/admin/transfer/video/:id/status', adminOnly, async (req, res) => {
  const ready = await ensureTable()
  if (!ready) return res.status(503).json({ code: 503, message: 'MySQL 未配置或建表失败' })
  const p = dbPool()
  const id = Number(req.params.id)
  const status = (req.body && (req.body.status === 0 || req.body.status === '0')) ? 0 : 1
  if (!id) return res.status(400).json({ code: 400, message: 'id 不合法' })
  try {
    const [r] = await p.query('UPDATE transfer_videos SET status=? WHERE id=?', [status, id])
    if (!r.affectedRows) return res.status(404).json({ code: 404, message: '记录不存在' })
    return res.json({ code: 0, message: status ? '已上架' : '已下架', data: { id, status } })
  } catch (e) {
    console.error('[TransferVideo] 状态更新失败:', e.message)
    return res.status(500).json({ code: 500, message: '更新失败' })
  }
})

module.exports = router
