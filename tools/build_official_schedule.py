# -*- coding: utf-8 -*-
"""
课表官方数据构建脚本
从 "2026年秋学期班级课表0904(1).rar" 官方数据源解析全校各班级课表，
生成：
1. server/data/timetable_cache.json  (供服务端接口与微信上课提醒服务使用)
2. miniprogram/utils/localScheduleData.js (供小程序端离线极速渲染使用)
"""

import os
import sys
import glob
import re
import json
import subprocess
import xlrd

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAR_FILE_NAME = "2026年秋学期班级课表0904(1).rar"
RAR_PATH = os.path.join(BASE_DIR, RAR_FILE_NAME)
EXTRACT_DIR = os.path.join(BASE_DIR, "extracted_schedules")

SERVER_CACHE_PATH = os.path.join(BASE_DIR, "server", "data", "timetable_cache.json")
MINIPROGRAM_DATA_PATH = os.path.join(BASE_DIR, "miniprogram", "utils", "localScheduleData.js")

TERM_ID = "2026-2027-1"
TERM_LABEL = "2026-2027学年第1学期"
MAX_WEEK = 19
TERM_START_DATE = "2026-09-07"

cell_period_pattern = re.compile(r'^(.*?)/\((\d+(?:-\d+)?节)\)(.*)$')

def ensure_extracted():
    """如果 extracted_schedules 目录不存在或为空，则调用 WinRAR 进行解压"""
    if os.path.exists(EXTRACT_DIR) and len(glob.glob(os.path.join(EXTRACT_DIR, "**", "*.xls"), recursive=True)) > 700:
        print(f"[1/4] 检测到已解压课表目录：{EXTRACT_DIR}，文件数充足，直接使用。")
        return

    print(f"[1/4] 正在从 {RAR_PATH} 解压全校班级课表...")
    rar_exe = None
    for candidate in [
        r"C:\Program Files\WinRAR\Rar.exe",
        r"C:\Program Files\WinRAR\WinRAR.exe",
        r"C:\Program Files\7-Zip\7z.exe",
        r"C:\Program Files (x86)\7-Zip\7z.exe"
    ]:
        if os.path.exists(candidate):
            rar_exe = candidate
            break

    if not rar_exe:
        raise RuntimeError("未在系统中找到 WinRAR 或 7-Zip 解压工具，请确认安装路径。")

    os.makedirs(EXTRACT_DIR, exist_ok=True)
    if "7z" in rar_exe.lower():
        cmd = [rar_exe, "x", "-y", f"-o{EXTRACT_DIR}", RAR_PATH]
    else:
        cmd = [rar_exe, "x", "-y", RAR_PATH, EXTRACT_DIR + "\\"]

    res = subprocess.run(cmd, capture_output=True)
    if res.returncode != 0:
        print("解压警告/错误信息:", res.stderr.decode('gbk', errors='ignore'))
    print(f"解压完成，已解压到 {EXTRACT_DIR}。")

def parse_week_segment(seg_str):
    """
    解析周次字符串，支持多段（如 1-8周,11-14周）、单周、双周、独立单周等
    返回 [{'start': int, 'end': int, 'parity': 'all'|'odd'|'even', 'raw': str}]
    """
    seg_str = (seg_str or '').strip()
    if not seg_str:
        return [{'start': 1, 'end': MAX_WEEK, 'parity': 'all', 'raw': ''}]
    
    subparts = seg_str.split(',')
    res = []
    for sp in subparts:
        sp = sp.strip()
        if not sp:
            continue
        parity = 'all'
        if '(单)' in sp or '（单）' in sp:
            parity = 'odd'
            sp = re.sub(r'[\(（]单[\)）]', '', sp)
        elif '(双)' in sp or '（双）' in sp:
            parity = 'even'
            sp = re.sub(r'[\(（]双[\)）]', '', sp)
        sp = sp.replace('周', '').strip()
        
        m_range = re.match(r'^(\d+)-(\d+)$', sp)
        if m_range:
            res.append({
                'start': int(m_range.group(1)),
                'end': int(m_range.group(2)),
                'parity': parity,
                'raw': seg_str
            })
        else:
            m_single = re.match(r'^(\d+)$', sp)
            if m_single:
                w = int(m_single.group(1))
                res.append({
                    'start': w,
                    'end': w,
                    'parity': parity,
                    'raw': seg_str
                })
            else:
                res.append({
                    'start': 1,
                    'end': MAX_WEEK,
                    'parity': parity,
                    'raw': seg_str
                })
    return res

def parse_cell(text, row_idx):
    """
    解析课表单元格内容，支持换行多课程、板块课、课程名含斜杠、地点含斜杠等
    """
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    results = []
    row_default_periods = {2: (1, 2), 3: (3, 4), 4: (5, 6), 5: (7, 8), 6: (9, 10)}
    
    for line in lines:
        m = cell_period_pattern.match(line)
        if m:
            course_name = m.group(1).strip()
            period_str = m.group(2).replace('节', '').strip()
            remainder = m.group(3).strip()
            
            if '-' in period_str:
                sp, ep = map(int, period_str.split('-'))
            else:
                sp = ep = int(period_str)
                
            if remainder.startswith('/'):
                remainder = remainder[1:]
                
            slash_idx_first = remainder.find('/')
            slash_idx_last = remainder.rfind('/')
            
            if slash_idx_first != -1 and slash_idx_last != -1:
                week_str = remainder[:slash_idx_first].strip()
                if slash_idx_first == slash_idx_last:
                    location = remainder[slash_idx_first + 1:].strip()
                    teacher = ''
                else:
                    location = remainder[slash_idx_first + 1:slash_idx_last].strip()
                    teacher = remainder[slash_idx_last + 1:].strip()
            else:
                week_str = remainder
                location = ''
                teacher = ''
                
            results.append({
                'courseName': course_name,
                'startPeriod': sp,
                'endPeriod': ep,
                'weekStr': week_str,
                'location': location,
                'teacher': teacher
            })
        else:
            # 兼容板块课（如：体育1(板块)、英语进阶1(板块)）
            sp, ep = row_default_periods.get(row_idx, (1, 2))
            results.append({
                'courseName': line,
                'startPeriod': sp,
                'endPeriod': ep,
                'weekStr': '1-16周',
                'location': '板块课(自选地点)',
                'teacher': '板块课教师'
            })
    return results

def get_class_name(file_path):
    """
    从文件路径或文件名获取班级标准名称
    """
    base = os.path.basename(file_path)
    if base.endswith('.xls'):
        base = base[:-4]
    if base.endswith('课表'):
        return base[:-2]
    # 处理类似 "C电气241课表1" -> "C电气241-1" 或 "C电气241-课表1"
    m = re.match(r'^(.*?)课表(\d+)$', base)
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    return base.replace('课表', '')

def build_all_schedules():
    ensure_extracted()
    
    files = sorted(glob.glob(os.path.join(EXTRACT_DIR, "**", "*.xls"), recursive=True))
    print(f"[2/4] 开始解析全校 Excel 课表，共 {len(files)} 个文件...")

    class_names = []
    class_set = set()
    queries = {}
    
    # 用于生成 localScheduleData.js 的池化结构
    pool = []
    pool_map = {}
    def pool_str(s):
        s = str(s or '')
        if s not in pool_map:
            pool_map[s] = len(pool)
            pool.append(s)
        return pool_map[s]

    local_schedules = {}
    total_sessions_count = 0

    for f in files:
        cls_name = get_class_name(f)
        if cls_name in class_set:
            # 重名班级追加后缀以区分
            cls_name = f"{cls_name}_ext"
        class_set.add(cls_name)
        class_names.append(cls_name)

        try:
            wb = xlrd.open_workbook(f)
            sh = wb.sheet_by_index(0)
        except Exception as e:
            print(f"读取文件失败: {f}, 错误: {e}")
            continue

        course_map = {}
        compact_list = []

        # Row 2 到 6 对应第 1 到 5 大节，Col 2 到 8 对应星期一至星期日
        for r in range(2, min(7, sh.nrows)):
            for c in range(2, min(9, sh.ncols)):
                day = c - 1 # 1=周一 ... 7=周日
                val = str(sh.cell_value(r, c)).strip()
                if not val:
                    continue

                items = parse_cell(val, r)
                for item in items:
                    cname = item['courseName']
                    loc = item['location']
                    tea = item['teacher']
                    sp = item['startPeriod']
                    ep = item['endPeriod']
                    week_segs = parse_week_segment(item['weekStr'])

                    # 1. 服务端完整结构
                    if cname not in course_map:
                        course_map[cname] = {
                            'courseName': cname,
                            'location': loc,
                            'teachers': [tea] if tea else [],
                            'sessions': []
                        }
                    else:
                        if tea and tea not in course_map[cname]['teachers']:
                            course_map[cname]['teachers'].append(tea)

                    for seg in week_segs:
                        total_sessions_count += 1
                        course_map[cname]['sessions'].append({
                            'day': day,
                            'startPeriod': sp,
                            'endPeriod': ep,
                            'location': loc,
                            'weeks': {
                                'segments': [{'start': seg['start'], 'end': seg['end']}],
                                'parity': seg['parity'],
                                'raw': seg['raw']
                            }
                        })

                        # 2. 小程序端池化压缩格式:
                        # [courseNameIdx, locationIdx, teacherIdx, day, startPeriod, endPeriod, startWeek, endWeek, parityIdx, rawWeeksIdx]
                        compact_list.append([
                            pool_str(cname),
                            pool_str(loc),
                            pool_str(tea),
                            day,
                            sp,
                            ep,
                            seg['start'],
                            seg['end'],
                            pool_str(seg['parity']),
                            pool_str(seg['raw'])
                        ])

        # 写入 queries (服务端)
        query_key = f"{TERM_ID}_class_{cls_name}"
        queries[query_key] = {
            'termId': TERM_ID,
            'kind': 'class',
            'name': cls_name,
            'courses': list(course_map.values())
        }
        # 写入 local_schedules (小程序端)
        local_schedules[cls_name] = compact_list

    # 构建并输出 server/data/timetable_cache.json
    server_data = {
        'index': {
            'defaultTermId': TERM_ID,
            'terms': [
                {
                    'id': TERM_ID,
                    'label': TERM_LABEL
                }
            ]
        },
        'catalogs': {
            TERM_ID: {
                'classNames': class_names,
                'maxWeek': MAX_WEEK,
                'termStartDate': TERM_START_DATE
            }
        },
        'queries': queries
    }

    print(f"[3/4] 写入服务端课表缓存：{SERVER_CACHE_PATH}...")
    os.makedirs(os.path.dirname(SERVER_CACHE_PATH), exist_ok=True)
    with open(SERVER_CACHE_PATH, 'w', encoding='utf-8') as sf:
        json.dump(server_data, sf, ensure_ascii=False, indent=2)
    server_cache_size = os.path.getsize(SERVER_CACHE_PATH) / (1024 * 1024)
    print(f"服务端缓存写入完成！文件大小：{server_cache_size:.2f} MB")

    # 构建并输出 miniprogram/utils/localScheduleData.js
    print(f"[4/4] 写入小程序端离线课表数据：{MINIPROGRAM_DATA_PATH}...")
    os.makedirs(os.path.dirname(MINIPROGRAM_DATA_PATH), exist_ok=True)
    
    js_content = f"""'use strict';

module.exports = {{
  termId: {json.dumps(TERM_ID, ensure_ascii=False)},
  termLabel: {json.dumps(TERM_LABEL, ensure_ascii=False)},
  termStartDate: {json.dumps(TERM_START_DATE, ensure_ascii=False)},
  maxWeek: {MAX_WEEK},
  classNames: {json.dumps(class_names, ensure_ascii=False)},
  pool: {json.dumps(pool, ensure_ascii=False)},
  schedules: {json.dumps(local_schedules, ensure_ascii=False)}
}};
"""
    with open(MINIPROGRAM_DATA_PATH, 'w', encoding='utf-8') as mf:
        mf.write(js_content)
    mp_data_size = os.path.getsize(MINIPROGRAM_DATA_PATH) / 1024
    print(f"小程序离线数据写入完成！文件大小：{mp_data_size:.1f} KB")

    print("\n" + "=" * 50)
    print(f"[OK] 课表重构构建成功！")
    print(f"[OK] 总班级数: {len(class_names)}")
    print(f"[OK] 总课程节次: {total_sessions_count}")
    print(f"[OK] 小程序离线文件: {mp_data_size:.1f} KB (极速离线加载)")
    print("=" * 50)

if __name__ == '__main__':
    build_all_schedules()
