/**
 * 开屏公告服务
 * ------------------------------------------------------------
 * 职责：
 *   1. 定义公告的字段结构与默认值（小程序端首次拉取、或后台从未保存过时使用）
 *   2. 对后台提交的配置做白名单校验与清洗，杜绝脏字段写库
 *   3. 管理配图文件：base64 上传落盘、计算 imageVersion、按需下发 base64
 *
 * 配图不允许直接暴露成外链给小程序用——微信规定 <image> 加载网络图片必须把域名
 * 加进「downloadFile 合法域名」，真机上开发者工具的「不校验」不生效。所以我们
 * 把图片以 base64 通过接口通道下发（走 wx.cloud.callContainer，免域名白名单），
 * 小程序端写入本地文件后直接使用本地路径，彻底规避白名单问题。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const config = require('../config')

/** 配图落盘目录：与数据库同在 data 下，方便一次性挂载持久化卷 */
const UPLOAD_DIR = path.join(config.dataDir, 'uploads', 'announcement')

/** 允许的图片 MIME 与扩展名映射 */
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** 单张配图体积上限（浏览器端已压缩，这里只做兜底防护） */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024

/** 允许的弹出模式 */
const SHOW_MODES = ['always', 'oncePerVersion']
/** 允许的图片缩放模式 */
const IMAGE_MODES = ['widthFix', 'aspectFit', 'aspectFill']

/**
 * 默认公告内容（与小程序端 utils/announcementConfig.ts 的兜底值保持一致）
 */
const DEFAULT_ANNOUNCEMENT = {
  enabled: true,
  showMode: 'always',
  version: '2026-09-19',
  delayMs: 320,

  title: '最新公告',
  text: '扫码加入盐城工学院校园论坛，学生互助！交友！全校同学都在！',
  image: '/images/announcement/notice-poster.jpg',
  imageMode: 'widthFix',
  previewImage: true,

  contactLabel: '联系微信',
  contactValue: 'Corwin07 / Woxiangxingfu777',
  copyButtonText: '复制微信号',
  copyToast: '微信号已复制',

  confirmText: '我知道了',
  maskClosable: false,

  updatedAt: 0,
}

/** ------------------------------------------------------------------ 工具 */

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  }
}

function sha1(input) {
  return crypto.createHash('sha1').update(input).digest('hex')
}

/** 截断字符串并去掉首尾空白，防止后台误粘贴超长内容 */
function str(value, maxLen, fallback = '') {
  if (typeof value !== 'string') return fallback
  const v = value.trim()
  if (!v) return ''
  return v.length > maxLen ? v.slice(0, maxLen) : v
}

/** 正文允许保留换行，只做首尾清理与长度限制 */
function text(value, maxLen, fallback = '') {
  if (typeof value !== 'string') return fallback
  const v = value.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim()
  if (!v) return ''
  return v.length > maxLen ? v.slice(0, maxLen) : v
}

function bool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1 || value === '1') return true
  if (value === 'false' || value === 0 || value === '0') return false
  return fallback
}

function intIn(value, min, max, fallback) {
  const n = parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** ------------------------------------------------------------------ 图片 */

/**
 * 校验并规整 image 字段的取值
 * 支持三种形态：'' （不显示）/ 服务器上传的 upload:xxx / 其它字符串（包内路径或外链）
 */
function normalizeImage(value) {
  const raw = str(value, 500, '')
  if (!raw) return ''
  if (raw.startsWith('upload:')) {
    const name = raw.slice('upload:'.length)
    // 只接受纯文件名，禁止 ../ 之类的路径穿越
    if (!/^[a-f0-9]{8,64}\.(jpg|png|webp|gif)$/i.test(name)) return ''
    return `upload:${name}`
  }
  return raw
}

/** 取出 upload 形态对应的磁盘路径；非 upload 或文件不存在时返回 null */
function resolveUploadPath(image) {
  if (!image || !image.startsWith('upload:')) return null
  const name = image.slice('upload:'.length)
  if (!/^[a-f0-9]{8,64}\.(jpg|png|webp|gif)$/i.test(name)) return null
  const file = path.join(UPLOAD_DIR, name)
  if (!fs.existsSync(file)) return null
  return file
}

/** 图片内容缓存：filename -> { base64, mime, at } 避免每次请求都读盘编码 */
const imageCache = new Map()

/**
 * 读取 upload 形态的配图，返回 { mime, base64 }；不存在时返回 null
 */
function readUploadImage(image) {
  const file = resolveUploadPath(image)
  if (!file) return null
  const name = path.basename(file)
  const ext = name.split('.').pop().toLowerCase()
  const mime = Object.keys(MIME_EXT).find((k) => MIME_EXT[k] === ext) || 'image/jpeg'

  const cached = imageCache.get(name)
  if (cached) return { mime: cached.mime, base64: cached.base64 }

  const buf = fs.readFileSync(file)
  const base64 = buf.toString('base64')
  imageCache.set(name, { mime, base64 })
  return { mime, base64 }
}

/**
 * 计算配图版本号。小程序端用它判断「本地缓存的文件是否还能用」，
 * 只要后台换了图，版本号就会变，小程序下次打开即拉取新图。
 */
function getImageVersion(cfg) {
  const image = normalizeImage(cfg.image)
  if (!image) return ''
  if (image.startsWith('upload:')) {
    const file = resolveUploadPath(image)
    if (!file) return `${image}#missing`
    try {
      return sha1(fs.readFileSync(file)).slice(0, 16)
    } catch (e) {
      return `${image}#readfail`
    }
  }
  // 包内路径 / 外链：直接对字符串取指纹，换路径即换版本
  return sha1(image).slice(0, 16)
}

/**
 * 保存后台用 base64 上传的配图。
 * 入参形如：{ dataUrl: 'data:image/jpeg;base64,xxxx', fileName: 'poster.jpg' }
 * 返回 'upload:<filename>'
 */
function saveUploadedImage({ dataUrl, fileName }) {
  const raw = typeof dataUrl === 'string' ? dataUrl.trim() : ''
  if (!raw) {
    const err = new Error('图片数据为空')
    err.code = 400
    throw err
  }

  const m = /^data:([\w/+.-]+);base64,([\s\S]+)$/.exec(raw)
  if (!m) {
    const err = new Error('图片格式不正确，需要 data:image/xxx;base64, 形式')
    err.code = 400
    throw err
  }

  const mime = m[1].toLowerCase()
  const ext = MIME_EXT[mime]
  if (!ext) {
    const err = new Error('仅支持 JPG / PNG / WEBP / GIF 格式的图片')
    err.code = 400
    throw err
  }

  const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64')
  if (!buf.length) {
    const err = new Error('图片解码失败，请重新选择')
    err.code = 400
    throw err
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    const err = new Error(`图片过大（${(buf.length / 1024 / 1024).toFixed(1)}MB），请压缩到 3MB 以内`)
    err.code = 413
    throw err
  }

  ensureUploadDir()
  const name = `${sha1(buf)}.${ext}`
  const file = path.join(UPLOAD_DIR, name)
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, buf)
  }

  // 清理不再被引用的历史图片，避免 data 目录无限膨胀
  pruneImages(name)

  return {
    image: `upload:${name}`,
    size: buf.length,
    mime,
    fileName: str(fileName, 120, name),
  }
}

/** 删除目录内除 keepName 之外的所有历史配图 */
function pruneImages(keepName) {
  try {
    ensureUploadDir()
    const files = fs.readdirSync(UPLOAD_DIR)
    files.forEach((f) => {
      if (f === keepName) return
      if (!/\.(jpg|png|webp|gif)$/i.test(f)) return
      try {
        fs.unlinkSync(path.join(UPLOAD_DIR, f))
        imageCache.delete(f)
      } catch (e) {
        // 单个文件删除失败不影响主流程
      }
    })
  } catch (e) {
    // 目录不可读时忽略
  }
}

/** ------------------------------------------------------- 包内自带的海报 */

/**
 * 服务端包内自带的海报文件（与小程序包内 miniprogram/images/announcement/notice-poster.jpg 同一张）。
 *
 * 存在的意义：默认配置里的图片是「小程序包内路径」，真机要换图就得重新提交小程序版本。
 * 这里在服务端也放一份，首次部署（后台从未保存过公告）时自动落盘到 data/uploads，
 * 配置就以 upload: 形态下发——base64 走接口通道，不受图片域名白名单限制。
 * 于是「部署一次后端」就能让新海报在真机上立刻生效，不用重新发版审核。
 */
const BUNDLED_POSTER = path.join(__dirname, '..', 'assets', 'announcement-poster.jpg')

/** 落盘后的 upload: 值；null=还没试过，''=不可用（文件缺失或写盘失败） */
let bundledPosterImage = null

/**
 * 把包内自带的海报落一份到 data/uploads，返回 'upload:xxx.jpg'。
 * 任何一步失败都返回 ''（调用方继续用包内图片路径，行为与升级前一致）。
 */
function seedBundledPoster() {
  if (bundledPosterImage !== null) return bundledPosterImage
  bundledPosterImage = ''
  try {
    if (!fs.existsSync(BUNDLED_POSTER)) return bundledPosterImage
    const buf = fs.readFileSync(BUNDLED_POSTER)
    if (!buf.length) return bundledPosterImage

    ensureUploadDir()
    const name = `${sha1(buf)}.jpg`
    const file = path.join(UPLOAD_DIR, name)
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf)

    bundledPosterImage = `upload:${name}`
    console.log('[Announcement] 后台尚未保存过公告，已启用服务端自带海报:', bundledPosterImage)
  } catch (e) {
    console.warn('[Announcement] 服务端自带海报落盘失败，改用包内图片:', e && e.message)
  }
  return bundledPosterImage
}

/** ------------------------------------------------------------------ 主体 */

/**
 * 校验并清洗后台提交的配置。未提供的字段一律沿用「当前值或默认值」，
 * 这样后台只改标题也不会把其它字段清空。
 */
function sanitize(input, base) {
  const src = input && typeof input === 'object' ? input : {}
  const cur = { ...DEFAULT_ANNOUNCEMENT, ...(base && typeof base === 'object' ? base : {}) }
  const out = { ...cur }

  if ('enabled' in src) out.enabled = bool(src.enabled, cur.enabled)
  if ('showMode' in src) {
    const m = str(src.showMode, 30)
    out.showMode = SHOW_MODES.includes(m) ? m : cur.showMode
  }
  if ('version' in src) out.version = str(src.version, 40, cur.version) || cur.version
  if ('delayMs' in src) out.delayMs = intIn(src.delayMs, 0, 5000, cur.delayMs)

  if ('title' in src) out.title = text(src.title, 60)
  if ('text' in src) out.text = text(src.text, 600)
  if ('image' in src) out.image = normalizeImage(src.image)
  if ('imageMode' in src) {
    const m = str(src.imageMode, 20)
    out.imageMode = IMAGE_MODES.includes(m) ? m : cur.imageMode
  }
  if ('previewImage' in src) out.previewImage = bool(src.previewImage, cur.previewImage)

  if ('contactLabel' in src) out.contactLabel = text(src.contactLabel, 30)
  if ('contactValue' in src) out.contactValue = text(src.contactValue, 120)
  if ('copyButtonText' in src) out.copyButtonText = text(src.copyButtonText, 30)
  if ('copyToast' in src) out.copyToast = text(src.copyToast, 40)

  if ('confirmText' in src) out.confirmText = text(src.confirmText, 30)
  if ('maskClosable' in src) out.maskClosable = bool(src.maskClosable, cur.maskClosable)

  return out
}

/**
 * 返回小程序端完整可用的配置：
 *   - image 为 upload: 形态且内容缺失时，自动回退到默认包内图片，保证弹窗不会空图
 */
function getEffectiveConfig() {
  const stored = require('../db').getAnnouncement()
  const cfg = { ...DEFAULT_ANNOUNCEMENT, ...(stored || {}) }
  cfg.image = normalizeImage(cfg.image)

  // 后台从未保存过公告（比如刚部署好的云端容器）→ 用服务端自带海报。
  // 一旦后台点过「保存并生效」，stored 就有值，以后台配置为准，这里不再干预。
  if (!stored) {
    const seeded = seedBundledPoster()
    if (seeded) cfg.image = seeded
  }

  if (cfg.image.startsWith('upload:') && !resolveUploadPath(cfg.image)) {
    // 图片文件丢失（比如容器重启丢了 data 卷）→ 退回内置图，避免白块
    console.warn('[Announcement] 配图文件缺失，已回退到内置默认图:', cfg.image)
    cfg.image = DEFAULT_ANNOUNCEMENT.image
  }

  if (!cfg.title) cfg.title = DEFAULT_ANNOUNCEMENT.title
  if (!cfg.confirmText) cfg.confirmText = DEFAULT_ANNOUNCEMENT.confirmText
  if (!cfg.contactValue || cfg.contactValue === 'chinesehsc' || cfg.contactValue === 'chinesehsc / Woxiangxingfu777') {
    cfg.contactValue = DEFAULT_ANNOUNCEMENT.contactValue
  } else if (typeof cfg.contactValue === 'string' && cfg.contactValue.includes('chinesehsc')) {
    cfg.contactValue = cfg.contactValue.replace(/chinesehsc/g, 'Corwin07')
  }

  return cfg
}

/**
 * 组装下发给小程序的响应体
 * @param {object} cfg 生效配置
 * @param {string} clientImageVersion 客户端本地已有的配图版本，相同则不下发 base64（省流量）
 * @param {boolean} withImage 是否允许下发 base64 图片
 */
function buildPayload(cfg, clientImageVersion, withImage = true) {
  const imageVersion = getImageVersion(cfg)

  const payload = {
    config: {
      enabled: cfg.enabled,
      showMode: cfg.showMode,
      version: cfg.version,
      delayMs: cfg.delayMs,
      title: cfg.title,
      text: cfg.text,
      image: cfg.image,
      imageMode: cfg.imageMode,
      previewImage: cfg.previewImage,
      contactLabel: cfg.contactLabel,
      contactValue: cfg.contactValue,
      copyButtonText: cfg.copyButtonText,
      copyToast: cfg.copyToast,
      confirmText: cfg.confirmText,
      maskClosable: cfg.maskClosable,
      updatedAt: cfg.updatedAt || 0,
    },
    imageVersion,
    imageBase64: null,
    imageMime: null,
  }

  if (
    withImage &&
    imageVersion &&
    imageVersion !== clientImageVersion &&
    cfg.image.startsWith('upload:')
  ) {
    const img = readUploadImage(cfg.image)
    if (img) {
      payload.imageBase64 = img.base64
      payload.imageMime = img.mime
    }
  }

  return payload
}

/** 后台专用的完整信息（含可预览的图片地址） */
function buildAdminPayload(req) {
  const cfg = getEffectiveConfig()
  const imageVersion = getImageVersion(cfg)
  const isUpload = cfg.image.startsWith('upload:')
  const host = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`
  return {
    config: { ...cfg },
    imageVersion,
    isUpload,
    imageUrl: isUpload ? `${host}/uploads/announcement/${cfg.image.slice('upload:'.length)}` : '',
    imageSize: isUpload && resolveUploadPath(cfg.image) ? fs.statSync(resolveUploadPath(cfg.image)).size : 0,
    defaults: DEFAULT_ANNOUNCEMENT,
  }
}

module.exports = {
  DEFAULT_ANNOUNCEMENT,
  UPLOAD_DIR,
  sanitize,
  getEffectiveConfig,
  getImageVersion,
  saveUploadedImage,
  buildPayload,
  buildAdminPayload,
}
