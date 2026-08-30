# 墨墨爱K歌（momo-ktv）

局域网 KTV 系统：手机扫码点歌 / 手机当无线麦克风，电视或投影仪全屏播放，支持原唱/伴唱切换、已点队列、收藏、分类点歌等。本仓库为个人独立维护的二次开发版本。

## 目录结构

```
app/docker/server   Node 服务端（点歌/队列/HLS 转码/手机麦克风中转）
app/docker/web      前端页面：tv（电视网页）、mobile（手机点歌）、mic（手机麦克风）、admin（曲库管理）
tvos-client         Apple TV 原生客户端（SwiftUI，工程名 MomoKtvTV）
cmd / wizard        飞牛 fnOS 应用套件生命周期脚本（可选，直接用 Docker 时不需要）
.github/workflows   CI：docker.yml 构建推送镜像；build-tvos.yml 构建 tvOS IPA
```

## 自有镜像（GitHub Container Registry）

每次向 `main` 推送 `app/docker/**` 改动，会自动构建并推送：

- `ghcr.io/klzbw/momo-ktv:latest`
- `ghcr.io/klzbw/momo-ktv:sha-短提交号`

## 飞牛 fnOS 上部署（推荐 docker compose）

在飞牛上准备目录 `app/docker/docker-compose.yml`（内容见仓库同名文件），核心如下：

```yaml
services:
  momo-ktv:
    image: ghcr.io/klzbw/momo-ktv:latest
    container_name: momo-ktv
    restart: unless-stopped
    ports:
      - "8083:8080"
    volumes:
      - /vol1/@appshare/momo-ktv/data:/data
      - /vol1/@appshare/momo-ktv/mv:/mv
    devices:
      - /dev/dri:/dev/dri     # 有核显/独显硬件转码才需要，无则删掉本段
```

然后：

```bash
docker compose pull
docker compose up -d
```

- 电视/投影网页端：`http://飞牛IP:8083/tv`
- 手机点歌：`http://飞牛IP:8083/m`
- 手机麦克风：经 HTTPS 反代域名访问 `/mic`（浏览器要求安全上下文才允许调用麦克风）
- 曲库管理：`http://飞牛IP:8083/admin`（首次设置管理员密码）
- MV 文件放进共享目录 `momo-ktv/mv`，会自动扫描入库。

> 镜像若为私有，需要先 `docker login ghcr.io -u klzbw`（用 GitHub 个人访问令牌）；将 package 设为 public 后可匿名拉取。

## 二次开发闭环

1. 修改代码并推送到 `main`；
2. `docker.yml` 自动出新镜像（改 `tvos-client/**` 时 `build-tvos.yml` 自动出新 IPA，在 Actions 产物下载）；
3. 飞牛上 `docker compose pull && docker compose up -d` 即更新到最新版。

## 技术说明

- 服务端：Node + Express + better-sqlite3 + ffmpeg（HLS 双音轨，原唱/伴唱切换不中断）。
- Apple TV 端：SwiftUI + AVPlayer（伴奏）与 AVAudioEngine（手机麦克风人声）实时混音。
- 手机麦克风链路：手机经 HTTPS 域名(wss) → 本服务 `/mic` → Apple TV 局域网(ws)，两端在同一服务进程会合。
