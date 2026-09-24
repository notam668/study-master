# 微信云托管官方推荐的标准 Node 基础镜像
FROM node:18-alpine

WORKDIR /app

# 复制依赖定义
COPY package*.json ./

# 配置国内 npm 镜像源加速安装
RUN npm config set registry https://registry.npmmirror.com && \
    npm install --omit=dev --no-audit --no-fund

# 复制服务源码
COPY . .

# 生产环境配置
ENV PORT=80
ENV NODE_ENV=production
ENV NODE_TLS_REJECT_UNAUTHORIZED=0
# 上课提醒按北京时间算「今天第几节课」。容器默认 UTC，这里显式指定；
# 即便这里失效，服务端代码也会按 TZ_OFFSET_MINUTES=480 自行换算，不依赖容器时区。
ENV TZ=Asia/Shanghai
ENV TZ_OFFSET_MINUTES=480

EXPOSE 80

# 启动服务
CMD ["node", "server.js"]
