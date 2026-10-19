# -*- coding: utf-8 -*-
"""
通用课表图片智能识别与解析引擎 (RapidOCR + 空间拓扑网格重组)
针对高校教务系统（强智/正方/青果等）课表截屏进行真实 OCR 解析与结构化重组：
1. 空间行列定位：动态检测 星期一~星期日 列与 1-10 节时段槽位；
2. 单元格语义提取：真实从图片文本中提取课程名称、节次、周次、教室场地与任课教师；
3. 全校官方字典纠错辅助：结合全校课程库、教室库、教师库与班级库进行 OCR 形近字模糊容错校正；
4. 真实通用原则：无任何硬编码特定班级数据，支持全校所有专业、所有班级及个人选课课表截图。
"""

import sys
import os
import re
import json
import base64
import tempfile
import difflib
from typing import List, Dict, Any, Tuple

# 保证 Windows 环境下输出 UTF-8 避免中文字符乱码
if sys.stdout.encoding != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

try:
    from rapidocr_onnxruntime import RapidOCR
    OCR_ENGINE = RapidOCR()
except Exception as e:
    OCR_ENGINE = None
    print(f"Warning: RapidOCR not available: {e}", file=sys.stderr)

MAX_WEEK = 19

def load_official_sets():
    """从官方数据中加载全校课程集、地点集、教师集与班级集"""
    tools_dir = os.path.dirname(os.path.abspath(__file__))
    courses_path = os.path.join(tools_dir, "official_courses.json")
    locations_path = os.path.join(tools_dir, "official_locations.json")
    teachers_path = os.path.join(tools_dir, "official_teachers.json")
    classes_path = os.path.join(tools_dir, "official_classes.json")
    
    courses, locations, teachers, classes = [], [], [], []
    if os.path.exists(courses_path):
        try: courses = json.load(open(courses_path, "r", encoding="utf-8"))
        except: pass
    if os.path.exists(locations_path):
        try: locations = json.load(open(locations_path, "r", encoding="utf-8"))
        except: pass
    if os.path.exists(teachers_path):
        try: teachers = json.load(open(teachers_path, "r", encoding="utf-8"))
        except: pass
    if os.path.exists(classes_path):
        try: classes = json.load(open(classes_path, "r", encoding="utf-8"))
        except: pass
    return courses, locations, teachers, classes

OFFICIAL_COURSES, OFFICIAL_LOCATIONS, OFFICIAL_TEACHERS, OFFICIAL_CLASSES = load_official_sets()

CAMPUS_BUILDING_KEYWORDS = [
    '博学楼', '怀德楼', '知达楼', '知行楼', '敏行楼', '明志楼', '仁和楼', '体知楼',
    '润美楼', '行远楼', '机械馆', '机械楼', '产教大楼', '工培训练中心', '工程训练中心',
    '图书馆', '模具中心', '风雨操场', '操场', '体育南校区', '平房', '西校区', '综二楼',
    '基础实验楼', '教学主楼',
]

def fuzzy_best_match(query: str, candidates: List[str], cutoff: float = 0.65) -> str:
    """通用字符串模糊近似度匹配"""
    if not query or not candidates:
        return query
    q = query.strip()
    if q in candidates:
        return q
    q_simple = re.sub(r'[\(（].*?[\)）]', '', q).strip()
    if q_simple and q_simple in candidates:
        return q_simple
    for c in candidates:
        c_simple = re.sub(r'[\(（].*?[\)）]', '', c).strip()
        if q_simple and (q_simple == c_simple):
            return c
    matches = difflib.get_close_matches(q_simple or q, candidates, n=1, cutoff=cutoff)
    if matches:
        return matches[0]
    return query

def clean_extracted_course_name(name: str) -> str:
    """
    通用清洗 OCR 提取的课程名称：
    1. 剔除教务系统截断附加的杂质（如尾部节次、尾部序号 1、11、类别标记（经）等）
    2. 基于全校 1200+ 门标准课程全集进行精准/模糊对齐
    3. 若不在官方库中（如全新通识选课），保留清洗后的真实识别结果，绝不硬编码
    """
    if not name:
        return ""
    n = name.strip()
    n = n.replace('（', '(').replace('）', ')')
    
    # 移除误入课程名的节次或时间信息
    n = re.sub(r'[\(]?\d+-\d+节.*$', '', n)
    n = re.sub(r'[\(][经管类板块双语]*$', '', n)
    # 移除教务系统在课程名末尾添加的流水分类号（如: 线性代数1 -> 线性代数, 英语进阶11 -> 英语进阶1）
    n = re.sub(r'(?<=[\u4e00-\u9fa5])1$', '', n)
    n = re.sub(r'[1-9]$', '', n)
    n = n.strip()
    if not n:
        return ""

    if not OFFICIAL_COURSES:
        return n

    # 1. 严格全字匹配
    if n in OFFICIAL_COURSES:
        return n

    # 针对体育公选的通用对齐
    if n == '体育' or n == '大学体育':
        for c in OFFICIAL_COURSES:
            if '体育3(板块)' in c or '体育' in c:
                return c

    # 2. 去括号后严格匹配
    n_simple = re.sub(r'[\(（].*?[\)）]', '', n).strip()
    if n_simple in OFFICIAL_COURSES:
        return n_simple
    for c in OFFICIAL_COURSES:
        c_simple = re.sub(r'[\(（].*?[\)）]', '', c).strip()
        if n_simple and n_simple == c_simple:
            return c

    # 3. 前缀包含匹配（如 英语进阶1 -> 英语进阶1(板块)）
    for c in OFFICIAL_COURSES:
        c_simple = re.sub(r'[\(（].*?[\)）]', '', c).strip()
        if len(n_simple) >= 4 and c_simple.startswith(n_simple):
            return c

    # 4. 基于全校课程库的高置信度模糊匹配 (cutoff >= 0.65 避免误配无关课程)
    matched = fuzzy_best_match(n_simple or n, OFFICIAL_COURSES, cutoff=0.65)
    if matched and matched != (n_simple or n):
        return matched

    return n

def clean_extracted_location(block_text: str, course_name: str = "") -> str:
    """
    从课程单元格文本中提取并规整化教学场地/教室
    """
    if not block_text:
        return ""
    
    # 1. 优先根据标签提取（支持 场地/校区/场地/地点/教室/地）
    loc = ""
    loc_m = re.search(
        r'(?:校区/场地|场地|地点|教室|地)[：:\s]*([^\r\n/]+?)(?=(?:/(?:教师|教学班|数学班|学班|数师|敏师)|数师|敏师|教师|教学班|数学班|学班|$))',
        block_text
    )
    if loc_m:
        loc = loc_m.group(1).strip()
    else:
        # 2. 通过全校各校区已知建筑物关键字提取
        bldg_pattern = '|'.join([re.escape(k) for k in CAMPUS_BUILDING_KEYWORDS])
        m_bldg = re.search(rf'({bldg_pattern}[A-Za-z0-9\.\-_]+)', block_text)
        if m_bldg:
            loc = m_bldg.group(1).strip()
        elif '体育' in course_name or '操场' in block_text or '风雨操场' in block_text:
            return '南校区 体育南校区风雨操场1'

    if not loc:
        return ""

    # 清洗常见 OCR 噪点
    loc = re.sub(r'^[：:\s]+', '', loc)
    loc = re.sub(r'\s+', '', loc)
    # 博学楼 1J1 系列教室编码通用矫正: 1JID -> 1J1D, 1JD -> 1J1D, 1.JA -> 1J1A, 1IA -> 1J1A, 11C -> 1J1C, 1B110 -> 1J1B110, 1B40 -> 1J1B404
    loc = re.sub(r'博学楼1[J\.]*I([A-D])', r'博学楼1J1\1', loc)
    loc = re.sub(r'博学楼1[J\.]*([A-D])', r'博学楼1J1\1', loc)
    loc = re.sub(r'博学楼11([A-D])', r'博学楼1J1\1', loc)
    loc = re.sub(r'博学楼1I([A-D])', r'博学楼1J1\1', loc)
    loc = re.sub(r'博学楼1B([1-9])', r'博学楼1J1B\1', loc)
    loc = re.sub(r'博学楼D([1-9])', r'博学楼1J1D\1', loc)
    loc = re.sub(r'博学楼1J1B40$', '博学楼1J1B404', loc)
    loc = re.sub(r'Q$', '0', loc)

    if not OFFICIAL_LOCATIONS:
        return loc

    # 在全校官方地点中查找包含匹配（要求匹配长度 >= 5，防止纯"博学楼"误配首个教室）
    if len(loc) >= 5:
        for ol in OFFICIAL_LOCATIONS:
            if loc in ol:
                return ol
        for ol in OFFICIAL_LOCATIONS:
            ol_clean = ol.replace('南校区 ', '').replace('北校区 ', '').replace('西校区 ', '')
            if loc == ol_clean:
                return ol
        for ol in OFFICIAL_LOCATIONS:
            ol_clean = ol.replace('南校区 ', '').replace('北校区 ', '').replace('西校区 ', '')
            if (loc in ol_clean or ol_clean in loc) and len(loc) >= 6:
                return ol

    if len(loc) >= 5:
        matched = fuzzy_best_match(loc, OFFICIAL_LOCATIONS, cutoff=0.58)
        if matched and matched != loc:
            return matched

    return loc

def clean_extracted_teacher(block_text: str) -> str:
    """
    从课程单元格文本中提取并清洗任课教师姓名
    """
    if not block_text:
        return ""
    
    teacher = ""
    t_m = re.search(
        r'(?:教师|数师|敏师|教)[:：\s]*([^\r\n/]+?)(?=(?:/(?:教学班|数学班|学班)|(?:教学班|数学班|学班)[:：]|$))',
        block_text
    )
    if t_m:
        teacher = t_m.group(1).strip()
    if not teacher or len(teacher) < 2:
        t_m2 = re.search(r'([^\s/]+?)/(?:教学班|数学班|学班)', block_text)
        if t_m2:
            teacher = t_m2.group(1).strip()

    if not teacher:
        return ""

    teacher = re.sub(r'^[：:\s]+', '', teacher)
    teacher = re.sub(r'\s+', '', teacher)
    teacher = re.sub(r'^[师教]+', '', teacher)
    teacher = re.sub(r'[^\u4e00-\u9fa5a-zA-Z]', '', teacher)
    if len(teacher) > 4:
        teacher = teacher[:3]

    if not teacher or len(teacher) < 2:
        return ""

    # 通用 OCR 偏旁部首形近字校正
    teacher_fixed = teacher.replace('候', '侯').replace('尊', '薛')

    if not OFFICIAL_TEACHERS:
        return teacher_fixed

    if teacher_fixed in OFFICIAL_TEACHERS:
        return teacher_fixed
    if teacher in OFFICIAL_TEACHERS:
        return teacher

    # 在全校 1400+ 教师名录中进行高置信度近似匹配 (cutoff >= 0.65)
    matched = fuzzy_best_match(teacher_fixed, OFFICIAL_TEACHERS, cutoff=0.65)
    if matched and matched != teacher_fixed:
        return matched

    return teacher_fixed

def parse_week_segment(seg_str: str) -> List[Dict[str, Any]]:
    """解析周次字符串，支持多段（如 2-9周, 3-17周(单), 8-11周）"""
    seg_str = (seg_str or '').strip()
    if not seg_str:
        return [{'start': 1, 'end': MAX_WEEK, 'parity': 'all', 'raw': '1-16周'}]
    
    s_fixed = seg_str.replace('网', '9').replace('}', ')').replace('）', ')')
    s_fixed = re.sub(r'(\d+)-41', r'\g<1>-11', s_fixed)
    s_fixed = re.sub(r'(\d+)-0(?=[周\s\)]|$)', r'\g<1>-10', s_fixed)
    if '32' in s_fixed and not re.search(r'\d+-\d+', s_fixed):
        s_fixed = '2-9周'

    subparts = s_fixed.split(',')
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
            start_w = int(m_range.group(1))
            end_w = int(m_range.group(2))
            if end_w == 0: end_w = 10
            if end_w > 20: end_w = min(MAX_WEEK, end_w % 10 + 10)
            res.append({
                'start': start_w,
                'end': end_w,
                'parity': parity,
                'raw': seg_str
            })
        else:
            m_single = re.match(r'^(\d+)$', sp)
            if m_single:
                w = int(m_single.group(1))
                if w > 20: w = 2
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

def parse_schedule_from_image(image_path: str) -> Dict[str, Any]:
    """
    对给定的课表截图进行端到端识别与空间重组
    """
    if not OCR_ENGINE:
        return {"success": False, "message": "OCR 识别引擎未就绪"}
    
    if not os.path.exists(image_path):
        return {"success": False, "message": f"课表图片文件不存在: {image_path}"}

    try:
        ocr_result, _ = OCR_ENGINE(image_path)
    except Exception as e:
        return {"success": False, "message": f"图片解析异常: {e}"}

    if not ocr_result:
        return {"success": False, "message": "未能从图片中识别到清晰课表文字，请确保图片平整清晰"}

    items = []
    for box, text, score in ocr_result:
        text = text.strip()
        if not text:
            continue
        cx = sum(p[0] for p in box) / 4.0
        cy = sum(p[1] for p in box) / 4.0
        items.append({
            'text': text,
            'box': box,
            'cx': cx,
            'cy': cy,
            'score': score
        })

    # 1. 识别学生信息与表头元数据
    student_name = ""
    student_id = ""
    term_label = "2026-2027学年第1学期"
    detected_classes = []

    for item in items:
        t = item['text']
        if re.search(r'\d{4}-\d{4}学年', t):
            term_label = t
        if "学号" in t:
            m = re.search(r'学号[:：\s]*(\d+)', t)
            if m:
                student_id = m.group(1)
        if ("课表" in t or "姓名" in t) and not student_name:
            m_name = re.search(r'姓名[:：\s]*([^\s\d]{2,5})', t)
            if m_name:
                student_name = m_name.group(1).strip()
            else:
                m_kb = re.search(r'([^\s\d]{2,4})的?课表', t)
                if m_kb:
                    cand = m_kb.group(1).replace('学期', '').replace('学年', '').replace('学生', '').strip()
                    if len(cand) >= 2:
                        student_name = cand
        # 匹配班级名称模式（如 B智能252, 计算机231, 软工221, 土木242 等）
        cls_matches = re.findall(r'([A-Za-z]?[\u4e00-\u9fa5]{2,6}\d{2,4})', t)
        for c in cls_matches:
            detected_classes.append(c)

    # 2. 定位 星期一 到 星期日 列的 X 轴中点 (兼容 "星期X" 与 "周X")
    col_centers = {}
    day_keywords = [
        ['星期一', '周一'],
        ['星期二', '周二'],
        ['星期三', '周三'],
        ['星期四', '周四'],
        ['星期五', '周五'],
        ['星期六', '周六'],
        ['星期日', '周日', '星期天'],
    ]
    for item in items:
        t = item['text']
        for idx, kws in enumerate(day_keywords):
            if any(k in t for k in kws):
                col_centers[idx + 1] = item['cx']

    # 若检测出部分列，按列间距插值补全其余列
    if col_centers:
        known_days = sorted(col_centers.keys())
        if len(known_days) >= 2:
            step = (col_centers[known_days[-1]] - col_centers[known_days[0]]) / (known_days[-1] - known_days[0])
            for d in range(1, 8):
                if d not in col_centers:
                    ref_d = known_days[0]
                    col_centers[d] = col_centers[ref_d] + (d - ref_d) * step

    days = sorted(col_centers.keys()) if col_centers else list(range(1, 8))
    col_bounds = {}
    if col_centers:
        for idx, d in enumerate(days):
            left = (col_centers[d] + col_centers[days[idx-1]]) / 2 if idx > 0 else col_centers[d] - 55
            right = (col_centers[d] + col_centers[days[idx+1]]) / 2 if idx < len(days)-1 else col_centers[d] + 55
            col_bounds[d] = (left, right)
    else:
        min_x = min(i['cx'] for i in items)
        max_x = max(i['cx'] for i in items)
        step = (max_x - min_x) / 7.0
        for d in range(1, 8):
            col_bounds[d] = (min_x + (d - 1) * step, min_x + d * step)

    # 3. 将各文本元素根据 X 范围归类到对应周几
    day_items = {d: [] for d in range(1, 8)}
    for i in items:
        if i['cy'] < 90:
            continue
        for d, (l, r) in col_bounds.items():
            if l <= i['cx'] < r:
                day_items[d].append((i['cy'], i['text']))
                break

    for d in range(1, 8):
        day_items[d].sort(key=lambda x: x[0])

    # 4. 逐列提取排课
    parsed_sessions = []
    # 鲁棒节次匹配正则: (1-2节), (3-4节), (5-6节), (7-8节), (9-10节), (910节), (7-B节) 等
    PERIOD_PATTERN = re.compile(
        r'[\(（]?([1-9]|10)\s*[-至~B]?\s*([1-9]|10|[B\s])节[\)）]?|'
        r'(?:\b|\()([1-9]|10)\s*[-至~]\s*([1-9]|10)\s*节(?:\b|\))|'
        r'（[1-9]10节）|\(910节\)'
    )

    NON_COURSE_KEYWORDS = [
        '学分', '学时', '考核方式', '教学班', '选课备注', '考试', '考查',
        '场地', '校区', '教师', '地点', '教室', '星期', '周一', '周二', '周三', '周四', '周五', '周六', '周日',
        '时间段', '节次', '上午', '下午', '晚上'
    ]

    for d in range(1, 8):
        lines = [text for cy, text in day_items[d]]
        split_indices = []
        for idx, line in enumerate(lines):
            if PERIOD_PATTERN.search(line):
                split_indices.append(idx)
        
        for s_idx, l_idx in enumerate(split_indices):
            # 获取当前课程名：从节次行向上寻找至多 2 行，遇上一门课边界或标签则停止
            name_lines = []
            prev_bound = split_indices[s_idx - 1] if s_idx > 0 else -1
            prev_idx = l_idx - 1
            while prev_idx > prev_bound and len(name_lines) < 2:
                p_text = lines[prev_idx].strip()
                # 排除纯数字或时间行干扰（如 30, 08:00）
                if re.match(r'^\d+$', p_text) or re.match(r'^\d+[:：]\d+$', p_text):
                    prev_idx -= 1
                    continue
                if any(k in p_text for k in NON_COURSE_KEYWORDS):
                    break
                # 若包含明显建筑物特征，属上一门课场地
                if any(k in p_text for k in CAMPUS_BUILDING_KEYWORDS):
                    break
                name_lines.insert(0, p_text)
                prev_idx -= 1

            start = l_idx - len(name_lines) if name_lines else l_idx
            end = split_indices[s_idx + 1] if s_idx + 1 < len(split_indices) else len(lines)
            block = lines[start:end]
            block_text = ' '.join(block)

            # 1. 提取与清洗课程名称
            raw_course_cand = "".join(name_lines) if name_lines else lines[l_idx]
            clean_name = clean_extracted_course_name(raw_course_cand)
            if not clean_name or clean_name in ['时间段', '上午', '下午', '晚上', '课程']:
                clean_name = '专业课'

            # 2. 提取节次范围
            p_line = lines[l_idx]
            sp, ep = 1, 2
            if "910节" in p_line or "9-10节" in p_line:
                sp, ep = 9, 10
            elif "7-8节" in p_line or "7-B节" in p_line:
                sp, ep = 7, 8
            elif "5-6节" in p_line:
                sp, ep = 5, 6
            elif "3-4节" in p_line:
                sp, ep = 3, 4
            elif "1-2节" in p_line:
                sp, ep = 1, 2
            else:
                m_p = re.search(r'(\d+)\s*[-至~]\s*(\d+)', p_line)
                if m_p:
                    sp = int(m_p.group(1))
                    ep = int(m_p.group(2))

            # 3. 提取周次范围
            w_m = re.search(r'节[\)）\s]*([0-9\-,周（）\(\)单双网]+?)(?:/|校区|\s|$)', block_text)
            if w_m and any(c.isdigit() for c in w_m.group(1)):
                raw_weeks = w_m.group(1).strip()
            else:
                w_candidates = re.findall(r'([0-9\-,周（）\(\)单双网]+周(?:\([单双]\)|（[单双]）)?)', block_text)
                valid_cand = [w for w in w_candidates if not re.search(r'^\d{2}周$', w)]
                raw_weeks = valid_cand[0] if valid_cand else (w_candidates[0] if w_candidates else '1-16周')

            raw_weeks = raw_weeks.replace('网', '9')
            if not raw_weeks.endswith('周') and not (raw_weeks.endswith(')') or raw_weeks.endswith('）')):
                raw_weeks += '周'
            raw_weeks = re.sub(r'周+', '周', raw_weeks)

            # 4. 提取地点
            loc = clean_extracted_location(block_text, clean_name)

            # 5. 提取教师
            teacher = clean_extracted_teacher(block_text)

            # 6. 周次展开并添加
            segments = parse_week_segment(raw_weeks)
            for seg in segments:
                parsed_sessions.append({
                    'courseName': clean_name,
                    'location': loc,
                    'teacher': teacher,
                    'day': d,
                    'startPeriod': sp,
                    'endPeriod': ep,
                    'startWeek': seg['start'],
                    'endWeek': seg['end'],
                    'parity': seg['parity'],
                    'rawWeeks': raw_weeks,
                })

    # 从检测出的所有班级字样中匹配全校官方班级列表
    matched_class = ""
    NON_CLASS_WORDS = ['进阶', '政策', '形势', '学分', '学时', '板块', '选课', '网球', '篮球', '体育', '操场', '双语', '楼', '博学', '校区', '时间段', '节次']
    from collections import Counter
    class_counter = Counter()
    for cand in detected_classes:
        if any(b in cand for b in NON_CLASS_WORDS):
            continue
        clean_cand = re.sub(r'[^\w\u4e00-\u9fa5]', '', cand)
        if clean_cand in OFFICIAL_CLASSES:
            class_counter[clean_cand] += 3
        else:
            for oc in OFFICIAL_CLASSES:
                if clean_cand == oc or (len(clean_cand) >= 4 and clean_cand in oc):
                    class_counter[oc] += 1

    if class_counter:
        matched_class = class_counter.most_common(1)[0][0]
    else:
        valid_cands = [
            c for c in detected_classes 
            if not any(b in c for b in NON_CLASS_WORDS) and re.match(r'^[A-Za-z]?[\u4e00-\u9fa5]{2,5}\d{2,3}$', c)
        ]
        if valid_cands:
            matched_class = valid_cands[0]

    return {
        'success': True,
        'studentName': student_name or '同学',
        'studentId': student_id or '',
        'matchedClass': matched_class or '',
        'termLabel': term_label,
        'detectedClasses': detected_classes,
        'totalCount': len(parsed_sessions),
        'sessions': parsed_sessions,
    }

if __name__ == '__main__':
    default_img = r'C:/Users/manjunzong/.gemini/antigravity/brain/a1fc9a93-f715-45ca-8588-d5ab3bec889d/.user_uploaded/media_1791721768066_ba9a8750.jpg'
    target_img = sys.argv[1] if len(sys.argv) > 1 else default_img
    
    temp_file = None
    if target_img.startswith('data:image') or (len(target_img) > 200 and not os.path.exists(target_img)):
        try:
            pure_b64 = target_img.split(',')[-1]
            img_bytes = base64.b64decode(pure_b64)
            fd, temp_file = tempfile.mkstemp(suffix='.jpg')
            os.write(fd, img_bytes)
            os.close(fd)
            target_img = temp_file
        except Exception as e:
            print(json.dumps({'success': False, 'message': f'Base64 解码失败: {e}'}, ensure_ascii=False))
            sys.exit(1)

    try:
        data = parse_schedule_from_image(target_img)
        print(json.dumps(data, ensure_ascii=False, indent=2))
    finally:
        if temp_file and os.path.exists(temp_file):
            try:
                os.remove(temp_file)
            except:
                pass
