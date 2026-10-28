/**
 * 教务会话存储：cookie 存 app_state_kv 表，键 jwxt:session:<学号>，默认 12 小时过期。
 *
 * 为什么不复用 db.js：db.js 的持久化模型是「整份 studymaster.json 拆顶层键」，
 * 教务会话是短生命周期、按学号分行的数据，放进业务顶层键会把用户表撑脏。
 * 这里直接读写同一张 app_state_kv（键名前缀隔离），多实例可并发。
 * MySQL 未配置 / 连不上时回退到 data/jwxt-sessions.json（仅本机调试有意义）。
 *
 * 安全：只存会话 cookie，永不存口令。
 */
const fs = require('fs')
const path = require('path')
const config = require('../config')

const TTL_MS = 12 * 60 * 60 * 1000
const PREFIX = 'jwxt:session:'
const FILE = path.join(config.dataDir, 'jwxt-sessions.json')

let pool = null
let mysqlBroken = false

function mysqlConfigured() {
  return Boolean(process.env.MYSQL_HOST && process.env.MYSQL_USER && process.env.MYSQL_DATABASE)
}

function getPool() {
  if (!mysqlConfigured()) return null
  if (pool) return pool
  const mysql = require('mysql2/promise')
  pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    connectTimeout: 8000,
    ...(String(process.env.MYSQL_SSL || '') === '1' ? { ssl: {} } : {}),
  })
  return pool
}

function readFileStore() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch (e) {
    return {}
  }
}

function writeFileStore(obj) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(obj, null, 1))
  } catch (e) {
    console.error('[jwxt-session] 回退文件写入失败:', e.message)
  }
}

async function put(studentId, payload) {
  const key = PREFIX + studentId
  const doc = { ...payload, studentId, createdAt: Date.now(), expiresAt: Date.now() + TTL_MS }
  const p = mysqlBroken ? null : getPool()
  if (p) {
    try {
      await p.query('INSERT INTO app_state_kv (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [key, JSON.stringify(doc)])
      return { backend: 'mysql', key, expiresAt: doc.expiresAt }
    } catch (e) {
      mysqlBroken = true
      console.error('[jwxt-session] MySQL 写入失败，改走本地文件:', e.code || e.message)
    }
  }
  const store = readFileStore()
  store[key] = doc
  writeFileStore(store)
  return { backend: 'file', key, expiresAt: doc.expiresAt }
}

async function get(studentId) {
  const key = PREFIX + studentId
  let doc = null
  const p = mysqlBroken ? null : getPool()
  if (p) {
    try {
      const [rows] = await p.query('SELECT v FROM app_state_kv WHERE k = ? LIMIT 1', [key])
      if (rows.length) {
        try { doc = JSON.parse(rows[0].v) } catch (e) { doc = null }
      }
    } catch (e) {
      mysqlBroken = true
      console.error('[jwxt-session] MySQL 读取失败，改走本地文件:', e.code || e.message)
    }
  }
  if (!doc) {
    const store = readFileStore()
    doc = store[key] || null
  }
  if (!doc) return null
  const expired = !doc.expiresAt || doc.expiresAt < Date.now() || !Array.isArray(doc.cookies) || !doc.cookies.length
  return { ...doc, key, expired, ttlLeftMs: Math.max(0, (doc.expiresAt || 0) - Date.now()) }
}

async function del(studentId) {
  const key = PREFIX + studentId
  const p = mysqlBroken ? null : getPool()
  if (p) {
    try { await p.query('DELETE FROM app_state_kv WHERE k = ?', [key]) } catch (e) { mysqlBroken = true }
  }
  const store = readFileStore()
  if (store[key]) { delete store[key]; writeFileStore(store) }
  return true
}

function cookieHeader(cookies) {
  return (cookies || []).map((c) => `${c.name}=${c.value}`).join('; ')
}

module.exports = { put, get, del, cookieHeader, TTL_MS, PREFIX, backend: () => (mysqlConfigured() && !mysqlBroken ? 'mysql' : 'file') }
