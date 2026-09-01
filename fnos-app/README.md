# 墨墨爱K歌 - 飞牛NAS应用包

## 应用信息
- **应用名称**: 墨墨爱K歌
- **应用类型**: Docker 容器应用
- **服务端口**: 8083 (宿主机) → 8080 (容器)
- **镜像地址**: ghcr.io/klzbw/momo-ktv:latest
- **数据目录**: /vol1/@appshare/momo-ktv/
  - data/: 数据库、封面、配置
  - mv/: MV曲库文件

## 功能特性
- 🎤 KTV点歌系统，支持歌名/歌手/分类/热门/最近/收藏点歌
- 📱 手机扫码点歌、手机无线麦克风
- 🎵 AI逐字歌词生成，卡拉OK逐字高亮
- 🎬 MKV/MP4/MP3/FLAC等多种媒体格式支持
- 🎨 原唱/半消/伴奏多档切换
- 📺 Apple TV / 安卓TV / 网页端多端支持
- 🔊 AI人声分离，纯音频歌曲也能K歌
- 🌊 音频K歌随机动态背景

## 安装步骤

### 方法一：飞牛应用中心安装（推荐）
1. 打开飞牛NAS → 应用中心
2. 搜索"墨墨爱K歌"或添加第三方应用源
3. 点击安装，等待自动部署
4. 安装完成后访问 http://NAS_IP:8083

### 方法二：Docker Compose 手动安装
1. SSH 登录飞牛NAS
2. 创建数据目录：
   ```bash
   mkdir -p /vol1/@appshare/momo-ktv/data
   mkdir -p /vol1/@appshare/momo-ktv/mv
   ```
3. 上传 docker-compose.yml 到 NAS
4. 启动应用：
   ```bash
   docker compose up -d
   ```
5. 访问 http://NAS_IP:8083

## 配置说明

### 环境变量
| 变量 | 默认值 | 说明 |
|------|--------|------|
| TZ | Asia/Shanghai | 时区 |
| PORT | 8080 | 容器内服务端口 |
| DATA_DIR | /data | 数据目录 |
| MV_DIR | /mv | MV曲库目录 |
| VAAPI_DEVICE | /dev/dri/renderD128 | 硬件加速设备 |
| HLS_CACHE_MAX_AGE_DAYS | 3 | HLS缓存最大保留天数 |

### 端口映射
- 宿主机 8083 → 容器 8080

### 数据卷
- /vol1/@appshare/momo-ktv/data → /data (数据库/封面)
- /vol1/@appshare/momo-ktv/mv → /mv (MV曲库)

### 硬件加速
- 自动检测 /dev/dri 设备
- 支持 Intel/AMD VAAPI 硬件编解码
- 无核显机器自动回退软件编码

## 使用说明
1. 首次访问后，在设置中配置曲库路径
2. 扫描曲库，等待歌曲入库
3. 点歌开始演唱
4. 手机扫码可远程点歌和当麦克风

## 客户端下载
- Apple TV: App Store 搜索"墨墨爱K歌"或侧载IPA
- 安卓TV: 应用中心下载APK
- 网页端: http://NAS_IP:8083

## 技术支持
- GitHub: https://github.com/klzbw/momo-ktv
- 问题反馈: GitHub Issues
