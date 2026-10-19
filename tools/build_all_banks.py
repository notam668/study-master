# -*- coding: utf-8 -*-
"""
大学题库全科打包与构建工具
功能：
1. 读取各学科题库（近代史、马哲、毛概、思修、计算机基础、军事理论）
2. 清洗、校验题库结构，生成符合小程序 SharedBank 规范的统一格式
3. 将题库分片并输出到 miniprogram/utils 目录
4. 自动生成与更新 miniprogram/utils/loadBuiltinBanks.js
"""

import os
import sys
import json
import re

sys.stdout.reconfigure(encoding='utf-8')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UTILS_DIR = os.path.join(ROOT_DIR, 'miniprogram', 'utils')
BANKS_DATA_DIR = os.path.join(ROOT_DIR, 'tools', 'banks_data')

# 导入各科题库数据
sys.path.insert(0, os.path.join(ROOT_DIR, 'tools'))
from banks_data.jindai import QUESTIONS as JINDAI_QUESTIONS
from banks_data.mayuan import QUESTIONS as MAYUAN_QUESTIONS
from banks_data.maogai import QUESTIONS as MAOGAI_QUESTIONS
from banks_data.sixiu import QUESTIONS as SIXIU_QUESTIONS
from banks_data.computer import QUESTIONS as COMPUTER_QUESTIONS

def normalize_question(q, prefix, index):
    qtype = q.get('type')
    stem = q.get('stem', '').strip()
    chapter = q.get('chapter', '').strip()
    extra_note = q.get('extraNote', '').strip()
    qid = f"{prefix}-{index + 1}"

    item = {
        'id': qid,
        'type': qtype,
        'stem': stem,
        'chapter': chapter,
    }

    if qtype == 'judge':
        item['answer'] = bool(q.get('answer'))
        if extra_note:
            item['extraNote'] = extra_note

    elif qtype == 'choice':
        options = [str(opt).strip() for opt in q.get('options', [])]
        item['options'] = options
        item['answerIndex'] = int(q.get('answerIndex', 0))
        if extra_note:
            item['extraNote'] = extra_note

    elif qtype == 'multi':
        options = [str(opt).strip() for opt in q.get('options', [])]
        item['options'] = options
        item['answerIndices'] = [int(i) for i in q.get('answerIndices', [])]
        if extra_note:
            item['extraNote'] = extra_note

    elif qtype == 'fill':
        item['answers'] = [str(a).strip() for a in q.get('answers', [])]
        if extra_note:
            item['extraNote'] = extra_note

    return item

def load_and_clean_junli():
    """读取现有军事理论题库并轻量化"""
    junli_path = os.path.join(ROOT_DIR, '军理题库.json')
    if not os.path.exists(junli_path):
        junli_path = os.path.join(UTILS_DIR, 'junli-bank.json')

    if not os.path.exists(junli_path):
        print(f"警告: 未找到 {junli_path}，尝试从现存 part 文件读取...")
        # 从现有的 part 文件合成
        questions = []
        part_idx = 1
        while True:
            p = os.path.join(UTILS_DIR, f"junli-bank-part-{part_idx}.js")
            if not os.path.exists(p):
                break
            with open(p, 'r', encoding='utf-8') as f:
                content = f.read()
                # 提取 module.exports = [...]
                m = re.search(r'module\.exports\s*=\s*(\[.*\])', content, re.DOTALL)
                if m:
                    arr = json.loads(m.group(1))
                    questions.extend(arr)
            part_idx += 1
        raw_bank = {
            'bankId': 'bank-junli',
            'title': '军事理论题库',
            'version': 3,
            'questions': questions
        }
    else:
        with open(junli_path, 'r', encoding='utf-8') as f:
            raw_bank = json.load(f)

    # 规范化并去除军理中的无意义冗余空字段（静态只存核心字段）
    cleaned_qs = []
    for i, q in enumerate(raw_bank.get('questions', [])):
        qtype = q.get('type')
        item = {
            'id': q.get('id') or f"q{i+1}",
            'type': qtype,
            'stem': q.get('stem', '').strip(),
            'chapter': q.get('chapter', '').strip(),
        }
        if qtype == 'judge':
            item['answer'] = bool(q.get('answer'))
            if q.get('extraNote') and str(q['extraNote']).strip():
                item['extraNote'] = str(q['extraNote']).strip()
        elif qtype == 'choice':
            item['options'] = q.get('options', [])
            item['answerIndex'] = int(q.get('answerIndex', 0))
            if q.get('extraNote') and str(q['extraNote']).strip():
                item['extraNote'] = str(q['extraNote']).strip()
        elif qtype == 'multi':
            item['options'] = q.get('options', [])
            item['answerIndices'] = [int(idx) for idx in q.get('answerIndices', [])]
            if q.get('extraNote') and str(q['extraNote']).strip():
                item['extraNote'] = str(q['extraNote']).strip()
        elif qtype == 'fill':
            item['answers'] = q.get('answers', [])
            if q.get('extraNote') and str(q['extraNote']).strip():
                item['extraNote'] = str(q['extraNote']).strip()
        cleaned_qs.append(item)

    return {
        'bankId': 'bank-junli',
        'title': '军事理论题库',
        'version': raw_bank.get('version', 3),
        'prefix': 'junli',
        'questions': cleaned_qs
    }

def build_bank_files(bank, part_size=400):
    prefix = bank['prefix']
    bank_id = bank['bankId']
    title = bank['title']
    version = bank.get('version', 1)
    questions = bank['questions']

    # 1. 清理该题库旧的 part 文件
    for fname in os.listdir(UTILS_DIR):
        if re.match(rf'^{prefix}-bank-part-\d+\.js$', fname):
            os.remove(os.path.join(UTILS_DIR, fname))

    imports = []
    for start in range(0, len(questions), part_size):
        part_num = (start // part_size) + 1
        part_name = f"{prefix}-bank-part-{part_num}.js"
        part_path = os.path.join(UTILS_DIR, part_name)
        slice_qs = questions[start : start + part_size]

        js_content = f"'use strict'\n\nmodule.exports = {json.dumps(slice_qs, ensure_ascii=False, separators=(',', ':'))}\n"
        with open(part_path, 'w', encoding='utf-8') as f:
            f.write(js_content)

        imports.append(f"require('./{prefix}-bank-part-{part_num}')")

    index_name = f"{prefix}-bank-index.js"
    index_path = os.path.join(UTILS_DIR, index_name)
    metadata = {
        'bankId': bank_id,
        'title': title,
        'version': version,
    }
    joined_imports = ',\n  '.join(imports)
    meta_json = json.dumps(metadata, ensure_ascii=False, indent=2)
    index_content = (
        f"'use strict'\n\n"
        f"module.exports = {meta_json}\n"
        f"module.exports.questions = [].concat(\n  {joined_imports}\n)\n"
    )
    with open(index_path, 'w', encoding='utf-8') as f:
        f.write(index_content)

    print(f"[{title}] 构建完成: 共 {len(questions)} 题, 分成 {len(imports)} 个模块")

def main():
    print("=== 开始构建大学全科必修题库系统 ===")

    all_banks_meta = []

    # 1. 军事理论
    junli_bank = load_and_clean_junli()
    build_bank_files(junli_bank, part_size=400)
    all_banks_meta.append(('junli', junli_bank['bankId'], junli_bank['title']))

    # 2. 中国近现代史纲要
    jindai_qs = [normalize_question(q, 'jindai', i) for i, q in enumerate(JINDAI_QUESTIONS)]
    jindai_bank = {
        'bankId': 'bank-jindai',
        'title': '中国近现代史纲要',
        'version': 1,
        'prefix': 'jindai',
        'questions': jindai_qs
    }
    build_bank_files(jindai_bank, part_size=400)
    all_banks_meta.append(('jindai', jindai_bank['bankId'], jindai_bank['title']))

    # 3. 马克思主义基本原理
    mayuan_qs = [normalize_question(q, 'mayuan', i) for i, q in enumerate(MAYUAN_QUESTIONS)]
    mayuan_bank = {
        'bankId': 'bank-mayuan',
        'title': '马克思主义基本原理',
        'version': 1,
        'prefix': 'mayuan',
        'questions': mayuan_qs
    }
    build_bank_files(mayuan_bank, part_size=400)
    all_banks_meta.append(('mayuan', mayuan_bank['bankId'], mayuan_bank['title']))

    # 4. 毛泽东思想和中国特色社会主义理论体系概论
    maogai_qs = [normalize_question(q, 'maogai', i) for i, q in enumerate(MAOGAI_QUESTIONS)]
    maogai_bank = {
        'bankId': 'bank-maogai',
        'title': '毛泽东思想和中国特色社会主义理论体系概论',
        'version': 1,
        'prefix': 'maogai',
        'questions': maogai_qs
    }
    build_bank_files(maogai_bank, part_size=400)
    all_banks_meta.append(('maogai', maogai_bank['bankId'], maogai_bank['title']))

    # 5. 思想道德与法治
    sixiu_qs = [normalize_question(q, 'sixiu', i) for i, q in enumerate(SIXIU_QUESTIONS)]
    sixiu_bank = {
        'bankId': 'bank-sixiu',
        'title': '思想道德与法治',
        'version': 1,
        'prefix': 'sixiu',
        'questions': sixiu_qs
    }
    build_bank_files(sixiu_bank, part_size=400)
    all_banks_meta.append(('sixiu', sixiu_bank['bankId'], sixiu_bank['title']))

    # 6. 大学计算机基础
    computer_qs = [normalize_question(q, 'comp', i) for i, q in enumerate(COMPUTER_QUESTIONS)]
    computer_bank = {
        'bankId': 'bank-computer',
        'title': '大学计算机基础',
        'version': 1,
        'prefix': 'computer',
        'questions': computer_qs
    }
    build_bank_files(computer_bank, part_size=400)
    all_banks_meta.append(('computer', computer_bank['bankId'], computer_bank['title']))

    # 生成 loadBuiltinBanks.js
    load_code_lines = [
        "'use strict'",
        "",
        "/**",
        " * 官方及高校常见公共课内置题库统一加载器",
        " * 覆盖：军事理论、中国近现代史纲要、马克思主义基本原理、毛泽东思想概论、思想道德与法治、大学计算机基础",
        " */",
    ]

    for prefix, _, _ in all_banks_meta:
        load_code_lines.append(f"var {prefix} = require('./{prefix}-bank-index')")

    load_code_lines.extend([
        "",
        "var allBanks = [",
        "  " + ",\n  ".join([prefix for prefix, _, _ in all_banks_meta]),
        "]",
        "",
        "function hydrate(q) {",
        "  if (!q) return q",
        "  if (!q.answerText) {",
        "    if (q.type === 'judge') {",
        "      q.answerText = q.answer ? '正确' : '错误'",
        "      q.correctText = q.answerText",
        "    } else if (q.type === 'choice') {",
        "      var letter = String.fromCharCode(65 + q.answerIndex)",
        "      q.answerText = letter",
        "      q.correctText = letter + '. ' + (q.options && q.options[q.answerIndex] ? q.options[q.answerIndex] : '')",
        "    } else if (q.type === 'multi') {",
        "      var indices = q.answerIndices || []",
        "      var letters = indices.map(function(idx) { return String.fromCharCode(65 + idx) }).join('')",
        "      q.answerText = letters",
        "      var summary = indices.map(function(idx) {",
        "        return String.fromCharCode(65 + idx) + '. ' + (q.options && q.options[idx] ? q.options[idx] : '')",
        "      })",
        "      q.correctText = letters + ' (' + summary.join('；') + ')'",
        "    } else if (q.type === 'fill') {",
        "      q.answerText = (q.answers && q.answers[0]) || ''",
        "      q.correctText = q.answerText",
        "    }",
        "  }",
        "  return q",
        "}",
        "",
        "function hydrateBank(bank) {",
        "  if (bank && bank.questions && !bank._hydrated) {",
        "    for (var i = 0; i < bank.questions.length; i++) {",
        "      hydrate(bank.questions[i])",
        "    }",
        "    bank._hydrated = true",
        "  }",
        "  return bank",
        "}",
        "",
        "function getAllBanks() {",
        "  for (var i = 0; i < allBanks.length; i++) {",
        "    hydrateBank(allBanks[i])",
        "  }",
        "  return allBanks",
        "}",
        "",
        "function getBankById(id) {",
        "  for (var i = 0; i < allBanks.length; i++) {",
        "    if (allBanks[i] && allBanks[i].bankId === id) {",
        "      return hydrateBank(allBanks[i])",
        "    }",
        "  }",
        "  return undefined",
        "}",
        "",
        "module.exports = {",
        "  getAllBanks: getAllBanks,",
        "  getBankById: getBankById,",
        "}",
        ""
    ])

    loader_path = os.path.join(UTILS_DIR, 'loadBuiltinBanks.js')
    with open(loader_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(load_code_lines))

    print(f"\n[loadBuiltinBanks.js] 更新成功！包含 {len(all_banks_meta)} 门大学核心科目题库。")

if __name__ == '__main__':
    main()
