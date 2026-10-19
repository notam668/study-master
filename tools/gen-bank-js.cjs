/**
 * 将题库 JSON 转为 miniprogram 可 require 的 .js（微信不支持 require .json 进包）
 * 用法: node tools/gen-bank-js.cjs
 * 默认读项目根目录 军理题库.json，写出 miniprogram/utils/junli-bank-part-*.js 与索引文件。
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const candidates = [
  path.join(root, '军理题库.json'),
  path.join(root, 'miniprogram', 'utils', 'junli-bank.json'),
]
const outputDir = path.join(root, 'miniprogram', 'utils')
const indexPath = path.join(outputDir, 'junli-bank-index.js')
const partSize = 400

let srcPath = null
for (const p of candidates) {
  if (fs.existsSync(p)) {
    srcPath = p
    break
  }
}
if (!srcPath) {
  console.error('未找到输入 JSON，请将 军理题库.json 放在项目根目录，或 miniprogram/utils/junli-bank.json')
  process.exit(1)
}

const raw = fs.readFileSync(srcPath, 'utf8').trim()
const bank = JSON.parse(raw) // 校验语法

if (!bank || !Array.isArray(bank.questions)) {
  console.error('题库格式错误：缺少 questions 数组')
  process.exit(1)
}

const oldParts = fs.readdirSync(outputDir)
  .filter((name) => /^junli-bank-part-\d+\.js$/.test(name))
for (const name of oldParts) {
  fs.unlinkSync(path.join(outputDir, name))
}

const imports = []
for (let start = 0, part = 1; start < bank.questions.length; start += partSize, part += 1) {
  const partName = `junli-bank-part-${part}.js`
  const partPath = path.join(outputDir, partName)
  const questions = bank.questions.slice(start, start + partSize)
  fs.writeFileSync(partPath, `'use strict'\n\nmodule.exports = ${JSON.stringify(questions)}\n`, 'utf8')
  imports.push(`require('./${partName.slice(0, -3)}')`)
}

const metadata = {
  bankId: bank.bankId,
  title: bank.title,
  version: bank.version,
}
const indexSource = `'use strict'\n\nmodule.exports = ${JSON.stringify(metadata, null, 2)}\nmodule.exports.questions = [].concat(\n  ${imports.join(',\n  ')}\n)\n`
fs.writeFileSync(indexPath, indexSource, 'utf8')

console.log(`OK: 已生成 ${imports.length} 个题库分片与索引文件`)
