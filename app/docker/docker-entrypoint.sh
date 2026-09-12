#!/bin/bash
set -e

# Alist 管理员密码（可通过环境变量覆盖）
export ALIST_ADMIN_PASSWORD="${ALIST_ADMIN_PASSWORD:-admin123}"

# 启动 Gbox 定制版 alist（网盘直连服务，支持 115 Cloud 驱动）
# 使用 musl libc，需要设置 LD_LIBRARY_PATH
echo "[entrypoint] Starting Gbox alist on port ${ALIST_PORT:-5234}..."
cd /opt/alist
LD_LIBRARY_PATH=/opt/alist/lib /opt/alist/alist server --no-prefix --data ${ALIST_DATA_DIR:-/opt/alist/data} &
ALIST_PID=$!

# 等待 alist 启动和存储加载（最多等待 30 秒）
echo "[entrypoint] Waiting for alist to start..."
for i in $(seq 1 30); do
  if curl -s http://localhost:${ALIST_PORT:-5234}/api/public/settings > /dev/null 2>&1; then
    echo "[entrypoint] Alist is ready after ${i}s"
    break
  fi
  sleep 1
done

# 设置固定的 admin 密码（避免随机初始密码导致 share-import 无法登录）
echo "[entrypoint] Setting Alist admin password..."
cd /opt/alist
LD_LIBRARY_PATH=/opt/alist/lib /opt/alist/alist admin set "${ALIST_ADMIN_PASSWORD}" --data ${ALIST_DATA_DIR:-/opt/alist/data} 2>/dev/null || true
echo "[entrypoint] Alist admin password set to: ${ALIST_ADMIN_PASSWORD}"

# 启动 momo-ktv 服务端（主进程，容器生命周期绑定到此进程）
echo "[entrypoint] Starting momo-ktv server on port ${PORT:-8080}..."
cd /app
exec node server/index.js
