#!/bin/bash
# 共用函数：目前只保留「应用数据 / MV 曲库固定路径」相关的小工具函数。
#
# 端口已取消自定义功能，固定使用 8083（写死在 docker-compose.yml 里，见
# app/docker/docker-compose.yml），生命周期脚本不需要再处理端口。
#
# 管理员密码也已不再经由安装/升级/配置向导收集：改成用户首次打开「曲库
# 管理」(/admin) 页面时自己设置，由容器内的 Node 服务保存在 /data 下的
# SQLite 数据库里（见 server/db.js 的 settings 表），生命周期脚本完全不
# 参与密码的设置或存储。
#
# 应用数据 / MV 曲库路径同样取消了自定义功能：统一固定使用应用默认共享
# 目录下的 data、mv 两个子目录，直接写死在 docker-compose.yml 中，不再
# 需要生命周期脚本用 sed 改写。这里只保留一个函数用于取得该固定路径，
# 供安装脚本预创建目录、卸载脚本按需清空 MV 曲库。

# 应用数据 / MV 曲库统一固定的持久化存储根路径。
default_app_share_root() {
    echo "/vol1/@appshare/${TRIM_APPNAME}"
}

# 固定的 MV 曲库路径，卸载向导选择清空曲库时使用。
default_mv_path() {
    echo "$(default_app_share_root)/mv"
}

# 固定的应用数据路径（数据库、封面等）。
default_data_path() {
    echo "$(default_app_share_root)/data"
}

# ==================== AI Worker 模式（本机 CPU / 本机 N卡 / 外置 PC）====================
# docker-compose.yml 里默认放了两个带 profiles 的 AI 服务（ai-worker-cpu、
# ai-worker-cuda），`docker compose up` 不会启动它们。安装/升级时按用户在向导
# 里的选择，用下面的函数保留并启用其中一个、删掉另一个（外置 PC 模式则两个都删）。
#
# 参数：$1=compose 文件路径  $2=模式 external|cpu|cuda
configure_ai_worker() {
    local cf="$1" mode="$2"
    [ -f "$cf" ] || return 0
    case "$mode" in
        cuda)
            # 本机 N 卡：删 CPU 段，去掉 CUDA 段的包裹注释与 profiles 行（启用）
            sed -i '/# AI_CPU_BEGIN/,/# AI_CPU_END/d' "$cf"
            sed -i '/# AI_CUDA_BEGIN/d; /# AI_CUDA_END/d' "$cf"
            sed -i '/profiles: \["ai-cuda"\]/d' "$cf"
            ;;
        cpu)
            # 本机 CPU：删 CUDA 段，启用 CPU 段
            sed -i '/# AI_CUDA_BEGIN/,/# AI_CUDA_END/d' "$cf"
            sed -i '/# AI_CPU_BEGIN/d; /# AI_CPU_END/d' "$cf"
            sed -i '/profiles: \["ai-cpu"\]/d' "$cf"
            ;;
        *)
            # 外置 PC（默认）：本机不跑 AI，两段都删除
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
