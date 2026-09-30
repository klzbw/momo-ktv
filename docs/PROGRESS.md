# 开发进度

> 记录 momo-ktv 项目的开发进度，方便多账号协作时快速了解当前状态。

---

## 🎯 当前主线任务

### 网盘曲库集成（✅ 核心已完成，持续优化中）
- **状态**：核心链路已上线 —— 扫码登录、文件夹浏览、STRM 串流、302 直连、本地缓存均可用
- **已实现驱动**：115 / 阿里云盘 / 夸克 / 迅雷 / 百度 / 移动云盘(139) / AList
- **剩余优化**：各网盘上传接口（目前 115/阿里/百度/夸克/迅雷 的 uploadFile 未实现）、缓存 LRU 调优

### AI 分离/对齐链路稳定性（进行中）
- 分离任务与逐字歌词对齐已跑通；近期待办集中在网盘源下载的限流/404 兜底
- 已知问题见下表

---

## ✅ 已完成功能

### 核心功能
- [x] 多端点歌（Apple TV / Android TV / 电视浏览器 / 手机浏览器）
- [x] 手机遥控器（点歌、切歌、调音量、麦克风）
- [x] 海量格式支持（MKV/MP4/MP3/FLAC/WAV/APE/CUE）
- [x] 原唱/伴唱切换（MKV多音轨，服务端按需提取音轨）
- [x] 逐字歌词（唱到哪个字哪个字变色）
- [x] AI歌词自动生成（WhisperX）
- [x] 在线歌词补抓（LDDC：网易/QQ/酷我/lrclib）
- [x] 动态背景（14种水波纹/星空/极光等）
- [x] 氛围特效（掌声/干杯/喝彩/倒彩/祝福语）
- [x] 曲库管理（自动扫描、多目录、一键清洗、文件名解析工具）
- [x] 管理后台（曲库/用户/AI任务/背景/缓存/网盘配置）

### 播放器（网页 TV 端多模式）
- [x] MSE 解封装直放（mkv-player.js，本地 MKV/MP4 不转码）
- [x] 直连播放 /stream/:id 字节直传 + 302 网盘直链
- [x] HLS 转码回退（VAAPI 硬解 → libx264 软解）
- [x] MP2 音频软解码（Mp2AudioPlayer + mpg123，历史无声/爆音/雪花声已修复）
- [x] 硬解兼容探测（audio_needs_soft / video_needs_soft 自动回填，mp2/RV40 自动走软解）
- [x] DUAL 双 FLAC 播放 + 连续人声滑块（Web Audio 实时调音）

### AI 人声分离（DUAL 双轨）
- [x] Demucs 人声分离（ai-worker 工作站，GPU）
- [x] DUAL 双 FLAC 播放架构（vocal/accomp 同目录，SHA256 目录名跨库复用）
- [x] WhisperX 逐字歌词对齐（模型常驻单例，align 提速至 ~15s）
- [x] 纯音乐自动识别（instrumental 标记，分离/对齐前两层校验过滤）
- [x] 任务幂等入队（UNIQUE(song_id, job_type)，失败指数退避回收）
- [x] 分离产物上传（上传至 115 网盘分离目录，人声/伴奏/歌词同目录）
- [x] station.py 可视化控制面板（线程增减/GPU 监控/实时日志）

### 网盘曲库
- [x] 115/阿里/夸克/迅雷/百度/移动 扫码登录与挂载
- [x] STRM 文件扫描与幂等同步（按 filename 匹配，回填 cloud_account_id）
- [x] 302 直连 + 内部网盘代理兜底（本地 strm 缺失时自动回退）
- [x] 源文件本地缓存（sourceCache：大小/mtime 校验、LRU、清理策略）

### 服务端优化
- [x] 歌曲缓存预加载（queuePreload）
- [x] 已点队列缓存优化 + 随机播放标记（is_autoplay 显式列）
- [x] 缓存自动清理（cacheCleaner）
- [x] HLS 转码优化（VAAPI 硬解）
- [x] LDDC 逐字歌词服务（内嵌 Python 服务）
- [x] AI Worker 联动（分离/对齐任务 claim/progress/complete 闭环）

### 部署与运维
- [x] Docker 镜像自动构建（GitHub Actions → GHCR，no-cache 保证镜像=当前源码）
- [x] watchtower 自动更新 + NAS 部署 webhook 回调
- [x] tvOS IPA / Android APK / AI Worker 镜像自动构建
- [x] 飞牛 fnOS 应用套件（cmd/wizard/config + fpk 打包脚本）
- [x] 客户端下载页（/clients，安装包随镜像内置，2026-09-30 修复 404）

---

## 🚧 开发中 / 待开发

### 高优先级
- [ ] 网盘上传接口补齐（目前 115/阿里/百度/夸克/迅雷 uploadFile 未实现，影响「分离产物回传网盘」外扩场景）
- [ ] AI Worker 下载源偶发 403 的根治（115 CDN 按来源 IP 分配节点；现有重试+服务端 302 兜底已缓解，长期建议走服务端代理下载）

### 中优先级
- [ ] iOS 客户端完善（原生 App）
- [ ] 安卓手机客户端（原生 App）
- [ ] 评分系统（歌曲评分、推荐）
- [ ] 用户头像与个性化
- [ ] 历史记录与统计

### 低优先级 / 想法
- [ ] 社交功能（好友、分享歌单）
- [ ] 远程点歌（外网访问）
- [ ] 语音点歌
- [ ] 人脸识别（自动登录）
- [ ] 灯光联动（智能家居氛围灯）

---

## 🐛 已知问题

| 问题 | 状态 | 备注 |
|------|------|------|
| 客户端下载页 404 | ✅ 已修复(2026-09-30) | Dockerfile 补充 COPY app/docker/web/clients，镜像内 /clients 恢复可用 |
| app/docker 下过期 server/web 副本 | ✅ 已清理(2026-09-30) | 不参与构建的历史副本 63 个文件已删除，仅保留 Dockerfile/entrypoint/clients |
| AI Worker 下载源 115 偶发 403 | 🟡 缓解 | worker 已有 3 次指数退避重试 + 服务端 /source 302 回退内部代理；根治待定 |
| 网盘上传接口 | ⏳ 待开发 | 115/阿里/百度/夸克/迅雷 uploadFile 未实现 |

---

## 📝 协作说明

### 多账号协作流程
1. 从 GitHub 拉取最新代码：`git pull origin main`
2. 阅读本文档了解当前进度
3. 阅读 [DESIGN-cloud-drive.md](DESIGN-cloud-drive.md) 了解网盘集成方案
4. 开始开发，完成后提交 git
5. 更新本文档的进度状态
6. push 到 GitHub

### 提交规范
```
feat: 新功能
fix: 修复bug
docs: 文档更新
refactor: 重构
perf: 性能优化
chore: 清理/构建/杂项
```

### 关键文件位置
- 服务端：`server/`
- 网页端：`web/`
- Docker 构建上下文：`app/docker/`（Dockerfile COPY 根目录 server/web，clients 安装包也在镜像内）
- tvOS 客户端：`tvos-client/MomoKtvTV/`
- Android TV：`android-tv-client/`
- AI 工作站：`ai-worker/`（station.py 控制面板 + worker.py 任务线程）
- 设计文档：`docs/`
- 客户端下载页源码：`web/clients/index.html`（安装包实际存储：`app/docker/web/clients/`）

---

*最后更新：2026-09-30*
