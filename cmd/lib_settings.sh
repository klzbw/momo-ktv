#!/bin/bash
# 共用函数：应用数据 / MV 曲库固定路径 + AI Worker 模式裁剪。
#
# 数据卷遵循飞牛 data-share 标准：config/resource 声明共享 momo-ktv、
# momo-ktv/data、momo-ktv/mv 后，飞牛会把它们绑定到应用沙箱内的
# /var/apps/<appname>/shares/<appname>/ 下，docker-compose.yaml 按此挂载。

# 应用数据 / MV 曲库统一固定的持久化存储根路径（飞牛 data-share 标准位置）。
default_app_share_root() {
    echo "/var/apps/${TRIM_APPNAME}/shares/${TRIM_APPNAME}"
}

default_mv_path() {
    echo "$(default_app_share_root)/mv"
}

default_data_path() {
    echo "$(default_app_share_root)/data"
}

# ==================== AI Worker 模式（本机 CPU / 本机 N卡 / 外置 PC）====================
# docker-compose.yaml 里默认放了两个带 profiles 的 AI 服务，`docker compose up`
# 不会启动。安装/升级时按向导选择，保留并启用其中一个、删掉另一个（外置 PC 两个都删）。
# 参数：$1=compose 文件路径  $2=模式 external|cpu|cuda
configure_ai_worker() {
    local cf="$1" mode="$2"
    [ -f "$cf" ] || return 0
    case "$mode" in
        cuda)
            sed -i '/# AI_CPU_BEGIN/,/# AI_CPU_END/d' "$cf"
            sed -i '/# AI_CUDA_BEGIN/d; /# AI_CUDA_END/d' "$cf"
            sed -i '/profiles: \["ai-cuda"\]/d' "$cf"
            ;;
        cpu)
            sed -i '/# AI_CUDA_BEGIN/,/# AI_CUDA_END/d' "$cf"
            sed -i '/# AI_CPU_BEGIN/d; /# AI_CPU_END/d' "$cf"
            sed -i '/profiles: \["ai-cpu"\]/d' "$cf"
            ;;
        *)
            sed -i '/# AI_CPU_BEGIN/,/# AI_CPU_END/d' "$cf"
            sed -i '/# AI_CUDA_BEGIN/,/# AI_CUDA_END/d' "$cf"
            ;;
    esac
}

# 把用户选择的 AI 模式持久化到数据目录，升级时沿用，不再追问。
ai_mode_conf() { echo "$(default_data_path)/ai_mode.conf"; }
save_ai_mode() { mkdir -p "$(default_data_path)" 2>/dev/null; echo "$1" > "$(ai_mode_conf)"; }
load_ai_mode() {
    if [ -f "$(ai_mode_conf)" ]; then cat "$(ai_mode_conf)"; else echo "external"; fi
}
