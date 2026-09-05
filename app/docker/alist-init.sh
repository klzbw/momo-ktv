#!/bin/bash
# Alist 初始化脚本：自动配置 115 网盘驱动
# 从 momo-ktv 的 cloud-drive.db 中读取 115 cookie，配置到 alist 中

set -e

ALIST_DATA_DIR="/opt/alist/data"
ALIST_CONFIG="/opt/alist/data/config.json"
ALIST_DB="/opt/alist/data/data.db"
MOMO_DB="/data/cloud-drive.db"
ALIST_URL="http://localhost:5235"

# 检查是否已初始化
if [ -f "$ALIST_DB" ]; then
    echo "[alist-init] alist 已初始化，跳过"
    exit 0
fi

echo "[alist-init] 开始初始化 alist..."

# 复制配置文件
cp /app/docker/alist-config.json "$ALIST_CONFIG"

# 启动 alist（后台）
cd /opt/alist
alist server --no-prefix --data "$ALIST_DATA_DIR" &
ALIST_PID=$!

# 等待 alist 启动
echo "[alist-init] 等待 alist 启动..."
for i in $(seq 1 30); do
    if curl -s "$ALIST_URL/api/public/settings" > /dev/null 2>&1; then
        echo "[alist-init] alist 已启动"
        break
    fi
    sleep 1
done

# 获取 admin 密码
ADMIN_PASSWORD=$(alist admin random --data "$ALIST_DATA_DIR" 2>&1 | grep -oP 'password: \K.*' || echo "")
if [ -z "$ADMIN_PASSWORD" ]; then
    echo "[alist-init] 无法获取 admin 密码，使用默认密码"
    ADMIN_PASSWORD="admin"
fi
echo "[alist-init] admin 密码: $ADMIN_PASSWORD"

# 登录获取 token
LOGIN_RESP=$(curl -s -X POST "$ALIST_URL/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}")
TOKEN=$(echo "$LOGIN_RESP" | grep -oP '"token":"\K[^"]+' || echo "")
if [ -z "$TOKEN" ]; then
    echo "[alist-init] 登录失败: $LOGIN_RESP"
    kill $ALIST_PID 2>/dev/null || true
    exit 1
fi
echo "[alist-init] 登录成功"

# 从 momo-ktv 数据库读取 115 cookie
if [ -f "$MOMO_DB" ]; then
    echo "[alist-init] 从 momo-ktv 数据库读取 115 cookie..."
    COOKIE=$(sqlite3 "$MOMO_DB" "SELECT access_token FROM cloud_accounts WHERE driver='pan115' LIMIT 1;" 2>/dev/null || echo "")
    if [ -n "$COOKIE" ]; then
        echo "[alist-init] 读取到 115 cookie"
        
        # 添加 115 网盘驱动
        echo "[alist-init] 添加 115 网盘驱动..."
        DRIVER_RESP=$(curl -s -X POST "$ALIST_URL/api/admin/driver/create" \
            -H "Authorization: $TOKEN" \
            -H "Content-Type: application/json" \
            -d '{
                "name": "115 Cloud",
                "driver": "115 Cloud",
                "additional": "{\"cookie\":\"'$COOKIE'\",\"root_folder_id\":\"0\",\"page_size\":1000}"
            }')
        echo "[alist-init] 驱动添加结果: $DRIVER_RESP"
        
        # 挂载 115 网盘到 /115
        echo "[alist-init] 挂载 115 网盘到 /115..."
        STORAGE_RESP=$(curl -s -X POST "$ALIST_URL/api/admin/storage/create" \
            -H "Authorization: $TOKEN" \
            -H "Content-Type: application/json" \
            -d '{
                "mount_path": "/115",
                "order": 0,
                "driver": "115 Cloud",
                "addition": "{\"cookie\":\"'$COOKIE'\",\"root_folder_id\":\"0\",\"page_size\":1000}",
                "remark": "115网盘",
                "modified": "2024-01-01T00:00:00Z",
                "enabled": true
            }')
        echo "[alist-init] 挂载结果: $STORAGE_RESP"
    else
        echo "[alist-init] 未找到 115 cookie，请手动配置 alist"
    fi
else
    echo "[alist-init] momo-ktv 数据库不存在，请手动配置 alist"
fi

# 停止 alist
kill $ALIST_PID 2>/dev/null || true
wait $ALIST_PID 2>/dev/null || true

echo "[alist-init] alist 初始化完成"
echo "[alist-init] 管理界面: http://localhost:5234"
echo "[alist-init] admin 密码: $ADMIN_PASSWORD"
