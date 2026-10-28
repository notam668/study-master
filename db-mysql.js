// MySQL 持久层（微信云开发 CloudBase MySQL）
// 设计原则：业务代码零改动。整个 studymaster.json 文档按顶层键拆到 app_state_kv 表（分表模式），
// 启动时一次性读入内存（沿用原 db.js 的内存模型），写入时防抖异步落库。
// 分表模式下每个键一行，多实例各自写自己改过的键时不会整文档互相覆盖。
// MYSQL_KV=0 或分表不可用时自动回退旧的单行大表 app_state。
// 环境变量未配置时本模块完全不激活，服务仍走文件存储。
const mysql = require('mysql2/promise')

const TABLE = process.env.MYSQL_STATE_TABLE || 'app_state'
const KV = TABLE + '_kv'
let useKV = false

function envOn(name) {
  const v = (process.env[name] || '').trim()
  return v && v !== '0' && v.toLowerCase() !== 'false'
}

const configured = Boolean((process.env.MYSQL_HOST || '').trim()) && Boolean((process.env.MYSQL_PASSWORD || '').trim())

let pool = null
let enabled = false
let memDoc = null
let saveTimer = null
let lastError = null
let lastWriteAt = 0

function poolConfig() {
  const useSSL = envOn('MYSQL_SSL')
  return {
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'studymaster',
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_POOL || 4),
    charset: 'utf8mb4',
    connectTimeout: Number(process.env.MYSQL_CONNECT_TIMEOUT || 10000),
    ...(useSSL ? { ssl: { rejectUnauthorized: false } } : {}),
  }
}

async function ensureSchema() {
  const conn = await pool.getConnection()
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS \`${TABLE}\` (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      doc LONGTEXT NOT NULL,
      bytes INT UNSIGNED NOT NULL DEFAULT 0,
      version BIGINT UNSIGNED NOT NULL DEFAULT 1,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`)
  } finally {
    conn.release()
  }
}

async function ensureKvSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS \`${KV}\` (
    k VARCHAR(191) NOT NULL,
    v LONGTEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (k)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`)
}

async function readKV() {
  try {
    const [rows] = await pool.query(`SELECT k, v FROM \`${KV}\``)
    if (!rows || !rows.length) return null
    const out = {}
    for (const r of rows) {
      try { out[r.k] = JSON.parse(r.v) } catch (e) { console.warn('[MySQL] 分表解析失败:', r.k, e.message) }
    }
    return Object.keys(out).length ? out : null
  } catch (e) {
    console.warn('[MySQL] 分表读取失败，回退单行大表:', e.message)
    return null
  }
}

// 启动时调用一次：连库、建表、把文档读进内存。返回 { enabled, doc, source }
async function init() {
  if (!configured) return { enabled: false, reason: 'MYSQL_HOST/PASSWORD 未配置' }
  try {
    pool = mysql.createPool(poolConfig())
    const conn = await pool.getConnection()
    let dbName = process.env.MYSQL_DATABASE || 'studymaster'
    try {
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
      await conn.query(`USE \`${dbName}\``)
    } catch (e) {
      // 账号无建库权限时忽略，直接沿用连接串里的库
      console.warn('[MySQL] 建库跳过:', e.message)
    }
    conn.release()
    await ensureSchema()
    const kvDisabled = (process.env.MYSQL_KV || '').trim() === '0'
    if (!kvDisabled) {
      await ensureKvSchema()
      const kv = await readKV()
      if (kv) {
        enabled = true
        useKV = true
        memDoc = kv
        console.log(`[MySQL] 读取模式: ${KV}（${Object.keys(kv).length} 个键）`)
        return { enabled: true, doc: memDoc, source: 'mysql-kv' }
      }
    }
    const [rows] = await pool.query(`SELECT doc FROM \`${TABLE}\` WHERE id = 1`)
    enabled = true
    useKV = false
    if (rows.length && rows[0].doc) {
      memDoc = JSON.parse(rows[0].doc)
      return { enabled: true, doc: memDoc, source: 'mysql' }
    }
    return { enabled: true, doc: null, source: 'empty' }
  } catch (e) {
    lastError = e.message
    enabled = false
    console.error('[MySQL] 初始化失败，回退文件存储:', e.message)
    return { enabled: false, reason: e.message }
  }
}

// 首次接入时把文件里的历史数据整体写入空库
async function bootstrapFrom(obj) {
  if (!enabled || !obj) return false
  memDoc = obj
  await writeNow()
  return true
}

// 分表整体写入：只覆盖内存里存在的键（不删其他键，避免误删别人写的行）
async function writeKVNow() {
  if (!enabled || !memDoc) return false
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    for (const [k, v] of Object.entries(memDoc)) {
      if (v === undefined) continue
      await conn.query(`INSERT INTO \`${KV}\` (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)`, [k, JSON.stringify(v)])
    }
    await conn.commit()
    lastWriteAt = Date.now()
    lastError = null
    return true
  } catch (e) {
    try { await conn.rollback() } catch (_) {}
    lastError = e.message
    console.error('[MySQL] 分表写入失败:', e.message)
    return false
  } finally {
    conn.release()
  }
}

async function writeNow() {
  if (!enabled || !memDoc) return false
  if (useKV) return writeKVNow()
  const doc = JSON.stringify(memDoc)
  try {
    await pool.query(
      `INSERT INTO \`${TABLE}\` (id, doc, bytes, version) VALUES (1, ?, ?, 1)
       ON DUPLICATE KEY UPDATE doc = VALUES(doc), bytes = VALUES(bytes), version = version + 1`,
      [doc, Buffer.byteLength(doc)]
    )
    lastWriteAt = Date.now()
    lastError = null
    return true
  } catch (e) {
    lastError = e.message
    console.error('[MySQL] 写入失败:', e.message)
    return false
  }
}

function persist(obj) {
  if (!enabled) return
  memDoc = obj
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { saveTimer = null; writeNow() }, Number(process.env.MYSQL_FLUSH_MS || 300))
}

async function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  return writeNow()
}

function status() {
  return { configured, enabled, lastError, lastWriteAt, table: useKV ? KV : TABLE, mode: useKV ? 'kv' : 'single-row' }
}

module.exports = { init, bootstrapFrom, persist, flush, status, configured }
