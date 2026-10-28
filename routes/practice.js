/**
 * 练习进度 / 错题本云同步
 * 全部按 req.user.openid 强隔离，忽略客户端伪造的 userKey
 */
const express = require('express')
const db = require('../db')
const { authMiddleware } = require('./auth')

const router = express.Router()

function requireOpenid(req, res) {
  const openid = (req.user && (req.user.openid || req.user.id)) || ''
  const oid = String(openid || '').trim()
  if (!oid) {
    res.status(401).json({ code: 401, message: '请先登录' })
    return null
  }
  return oid
}

function requireBankId(req, res) {
  const bankId = String((req.query && req.query.bankId) || (req.body && req.body.bankId) || '').trim()
  if (!bankId) {
    res.status(400).json({ code: 400, message: '缺少 bankId' })
    return null
  }
  return bankId
}

/** GET /api/practice/wrong-book?bankId= */
router.get('/wrong-book', authMiddleware, (req, res) => {
  const openid = requireOpenid(req, res)
  if (!openid) return
  const bankId = requireBankId(req, res)
  if (!bankId) return
  const data = db.getPracticeBank(openid, bankId)
  return res.json({
    code: 0,
    data: {
      bankId,
      entries: data.wrongBook || [],
      updatedAt: data.updatedAt || 0,
    },
  })
})

/** PUT /api/practice/wrong-book  body: { bankId, entries, clientUpdatedAt } */
router.put('/wrong-book', authMiddleware, (req, res) => {
  const openid = requireOpenid(req, res)
  if (!openid) return
  const bankId = requireBankId(req, res)
  if (!bankId) return
  const entries = (req.body && req.body.entries) || (req.body && req.body.wrongBook) || []
  const clientUpdatedAt = Number((req.body && req.body.clientUpdatedAt) || Date.now())
  const result = db.putPracticeBank(openid, bankId, {
    wrongBook: Array.isArray(entries) ? entries : [],
    clientUpdatedAt,
  })
  if (!result.ok) return res.status(400).json({ code: 400, message: result.reason || '写入失败' })
  return res.json({
    code: 0,
    data: {
      bankId,
      entries: result.data.wrongBook,
      updatedAt: result.data.updatedAt,
    },
  })
})

/** POST /api/practice/wrong-book/add */
router.post('/wrong-book/add', authMiddleware, (req, res) => {
  const openid = requireOpenid(req, res)
  if (!openid) return
  const bankId = requireBankId(req, res)
  if (!bankId) return
  const entry = (req.body && req.body.entry) || req.body || {}
  const result = db.addWrongBookEntry(openid, bankId, entry)
  if (!result.ok) return res.status(400).json({ code: 400, message: result.reason || '加入失败' })
  return res.json({ code: 0, data: { bankId, entries: result.data.wrongBook, updatedAt: result.data.updatedAt } })
})

/** DELETE /api/practice/wrong-book/item  body/query: bankId, questionId */
router.delete('/wrong-book/item', authMiddleware, (req, res) => {
  const openid = requireOpenid(req, res)
  if (!openid) return
  const bankId = requireBankId(req, res)
  if (!bankId) return
  const questionId = String((req.body && req.body.questionId) || (req.query && req.query.questionId) || '').trim()
  const result = db.removeWrongBookEntry(openid, bankId, questionId)
  if (!result.ok) return res.status(400).json({ code: 400, message: result.reason || '删除失败' })
  return res.json({ code: 0, data: { bankId, entries: result.data.wrongBook, updatedAt: result.data.updatedAt } })
})

/** GET /api/practice/progress?bankId=&mode=full|wrong */
router.get('/progress', authMiddleware, (req, res) => {
  const openid = requireOpenid(req, res)
  if (!openid) return
  const bankId = requireBankId(req, res)
  if (!bankId) return
  const mode = String((req.query && req.query.mode) || 'full')
  const data = db.getPracticeBank(openid, bankId)
  const wrongOnly = mode === 'wrong'
  return res.json({
    code: 0,
    data: {
      bankId,
      mode: wrongOnly ? 'wrong' : 'full',
      progress: wrongOnly ? data.wrongProgress : data.progress,
      states: wrongOnly ? data.wrongStates : data.states,
      updatedAt: data.updatedAt || 0,
      resetAt: data.resetAt || 0,
    },
  })
})

/** PUT /api/practice/progress */
router.put('/progress', authMiddleware, (req, res) => {
  const openid = requireOpenid(req, res)
  if (!openid) return
  const bankId = requireBankId(req, res)
  if (!bankId) return
  const mode = String((req.body && req.body.mode) || 'full')
  const clientUpdatedAt = Number((req.body && req.body.clientUpdatedAt) || Date.now())
  const patch = { clientUpdatedAt }
  if (mode === 'wrong') {
    if (req.body && req.body.progress !== undefined) patch.wrongProgress = req.body.progress
    if (req.body && req.body.states !== undefined) patch.wrongStates = req.body.states
  } else {
    if (req.body && req.body.progress !== undefined) patch.progress = req.body.progress
    if (req.body && req.body.states !== undefined) patch.states = req.body.states
  }
  const result = db.putPracticeBank(openid, bankId, patch)
  if (!result.ok) return res.status(400).json({ code: 400, message: result.reason || '写入失败' })
  const data = result.data
  const wrongOnly = mode === 'wrong'
  return res.json({
    code: 0,
    data: {
      bankId,
      mode: wrongOnly ? 'wrong' : 'full',
      progress: wrongOnly ? data.wrongProgress : data.progress,
      states: wrongOnly ? data.wrongStates : data.states,
      updatedAt: data.updatedAt,
      resetAt: data.resetAt,
    },
  })
})

/** POST /api/practice/progress/reset  从头开始：清痕迹，保留错题本 */
router.post('/progress/reset', authMiddleware, (req, res) => {
  const openid = requireOpenid(req, res)
  if (!openid) return
  const bankId = requireBankId(req, res)
  if (!bankId) return
  const result = db.resetPracticeTraces(openid, bankId)
  if (!result.ok) return res.status(400).json({ code: 400, message: result.reason || '重置失败' })
  return res.json({
    code: 0,
    data: {
      bankId,
      progress: 0,
      states: {},
      wrongBookKept: (result.data.wrongBook || []).length,
      updatedAt: result.data.updatedAt,
      resetAt: result.data.resetAt,
    },
  })
})

/** PUT /api/practice/sync  一次拉取/推送合并：错题本+进度 */
router.put('/sync', authMiddleware, (req, res) => {
  const openid = requireOpenid(req, res)
  if (!openid) return
  const bankId = requireBankId(req, res)
  if (!bankId) return
  const body = req.body || {}
  const clientUpdatedAt = Number(body.clientUpdatedAt || Date.now())
  const patch = { clientUpdatedAt }
  if (Array.isArray(body.wrongBook) || Array.isArray(body.entries)) {
    patch.wrongBook = body.wrongBook || body.entries
  }
  if (Array.isArray(body.wrongBookTombstones)) patch.wrongBookTombstones = body.wrongBookTombstones
  if (body.progress !== undefined) patch.progress = body.progress
  if (body.states !== undefined) patch.states = body.states
  if (body.wrongProgress !== undefined) patch.wrongProgress = body.wrongProgress
  if (body.wrongStates !== undefined) patch.wrongStates = body.wrongStates
  if (body.resetPractice === true) patch.resetPractice = true

  const result = db.putPracticeBank(openid, bankId, patch)
  if (!result.ok) return res.status(400).json({ code: 400, message: result.reason || '同步失败' })
  const data = result.data
  return res.json({
    code: 0,
    data: {
      bankId,
      wrongBook: data.wrongBook,
      progress: data.progress,
      states: data.states,
      wrongProgress: data.wrongProgress,
      wrongStates: data.wrongStates,
      updatedAt: data.updatedAt,
      resetAt: data.resetAt,
    },
  })
})

module.exports = router
