#!/bin/bash
set -e

# 启动 alist（网盘直连服务）
echo "[entrypoint] Starting alist on port ${ALIST_PORT:-5234}..."
cd /opt/alist
alist server --no-prefix --data ${ALIST_DATA_DIR:-/opt/alist/data} &
ALIST_PID=$!

# 等待 alist 启动
sleep 3

# 启动 momo-ktv 服务端
echo "[entrypoint] Starting momo-ktv server on port ${PORT:-8080}..."
cd /app
node server/index.js &
MOMO_PID=$!

# 等待任意进程退出
wait -n $ALIST_PID $MOMO_PID
EXIT_CODE=$?

echo "[entrypoint] Process exited with code $EXIT_CODE, stopping..."
kill $ALIST_PID $MOMO_PID 2>/dev/null || true
wait $ALIST_PID $MOMO_PID 2>/dev/null || true

exit $EXIT_CODE
