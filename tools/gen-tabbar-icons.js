const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

function createPng(width, height, drawFn) {
  // RGBA buffer
  const buffer = Buffer.alloc(width * height * 4, 0)
  const setPixel = (x, y, r, g, b, a = 255) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const idx = (y * width + x) * 4
    buffer[idx] = r
    buffer[idx + 1] = g
    buffer[idx + 2] = b
    buffer[idx + 3] = a
  }

  drawFn(setPixel, width, height)

  // PNG IDAT format: for each line, 1 filter byte (0) + width * 4 bytes
  const scanlines = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const scanlineOffset = y * (1 + width * 4)
    scanlines[scanlineOffset] = 0 // Filter type None
    buffer.copy(scanlines, scanlineOffset + 1, y * width * 4, (y + 1) * width * 4)
  }

  const compressed = zlib.deflateSync(scanlines)

  function crc32(buf) {
    let crc = 0xffffffff
    for (let i = 0; i < buf.length; i++) {
      let byte = buf[i]
      for (let j = 0; j < 8; j++) {
        if ((crc ^ byte) & 1) {
          crc = (crc >>> 1) ^ 0xedb88320
        } else {
          crc = crc >>> 1
        }
        byte = byte >>> 1
      }
    }
    return (crc ^ 0xffffffff) >>> 0
  }

  function makeChunk(type, data) {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const typeBuf = Buffer.from(type, 'ascii')
    const toCrc = Buffer.concat([typeBuf, data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(toCrc), 0)
    return Buffer.concat([len, typeBuf, data, crc])
  }

  const header = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) // PNG signature
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  const ihdrChunk = makeChunk('IHDR', ihdr)
  const idatChunk = makeChunk('IDAT', compressed)
  const iendChunk = makeChunk('IEND', Buffer.alloc(0))

  return Buffer.concat([header, ihdrChunk, idatChunk, iendChunk])
}

const W = 81
const H = 81

const COLOR_INACTIVE = [148, 163, 184] // #94a3b8
const COLOR_ACTIVE = [79, 70, 229]    // #4f46e5

function dist(x1, y1, x2, y2) {
  return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2)
}

// 1. 刷题图标：书本与笔
function drawPractice(setPixel, [r, g, b], isActive) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // 外轮廓与书页
      const inLeftPage = x >= 14 && x <= 38 && y >= 20 && y <= 60
      const inRightPage = x >= 42 && x <= 66 && y >= 20 && y <= 60
      const inSpine = x >= 38 && x <= 42 && y >= 18 && y <= 62

      if (inSpine) {
        setPixel(x, y, r, g, b, 255)
      } else if (inLeftPage || inRightPage) {
        const isBorder = (x === 14 || x === 38 || x === 42 || x === 66 || y === 20 || y === 60)
        // 书页线条
        const isLine = (y === 30 || y === 40 || y === 50) && ((x >= 20 && x <= 34) || (x >= 46 && x <= 60))
        if (isActive) {
          if (isBorder || isLine) setPixel(x, y, r, g, b, 255)
          else setPixel(x, y, r, g, b, 40) // 内部半透明填充
        } else {
          if (isBorder || isLine) setPixel(x, y, r, g, b, 255)
        }
      }
    }
  }
}

// 2. 课表图标：日历网格
function drawSchedule(setPixel, [r, g, b], isActive) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // 日历主体外框
      const inBody = x >= 16 && x <= 64 && y >= 18 && y <= 64
      const inHeader = x >= 16 && x <= 64 && y >= 18 && y <= 28
      const inRings = (x >= 24 && x <= 28 && y >= 12 && y <= 22) || (x >= 52 && x <= 56 && y >= 12 && y <= 22)

      if (inRings) {
        setPixel(x, y, r, g, b, 255)
      } else if (inHeader) {
        setPixel(x, y, r, g, b, 255)
      } else if (inBody) {
        const isBorder = x === 16 || x === 64 || y === 64
        // 内部日历网格小方块
        const gridX = (x >= 23 && x <= 29) || (x >= 37 && x <= 43) || (x >= 51 && x <= 57)
        const gridY = (y >= 34 && y <= 40) || (y >= 46 && y <= 52)
        const isGrid = gridX && gridY

        if (isBorder || isGrid) {
          setPixel(x, y, r, g, b, 255)
        } else if (isActive) {
          setPixel(x, y, r, g, b, 30)
        }
      }
    }
  }
}

// 3. 主页图标：个人名片/头像
function drawProfile(setPixel, [r, g, b], isActive) {
  const headCx = 40.5
  const headCy = 27
  const headR = 12

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // 头部圆圈
      const d = dist(x, y, headCx, headCy)
      if (d <= headR) {
        if (isActive) {
          setPixel(x, y, r, g, b, 255)
        } else {
          if (d >= headR - 3) setPixel(x, y, r, g, b, 255)
        }
      }

      // 身体/肩部圆弧
      const inBodyBox = y >= 45 && y <= 66 && x >= 16 && x <= 65
      if (inBodyBox) {
        // 椭圆身体下半部
        const bodyD = ((x - 40.5) / 24) ** 2 + ((y - 65) / 18) ** 2
        if (bodyD <= 1) {
          if (isActive) {
            setPixel(x, y, r, g, b, 255)
          } else {
            if (bodyD >= 0.65) setPixel(x, y, r, g, b, 255)
          }
        }
      }
    }
  }
}

// 0. 首页图标：小房子
function drawHome(setPixel, [r, g, b], isActive) {
  const cx = 40.5
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = Math.abs(x - cx)
      // 屋顶：斜坡
      const roofTop = 18 + dx * 0.95
      const inRoof = y >= roofTop && y <= 40 && dx <= 25

      // 房屋墙体
      const inWalls = x >= 21 && x <= 60 && y >= 38 && y <= 64

      // 居中门洞
      const inDoor = x >= 34 && x <= 47 && y >= 47 && y <= 64

      if (inRoof || inWalls) {
        if (inDoor) {
          continue
        }
        if (isActive) {
          setPixel(x, y, r, g, b, 255)
        } else {
          const isRoofBorder = (y >= roofTop && y <= roofTop + 3.2) || (y >= 37 && y <= 40 && dx >= 21)
          const isWallBorder = x <= 24 || x >= 57 || y >= 61
          const isDoorBorder =
            (x >= 34 && x <= 37 && y >= 47) ||
            (x >= 44 && x <= 47 && y >= 47) ||
            (y >= 47 && y <= 50 && x >= 34 && x <= 47)
          if (isRoofBorder || (inWalls && isWallBorder) || isDoorBorder) {
            setPixel(x, y, r, g, b, 255)
          }
        }
      }
    }
  }
}

const outDir = path.join(__dirname, '..', 'miniprogram', 'images', 'tabbar')
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true })
}

const icons = [
  { name: 'home.png', fn: (sp) => drawHome(sp, COLOR_INACTIVE, false) },
  { name: 'home-active.png', fn: (sp) => drawHome(sp, COLOR_ACTIVE, true) },
  { name: 'practice.png', fn: (sp) => drawPractice(sp, COLOR_INACTIVE, false) },
  { name: 'practice-active.png', fn: (sp) => drawPractice(sp, COLOR_ACTIVE, true) },
  { name: 'schedule.png', fn: (sp) => drawSchedule(sp, COLOR_INACTIVE, false) },
  { name: 'schedule-active.png', fn: (sp) => drawSchedule(sp, COLOR_ACTIVE, true) },
  { name: 'profile.png', fn: (sp) => drawProfile(sp, COLOR_INACTIVE, false) },
  { name: 'profile-active.png', fn: (sp) => drawProfile(sp, COLOR_ACTIVE, true) },
]

for (const icon of icons) {
  const pngBuf = createPng(W, H, icon.fn)
  fs.writeFileSync(path.join(outDir, icon.name), pngBuf)
  console.log('Generated:', icon.name)
}
console.log('All tabbar icons generated successfully!')
