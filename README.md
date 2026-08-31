# 墨墨爱K歌（momo-ktv）

> 一套完整的家庭点歌系统，就像KTV包厢里的点歌机一样！手机点歌、电视播放、原唱伴唱切换、逐字歌词、AI自动生成歌词、动态背景，全都有。

---

## ✨ 功能特性

- 🎤 **多端点歌**：Apple TV、Android TV、电视浏览器、手机浏览器，全都能用
- 📱 **手机遥控**：手机当遥控器点歌、切歌、调音量，还能当麦克风唱歌
- 🎵 **海量格式**：支持MKV、MP4、MP3、FLAC、WAV、APE、CUE等各种格式
- 🎤 **原唱/伴唱**：MKV多音轨一键切换，不中断播放
- 📝 **逐字歌词**：唱到哪个字哪个字变色，就像KTV里一样
- 🤖 **AI歌词**：没有歌词的歌曲，AI自动生成精准的逐字歌词
- 🎨 **动态背景**：纯音频歌曲自动显示水波纹、星空、极光等14种动态背景
- 🌟 **氛围特效**：掌声、干杯、喝彩、倒彩，祝福语全屏滚动
- 💾 **曲库管理**：自动扫描新歌，支持多个曲库目录
- 🔧 **管理后台**：网页管理曲库、用户、AI任务、背景图片

---

## 🚀 5分钟快速上手

### 你需要准备

| 设备 | 说明 |
|------|------|
| 一台服务器 | 飞牛NAS / 普通电脑 / 树莓派（存放歌曲，运行服务端） |
| 一个播放设备 | Apple TV / Android TV / 智能电视浏览器 |
| 一个手机 | 当遥控器点歌（连同一个WiFi） |
| 一些歌曲 | MKV/MP4/MP3/FLAC等格式，放在服务器的文件夹里 |

### 第1步：安装服务端

#### 飞牛NAS（推荐）

1. 打开飞牛NAS「应用商店」
2. 搜索「墨墨爱K歌」
3. 点击安装，等待完成
4. 打开应用，按引导设置曲库目录

> 没有应用商店版本？用Docker手动部署，看《docs/03-服务端部署.md》

#### 普通电脑（Windows/Mac/Linux）

1. 安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)
2. 创建文件夹 `D:\momo-ktv\`
3. 在里面创建 `docker-compose.yml`：

```yaml
services:
  momo-ktv:
    image: ghcr.io/klzbw/momo-ktv:latest
    container_name: momo-ktv
    restart: unless-stopped
    ports:
      - "8083:8080"
    environment:
      - TZ=Asia/Shanghai
      - ADMIN_PASSWORD=admin888
    volumes:
      - D:\momo-ktv\data:/data
      - D:\momo-ktv\music:/mv/library1
```

4. 打开命令行，执行：
```bash
cd D:\momo-ktv
docker compose up -d
```

### 第2步：添加歌曲

1. 把你的歌曲文件放到曲库目录（飞牛NAS的共享文件夹，或电脑的 `D:\momo-ktv\music\`）
2. 打开管理后台：`http://服务器IP:8083/admin`
3. 登录（账号admin，密码admin888）
4. 进入「曲库管理」→「曲库来源」
5. 确认曲库目录已添加，点击「扫描」
6. 等待扫描完成（1000首约1-2分钟）

### 第3步：电视端点歌

#### 方式A：Apple TV（体验最佳）
1. 下载最新的 `MomoKtvTV.ipa`（在GitHub Actions产物里）
2. 用Apple Configurator 2或Sideloadly安装到Apple TV
3. 打开「墨墨爱K歌」，输入服务器地址（如 `192.168.3.16:8083`）
4. 登录后开始点歌！

#### 方式B：Android TV
1. 下载 `MomoKtvTV-Android.apk`
2. U盘拷到电视，点击安装
3. 打开应用，输入服务器地址
4. 登录后开始点歌！

#### 方式C：智能电视浏览器（零安装）
1. 打开电视浏览器
2. 访问 `http://服务器IP:8083/tv/`
3. 登录后开始点歌！

### 第4步：手机当遥控器

1. 手机连家里WiFi
2. 打开手机浏览器，访问 `http://服务器IP:8083/mobile/`
3. 登录后就是遥控器界面
4. 点歌、切歌、调音量、当麦克风唱歌！

> 💡 建议添加到手机主屏幕，下次直接点图标打开，像APP一样。

---

## 📚 学习文档（小白也能看懂）

| 文档 | 内容 | 适合谁 |
|------|------|--------|
| [01-从零开始.md](docs/01-从零开始.md) | 项目介绍、5分钟上手、常见问题 | 完全零基础 |
| [02-架构详解.md](docs/02-架构详解.md) | 每个模块怎么工作的，数据流向 | 想了解原理 |
| [03-服务端部署.md](docs/03-服务端部署.md) | 飞牛NAS/电脑/Docker部署，独立显卡 | 要部署服务端 |
| [04-AI工作站.md](docs/04-AI工作站.md) | AI歌词生成，一键安装，防闪退 | 要自动生成歌词 |
| [05-客户端使用.md](docs/05-客户端使用.md) | 各客户端安装使用，遥控器操作 | 要安装客户端 |

---

## 📁 项目结构

```
momo-ktv/
├── app/                          # 服务端 + 网页端
│   └── docker/
│       ├── server/               # Node.js 服务端（API、曲库、转码）
│       └── web/                  # 网页端
│           ├── tv/               # 电视端点歌界面
│           ├── mobile/           # 手机遥控端
│           ├── admin/            # 管理后台
│           └── mic/              # 手机麦克风端
├── tvos-client/                  # Apple TV 客户端（Swift/SwiftUI）
├── android-tv-client/            # Android TV 客户端（Kotlin + WebView）
├── ai-worker/                    # AI歌词精准化工作站（Python）
├── docs/                         # 学习文档（小白友好）
├── cmd/ + wizard/                # 飞牛fnOS应用套件脚本
└── .github/workflows/            # CI自动构建（Docker镜像 + tvOS IPA + Android APK）
```

---

## 🔄 更新到最新版本

### 服务端更新（飞牛NAS/电脑Docker）

```bash
cd /vol1/docker/momo-ktv    # 或你的docker-compose.yml所在目录
docker compose pull
docker compose up -d
```

### tvOS客户端更新
1. 下载最新IPA（GitHub Actions产物）
2. 用Apple Configurator 2重新安装（覆盖安装，设置保留）

### Android TV客户端更新
1. 下载最新APK
2. 覆盖安装即可

### 网页端更新
刷新页面即可，服务端更新后自动生效。

---

## ❓ 常见问题

### Q：我完全不懂技术，能搞定吗？
**A**：能！跟着《01-从零开始.md》一步步来，5分钟就能跑起来。遇到问题看各文档最后的「常见问题」章节，90%的问题都有答案。

### Q：没有NAS，用普通电脑能跑吗？
**A**：能！电脑安装Docker后，一条命令就能启动。看《03-服务端部署.md》的「电脑Docker部署」章节。

### Q：歌曲从哪里来？
**A**：你可以从网上下载MKV格式的KTV歌曲（带MV和字幕），也可以用普通的MP3/FLAC音频文件。纯音频歌曲会自动显示动态背景和AI生成的歌词。

### Q：AI歌词精准化是什么？需要吗？
**A**：AI歌词精准化是用人工智能为没有歌词的歌曲自动生成逐字同步歌词。如果你大部分歌曲是MKV格式（自带字幕），就不需要。如果有很多MP3/FLAC没有歌词，建议配置AI工作站。看《04-AI工作站.md》。

### Q：手机麦克风有延迟怎么办？
**A**：确保手机和服务器连同一个WiFi，用5GHz频段，离路由器近一些。延迟通常在100-300毫秒，唱歌时基本感觉不到。

### Q：原唱/伴唱切换不了？
**A**：只有MKV文件有多个音轨才能切换。MP4可能有，MP3/FLAC等纯音频只有一个音轨。用MediaInfo查看文件有几个音轨。

### Q：播放卡顿？
**A**：可能原因：网络带宽不够（用有线网络）、服务器性能太弱、歌曲码率太高。开启硬件转码（NVENC）可以大幅改善。看《03-服务端部署.md》的「独立显卡支持」章节。

---

## 🛠️ 技术栈

- **服务端**：Node.js + Express + better-sqlite3 + FFmpeg（HLS转码，双音轨切换）
- **tvOS客户端**：Swift + SwiftUI + AVPlayer + AVAudioEngine
- **Android TV客户端**：Kotlin + WebView
- **网页端**：纯HTML + CSS + JavaScript（无框架，轻量快速）
- **AI工作站**：Python + PyTorch + Demucs + WhisperX
- **数据库**：SQLite（文件型，零配置，备份方便）
- **部署**：Docker + docker-compose（一键部署，跨平台）

---

## 📝 说明

本项目为个人独立维护的二次开发版本，基于开源KTV项目进行了大量功能增强和优化。仅供学习和家庭使用，请勿用于商业用途。

---

## ⭐ 喜欢这个项目？

觉得好用的话，给个Star支持一下吧！有问题欢迎提Issue。
