#!/bin/bash
# AI Worker 容器入口：自动探测算力、补齐默认参数后启动 worker.py
set -e

# 1) 算力探测：显式 MOMO_CAPABILITY 优先；否则能看到 N 卡设备/nvidia-smi 就判 gpu
if [ -z "$MOMO_CAPABILITY" ]; then
  if [ -e /dev/nvidia0 ] || (command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1); then
    export MOMO_CAPABILITY=gpu
  else
    export MOMO_CAPABILITY=cpu
  fi
fi

# 2) 必填：服务端地址
if [ -z "$MOMO_SERVER" ]; then
  echo "[entrypoint] 错误：未设置 MOMO_SERVER（形如 http://192.168.3.16:8083）" >&2
  exit 2
fi
: "${MOMO_WORKER:=fnos-ai}"
: "${MOMO_MODE:=both}"

# 3) GPU 容器却没看到显卡时给出明确提示（仍然继续，子进程会退回 CPU）
if [ "$MOMO_CAPABILITY" = "gpu" ]; then
  if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi -L || true; fi
fi

echo "[entrypoint] server=$MOMO_SERVER worker=$MOMO_WORKER mode=$MOMO_MODE capability=$MOMO_CAPABILITY"
exec python worker.py --server "$MOMO_SERVER" --worker "$MOMO_WORKER" --mode "$MOMO_MODE" --capability "$MOMO_CAPABILITY"
