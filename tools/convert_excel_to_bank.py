# -*- coding: utf-8 -*-
import os
import xlrd
import json
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')

def clean_opt_text(opt):
    if isinstance(opt, float) and opt.is_integer():
        s = str(int(opt)).strip()
    else:
        s = str(opt).strip()
    s = re.sub(r'^[A-Da-d][、\.．\s:：]+', '', s).strip()
    return s

def clean_fill_answer(ans):
    if isinstance(ans, float) and ans.is_integer():
        return str(int(ans)).strip()
    s = str(ans).strip()
    if re.match(r'^\d+\.0$', s):
        s = s[:-2]
    return s

def convert(excel_path, output_json_path, output_utils_dir=None):
    book = xlrd.open_workbook(excel_path)
    sh = book.sheet_by_index(0)
    print(f"读取 Excel 文件: {excel_path}")
    print(f"工作表: {sh.name}, 总行数: {sh.nrows}, 总列数: {sh.ncols}")

    questions = []
    type_counts = {}
    chapter_counts = {}
    char_map = {'A': 0, 'B': 1, 'C': 2, 'D': 3, 'E': 4, 'F': 5}

    # 判断表格格式（新格式为9列：课程名称, 章节名称, 题型, 题目要求, 选项A, 选项B, 选项C, 选项D, 答案）
    is_9col_format = sh.ncols == 9 or (sh.ncols > 8 and '题目要求' in str(sh.cell_value(0, 3)))

    for r in range(1, sh.nrows):
        if is_9col_format:
            chapter = str(sh.cell_value(r, 1)).strip() or '军事理论'
            qtype = str(sh.cell_value(r, 2)).strip()
            stem = str(sh.cell_value(r, 3)).strip()
            raw_opts = [sh.cell_value(r, c) for c in range(4, 8)]
            raw_ans = sh.cell_value(r, 8)
            extra_note = ''
        else:
            chapter = str(sh.cell_value(r, 1)).strip() or '军事理论'
            qtype = str(sh.cell_value(r, 2)).strip()
            stem = str(sh.cell_value(r, 4)).strip()
            raw_opts = [sh.cell_value(r, c) for c in range(5, 9)]
            raw_ans = sh.cell_value(r, 9) if sh.ncols > 9 else ''
            extra_note = str(sh.cell_value(r, 10)).strip() if sh.ncols > 10 else ''

        if not stem and not qtype:
            continue

        qid = f"q{len(questions) + 1}"
        chapter_counts[chapter] = chapter_counts.get(chapter, 0) + 1

        if '判断' in qtype:
            ans_str = str(raw_ans).strip().upper()
            is_true = ans_str in ['T', 'TRUE', '对', '正确', '1', '√']
            item = {
                'id': qid,
                'type': 'judge',
                'stem': stem,
                'chapter': chapter,
                'answer': is_true
            }
            if extra_note:
                item['extraNote'] = extra_note
            questions.append(item)
            type_counts['judge'] = type_counts.get('judge', 0) + 1

        elif '单选' in qtype or '单择' in qtype:
            ans_str = str(raw_ans).strip().upper()
            ans_idx = char_map.get(ans_str[0] if ans_str else 'A', 0)
            options = [clean_opt_text(opt) for opt in raw_opts]
            item = {
                'id': qid,
                'type': 'choice',
                'stem': stem,
                'chapter': chapter,
                'options': options,
                'answerIndex': ans_idx
            }
            if extra_note:
                item['extraNote'] = extra_note
            questions.append(item)
            type_counts['choice'] = type_counts.get('choice', 0) + 1

        elif '多选' in qtype:
            ans_str = str(raw_ans).strip().upper()
            indices = [char_map[ch] for ch in ans_str if ch in char_map]
            options = [clean_opt_text(opt) for opt in raw_opts]
            item = {
                'id': qid,
                'type': 'multi',
                'stem': stem,
                'chapter': chapter,
                'options': options,
                'answerIndices': indices
            }
            if extra_note:
                item['extraNote'] = extra_note
            questions.append(item)
            type_counts['multi'] = type_counts.get('multi', 0) + 1

        elif '填空' in qtype:
            ans_clean = clean_fill_answer(raw_ans)
            answers = [ans_clean]
            collapsed = re.sub(r'\s+', '', ans_clean)
            if collapsed != ans_clean and collapsed:
                answers.append(collapsed)
            item = {
                'id': qid,
                'type': 'fill',
                'stem': stem,
                'chapter': chapter,
                'answers': answers
            }
            if extra_note:
                item['extraNote'] = extra_note
            questions.append(item)
            type_counts['fill'] = type_counts.get('fill', 0) + 1

        else:
            print(f"警告: 未知题型 行{r}: {qtype}")

    bank = {
        'bankId': 'bank-junli',
        'title': '军事理论题库',
        'version': 3,
        'total': len(questions),
        'questions': questions
    }

    with open(output_json_path, 'w', encoding='utf-8') as f:
        json.dump(bank, f, ensure_ascii=False, indent=2)

    print(f"\n[OK] 成功导出题库 JSON: {output_json_path}")
    print(f"总题数: {len(questions)}")
    print("题型分布:")
    for t, count in type_counts.items():
        print(f"  - {t}: {count}")
    print("章节分布:")
    for ch, count in chapter_counts.items():
        print(f"  - {ch}: {count}")

    # 如果指定了小程序 utils 目录，直接构建分片 JS 和索引
    if output_utils_dir and os.path.exists(output_utils_dir):
        build_miniprogram_parts(bank, output_utils_dir, part_size=400)

    return bank

def build_miniprogram_parts(bank, utils_dir, part_size=400):
    print(f"\n[开始生成小程序分片文件] -> {utils_dir}")
    # 1. 彻底删除旧的所有 junli-bank-part-*.js
    removed_count = 0
    for fname in os.listdir(utils_dir):
        if re.match(r'^junli-bank-part-\d+\.js$', fname):
            os.remove(os.path.join(utils_dir, fname))
            removed_count += 1
    print(f"已清理旧分片文件: {removed_count} 个")

    # 2. 分片生成新的 js
    questions = bank['questions']
    imports = []
    for start in range(0, len(questions), part_size):
        part_num = (start // part_size) + 1
        part_name = f"junli-bank-part-{part_num}.js"
        part_path = os.path.join(utils_dir, part_name)
        slice_qs = questions[start : start + part_size]

        js_content = f"'use strict'\n\nmodule.exports = {json.dumps(slice_qs, ensure_ascii=False, separators=(',', ':'))}\n"
        with open(part_path, 'w', encoding='utf-8') as f:
            f.write(js_content)

        imports.append(f"require('./junli-bank-part-{part_num}')")
        print(f"  生成分片: {part_name} (第 {start+1} ~ {min(start+part_size, len(questions))} 题, 共 {len(slice_qs)} 题)")

    # 3. 生成索引文件 junli-bank-index.js
    index_path = os.path.join(utils_dir, 'junli-bank-index.js')
    metadata = {
        'bankId': bank['bankId'],
        'title': bank['title'],
        'version': bank['version']
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

    print(f"[OK] 索引文件已更新: {index_path} (引入 {len(imports)} 个分片)")

if __name__ == '__main__':
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    utils_dir = os.path.join(project_root, 'miniprogram', 'utils')
    default_out_json = os.path.join(project_root, '军理题库.json')

    # 查找可能的输入文件
    candidates = [
        r'c:\Users\manjunzong\xwechat_files\wxid_qf9mbb0dygci32_583e\msg\file\2026-10\试题库2026秋(1).xls',
        os.path.join(project_root, 'tools', '2026秋_军理试题库.xls'),
        os.path.join(project_root, 'tools', '试题库2026秋(1).xls'),
        os.path.join(project_root, '1_军理题库修正版.xls')
    ]
    default_excel = None
    for c in candidates:
        if os.path.exists(c):
            default_excel = c
            break

    excel_file = sys.argv[1] if len(sys.argv) > 1 else default_excel
    out_json = sys.argv[2] if len(sys.argv) > 2 else default_out_json

    if not excel_file or not os.path.exists(excel_file):
        print(f"提示: 未找到 Excel 输入文件: {excel_file}")
        print("用法: python tools/convert_excel_to_bank.py [输入.xls] [输出.json]")
    else:
        convert(excel_file, out_json, output_utils_dir=utils_dir)
