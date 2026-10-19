# -*- coding: utf-8 -*-
"""
《大学计算机基础》核心精选题库
覆盖：计算机基础知识、硬件与微机系统、数据与编码、操作系统原理与Windows、
      办公自动化Office/WPS、计算机网络与Internet、信息安全与新技术
题型：单选题、多选题、判断题
"""

QUESTIONS = [
    # 第一章 计算机基础知识
    {
        "stem": "世界上第一台电子数字计算机诞生于（ ）。",
        "chapter": "第一章 计算机基础知识",
        "type": "choice",
        "options": ["1946年（ENIAC）", "1935年", "1952年", "1960年"],
        "answerIndex": 0,
        "extraNote": "1946年2月，在美国宾夕法尼亚大学诞生的ENIAC是世界上第一台通用电子数字计算机。"
    },
    {
        "stem": "现代电子计算机所采用的基本体系结构被称为（ ）。",
        "chapter": "第一章 计算机基础知识",
        "type": "choice",
        "options": ["冯·诺依曼结构", "图灵结构", "香农结构", "贝尔结构"],
        "answerIndex": 0,
        "extraNote": "冯·诺依曼结构确立了“程序存储、顺序执行”和五大部件组成的基本思想。"
    },
    {
        "stem": "冯·诺依曼计算机的五大硬件组成部件包括（ ）。",
        "chapter": "第一章 计算机基础知识",
        "type": "multi",
        "options": ["运算器", "控制器", "存储器", "输入设备", "输出设备"],
        "answerIndices": [0, 1, 2, 3, 4],
        "extraNote": "运算器、控制器、存储器、输入设备和输出设备构成计算机经典五大部件。"
    },
    {
        "stem": "微型计算机的核心部件是（ ）。",
        "chapter": "第一章 计算机基础知识",
        "type": "choice",
        "options": ["中央处理器（CPU）", "显示器", "内存条", "硬盘"],
        "answerIndex": 0,
        "extraNote": "CPU（中央处理器）包含运算器和控制器，是微机的核心大脑。"
    },
    {
        "stem": "计算机之所以能按照人们的意图自动连续工作，是因为采用了“存储程序”的工作原理。（ ）",
        "chapter": "第一章 计算机基础知识",
        "type": "judge",
        "answer": True,
        "extraNote": "将编写好的程序存入存储器中，由计算机自动逐条取出并执行，这是冯·诺依曼的核心思想。"
    },

    # 第二章 计算机硬件系统与微机系统
    {
        "stem": "下列属于内部存储器且断电后内容会丢失的是（ ）。",
        "chapter": "第二章 计算机硬件系统与微机系统",
        "type": "choice",
        "options": ["RAM（随机存取存储器）", "ROM（只读存储器）", "固态硬盘（SSD）", "U盘"],
        "answerIndex": 0,
        "extraNote": "RAM是易失性存储器，断电后所存储的数据全部丢失。"
    },
    {
        "stem": "ROM中的信息只能读出不能写入，断电后信息不会丢失。（ ）",
        "chapter": "第二章 计算机硬件系统与微机系统",
        "type": "judge",
        "answer": True,
        "extraNote": "ROM（Read Only Memory）用于存放计算机基本输入输出系统BIOS等关键引导程序。"
    },
    {
        "stem": "下列存储部件中，数据访问速度最快的是（ ）。",
        "chapter": "第二章 计算机硬件系统与微机系统",
        "type": "choice",
        "options": ["CPU内部寄存器（Register）", "高速缓存（Cache）", "内存（RAM）", "固态硬盘（SSD）"],
        "answerIndex": 0,
        "extraNote": "存储金字塔中：寄存器 > 高速缓存(Cache) > 内存 > 外存。"
    },
    {
        "stem": "微型计算机总线通常按功能分为（ ）。",
        "chapter": "第二章 计算机硬件系统与微机系统",
        "type": "multi",
        "options": ["数据总线（Data Bus）", "地址总线（Address Bus）", "控制总线（Control Bus）", "通信总线"],
        "answerIndices": [0, 1, 2],
        "extraNote": "系统总线主要由数据总线、地址总线和控制总线三部分组成。"
    },
    {
        "stem": "下列设备中既属于输入设备又属于输出设备的是（ ）。",
        "chapter": "第二章 计算机硬件系统与微机系统",
        "type": "choice",
        "options": ["触摸屏", "键盘", "扫描仪", "激光打印机"],
        "answerIndex": 0,
        "extraNote": "触摸屏既可以显示画面（输出），又可以接受手指触控输入（输入）。"
    },

    # 第三章 数据与编码
    {
        "stem": "计算机内部存储和处理一切信息均采用（ ）。",
        "chapter": "第三章 数据与编码",
        "type": "choice",
        "options": ["二进制", "十进制", "八进制", "十六进制"],
        "answerIndex": 0,
        "extraNote": "由于数字电路具有高低电平两个稳定状态，计算机底层全部采用二进制。"
    },
    {
        "stem": "计算机中最小的信息单位是（ ）。",
        "chapter": "第三章 数据与编码",
        "type": "choice",
        "options": ["位（bit）", "字节（Byte）", "字（Word）", "千字节（KB）"],
        "answerIndex": 0,
        "extraNote": "位（bit，或比特）是最小的度量单位，1 Byte = 8 bits。"
    },
    {
        "stem": "标准ASCII码使用（ ）位二进制数对字符进行编码。",
        "chapter": "第三章 数据与编码",
        "type": "choice",
        "options": ["7位", "8位", "16位", "32位"],
        "answerIndex": 0,
        "extraNote": "标准ASCII码用7位二进制数表示128个字符，最高位通常置0。"
    },
    {
        "stem": "十进制数25转换为二进制数是（ ）。",
        "chapter": "第三章 数据与编码",
        "type": "choice",
        "options": ["11001", "11010", "10101", "11100"],
        "answerIndex": 0,
        "extraNote": "25 = 16 + 8 + 1 = 11001(B)。"
    },
    {
        "stem": "1GB等于（ ）字节。",
        "chapter": "第三章 数据与编码",
        "type": "choice",
        "options": ["1024 MB", "1000 KB", "1024 KB", "10^9 字节"],
        "answerIndex": 0,
        "extraNote": "1GB = 1024MB = 1024 * 1024 KB = 2^30 Byte。"
    },

    # 第四章 操作系统原理与Windows
    {
        "stem": "操作系统的主要功能包括（ ）。",
        "chapter": "第四章 操作系统原理与Windows",
        "type": "multi",
        "options": [
            "处理器管理（进程管理）",
            "存储器管理",
            "设备管理",
            "文件管理",
            "用户接口管理"
        ],
        "answerIndices": [0, 1, 2, 3, 4],
        "extraNote": "操作系统是系统软件的核心，负责调度和管理计算机的硬件与软件资源。"
    },
    {
        "stem": "在Windows中，下列属于非法文件名的是（ ）。",
        "chapter": "第四章 操作系统原理与Windows",
        "type": "choice",
        "options": ["work?report.docx", "my_doc.txt", "123_abc.xlsx", "study-guide.pdf"],
        "answerIndex": 0,
        "extraNote": "Windows文件名中禁止包含 ? * / \\ < > : \" | 这9个特殊字符。"
    },
    {
        "stem": "Windows快捷键中，用于彻底删除文件不放入回收站的是（ ）。",
        "chapter": "第四章 操作系统原理与Windows",
        "type": "choice",
        "options": ["Shift + Delete", "Ctrl + Delete", "Alt + Delete", "Delete"],
        "answerIndex": 0,
        "extraNote": "按Shift + Delete可永久彻底删除选中的文件或文件夹。"
    },
    {
        "stem": "剪贴板是内存中的一块临时存储区域，关机或重启后其中的内容会丢失。（ ）",
        "chapter": "第四章 操作系统原理与Windows",
        "type": "judge",
        "answer": True,
        "extraNote": "剪贴板保存在RAM中，断电后数据消失。"
    },

    # 第五章 办公自动化Office/WPS
    {
        "stem": "在Word中，要撤销上一步操作，常用的快捷键是（ ）。",
        "chapter": "第五章 办公自动化Office/WPS",
        "type": "choice",
        "options": ["Ctrl + Z", "Ctrl + Y", "Ctrl + C", "Ctrl + V"],
        "answerIndex": 0,
        "extraNote": "Ctrl + Z是通用的撤销操作快捷键，Ctrl + Y是恢复重做。"
    },
    {
        "stem": "在Excel中，公式必须以（ ）符号开头。",
        "chapter": "第五章 办公自动化Office/WPS",
        "type": "choice",
        "options": ["=", "+", "@", "#"],
        "answerIndex": 0,
        "extraNote": "Excel所有计算公式和函数调用均必须以等号“=”作为起始标志。"
    },
    {
        "stem": "在Excel中，表示绝对引用的符号是（ ）。",
        "chapter": "第五章 办公自动化Office/WPS",
        "type": "choice",
        "options": ["$", "&", "#", "%"],
        "answerIndex": 0,
        "extraNote": "单元格地址加 $ 符号（如 $A$1）表示锁定行列的绝对引用。"
    },
    {
        "stem": "在PowerPoint中，若想从头全屏放映幻灯片，快捷键是（ ）。",
        "chapter": "第五章 办公自动化Office/WPS",
        "type": "choice",
        "options": ["F5", "Shift + F5", "Ctrl + F5", "Alt + F5"],
        "answerIndex": 0,
        "extraNote": "F5键从第一张幻灯片开始放映，Shift + F5从当前幻灯片开始放映。"
    },

    # 第六章 计算机网络与Internet
    {
        "stem": "因特网（Internet）采用的核心通信协议是（ ）。",
        "chapter": "第六章 计算机网络与Internet",
        "type": "choice",
        "options": ["TCP/IP协议", "HTTP协议", "FTP协议", "IPX/SPX协议"],
        "answerIndex": 0,
        "extraNote": "TCP/IP（传输控制协议/网际协议）是因特网的技术基石。"
    },
    {
        "stem": "目前广泛使用的IPv4地址由（ ）位二进制数组成。",
        "chapter": "第六章 计算机网络与Internet",
        "type": "choice",
        "options": ["32位", "16位", "64位", "128位"],
        "answerIndex": 0,
        "extraNote": "IPv4地址由32位二进制数组成，通常分为4组用点分十进制表示；IPv6为128位。"
    },
    {
        "stem": "DNS（域名系统）的主要功能是（ ）。",
        "chapter": "第六章 计算机网络与Internet",
        "type": "choice",
        "options": [
            "将域名解析为对应的IP地址",
            "提高网页浏览速度",
            "加密网络传输数据",
            "分配动态IP地址"
        ],
        "answerIndex": 0,
        "extraNote": "DNS服务器负责把易记的主机域名（如www.ycit.edu.cn）转换为网络定位所用的IP地址。"
    },
    {
        "stem": "URL统一资源定位符中，http://表示（ ）。",
        "chapter": "第六章 计算机网络与Internet",
        "type": "choice",
        "options": ["超文本传输协议", "文件传输协议", "简单邮件传输协议", "网络时间协议"],
        "answerIndex": 0,
        "extraNote": "HTTP（HyperText Transfer Protocol）即超文本传输协议。"
    },
    {
        "stem": "计算机网络最核心的两个功能是资源共享和数据通信。（ ）",
        "chapter": "第六章 计算机网络与Internet",
        "type": "judge",
        "answer": True,
        "extraNote": "网络互连旨在实现数据的高速交换传输与软件、硬件、数据资源的共享。"
    },

    # 第七章 信息安全与新技术
    {
        "stem": "计算机病毒实质上是（ ）。",
        "chapter": "第七章 信息安全与新技术",
        "type": "choice",
        "options": [
            "一种人为编制的具有破坏性的计算机程序代码",
            "受生物病毒感染的电子芯片",
            "由硬件损坏引起的机械故障",
            "一种自然产生的电磁干扰"
        ],
        "answerIndex": 0,
        "extraNote": "计算机病毒是一段人为编制的、具有传染性、潜伏性和破坏性的计算机指令或代码。"
    },
    {
        "stem": "防火墙主要用于防范未经授权的网络外部非法入侵，不能防范内部人员违规泄密。（ ）",
        "chapter": "第七章 信息安全与新技术",
        "type": "judge",
        "answer": True,
        "extraNote": "防火墙是网络边界安全屏障，对于内部网络的破坏和U盘离线感染防范能力有限。"
    },
    {
        "stem": "大数据的主要特征通常被概括为“4V”，包括（ ）。",
        "chapter": "第七章 信息安全与新技术",
        "type": "multi",
        "options": [
            "大量（Volume）",
            "多样（Variety）",
            "高速（Velocity）",
            "价值（Value）"
        ],
        "answerIndices": [0, 1, 2, 3],
        "extraNote": "大数据的4V特征：数据体量大(Volume)、种类多(Variety)、处理速度快(Velocity)、价值密度低(Value)。"
    }
]
