#!/bin/bash
set -e

# 启动 Gbox 定制版 alist（网盘直连服务，支持 115 Cloud 驱动）
# 使用 musl libc，需要设置 LD_LIBRARY_PATH
echo "[entrypoint] Starting Gbox alist on port ${ALIST_PORT:-5234}..."
cd /opt/alist
LD_LIBRARY_PATH=/opt/alist/lib /opt/alist/alist server --no-prefix --data ${ALIST_DATA_DIR:-/opt/alist/data} &
ALIST_PID=$!

# 等待 alist 启动和存储加载
echo "[entrypoint] Waiting for alist to start..."
sleep 5

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
