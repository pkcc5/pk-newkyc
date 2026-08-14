# Dockerfile
# TRON 会员系统 Docker 镜像

FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm ci --only=production || npm install

# 复制所有源代码
COPY . .

# 创建数据目录（用于 Volume 挂载）
RUN mkdir -p /data

# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["node", "server.js"]
