# 微信云托管多运行时镜像（Node.js 18 + Python3 RapidOCR 智能识别引擎）
FROM node:18-bookworm-slim

WORKDIR /app

# 移除旧源，写入清华大学稳定源（Debian 12 Bookworm + Bookworm-Security）
RUN rm -f /etc/apt/sources.list.d/* && \
    echo "deb http://mirrors.tuna.tsinghua.edu.cn/debian/ bookworm main contrib non-free non-free-firmware" > /etc/apt/sources.list && \
    echo "deb http://mirrors.tuna.tsinghua.edu.cn/debian/ bookworm-updates main contrib non-free non-free-firmware" >> /etc/apt/sources.list && \
    echo "deb http://mirrors.tuna.tsinghua.edu.cn/debian-security bookworm-security main contrib non-free non-free-firmware" >> /etc/apt/sources.list

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    libgomp1 \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# 阿里云镜像极速安装 RapidOCR（Debian 12 需声明 --break-system-packages）
RUN pip3 install --no-cache-dir --break-system-packages \
    -i https://mirrors.aliyun.com/pypi/simple/ \
    --trusted-host mirrors.aliyun.com \
    rapidocr-onnxruntime

# 复制 Node.js 依赖并安装
COPY package*.json ./
RUN npm config set registry https://registry.npmmirror.com && \
    npm install --omit=dev --no-audit --no-fund

# 复制所有服务与工具源码
COPY . .

ENV PORT=80
ENV NODE_ENV=production
ENV NODE_TLS_REJECT_UNAUTHORIZED=0
ENV TZ=Asia/Shanghai
ENV TZ_OFFSET_MINUTES=480

EXPOSE 80

CMD ["node", "server.js"]
