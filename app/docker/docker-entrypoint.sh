#!/bin/bash
set -e

# 容器退出/停止时清理后台子进程（LDDC、alist），避免残留孤儿进程
cleanup() {
  echo "[entrypoint] Shutting down..."
  [ -n "$LDDC_PID" ] && kill $LDDC_PID 2>/dev/null
  [ -n "$ALIST_PID" ] && kill $ALIST_PID 2>/dev/null
}
trap cleanup EXIT TERM INT

# Alist 管理员密码（可通过环境变量覆盖）
export ALIST_ADMIN_PASSWORD="${ALIST_ADMIN_PASSWORD:-admin123}"

# 启动 Gbox 定制版 alist（网盘直连服务，支持 115 Cloud 驱动）
echo "[entrypoint] Starting Gbox alist on port ${ALIST_PORT:-5345}..."
cd /opt/alist
LD_LIBRARY_PATH=/opt/alist/lib /opt/alist/alist server --no-prefix --data ${ALIST_DATA_DIR:-/opt/alist/data} &
ALIST_PID=$!

# 等待 alist 启动（最多10秒，起来就继续，不阻塞node启动）
echo "[entrypoint] Waiting for alist to start..."
for i in $(seq 1 10); do
  if curl -s http://localhost:${ALIST_PORT:-5345}/api/public/settings > /dev/null 2>&1; then
    echo "[entrypoint] Alist is ready after ${i}s"
    break
  fi
  # 检查AList进程是否已退出
  if ! kill -0 $ALIST_PID 2>/dev/null; then
    echo "[entrypoint] Alist process exited, continuing without it"
    break
  fi
  sleep 1
done

# 设置 admin 密码（失败不阻塞）
echo "[entrypoint] Setting Alist admin password..."
cd /opt/alist
LD_LIBRARY_PATH=/opt/alist/lib /opt/alist/alist admin set "${ALIST_ADMIN_PASSWORD}" --data ${ALIST_DATA_DIR:-/opt/alist/data} 2>/dev/null || true
echo "[entrypoint] Alist admin password set"

# 启动 LDDC 逐字歌词搜索服务（后台）
# 两级歌词管线第一级：命中 LDDC 在线逐字歌词库则直接回写，免去 AI Worker 转写
if [ -f /app/server/lddc/lddc_server.py ]; then
  echo "[entrypoint] Starting LDDC lyrics service on port 8766..."
  python3 /app/server/lddc/lddc_server.py &
  LDDC_PID=$!
  # 等待最多5秒确保服务就绪（健康检查通过即继续，不阻塞 node 启动）
  for i in $(seq 1 5); do
    if curl -s http://127.0.0.1:8766/health > /dev/null 2>&1; then
      echo "[entrypoint] LDDC service ready after ${i}s"
      break
    fi
    sleep 1
  done
fi

# 启动 momo-ktv 服务端（主进程，容器生命周期绑定到此进程）
echo "[entrypoint] Starting momo-ktv server on port ${PORT:-8080}..."
cd /app
exec node server/index.js
