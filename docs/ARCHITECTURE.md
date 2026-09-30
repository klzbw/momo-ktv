# momo-ktv 工作原理分析

> 本文件由代码梳理生成（2026-09-30），帮助新协作者快速理解系统全貌。若代码演进与本文件冲突，以代码为准并同步更新本文。

---

## 1. 系统总览

一套**家庭局域网 KTV 点歌系统**：手机/电视多端点歌，电视大屏播放，支持 MKV 多音轨原唱/伴唱切换、AI 人声分离（DUAL 双 FLAC）、逐字歌词、动态背景、网盘曲库串流。

```
┌─────────────┬─────────────┬──────────────┬──────────────┐
│ tvOS 客户端  │ Android TV  │ 电视浏览器/tv  │ 手机遥控/mobile │
│ (AVPlayer)  │ (WebView)   │ (MSE/HLS/直连) │  + mic 麦克风   │
└──────┬──────┴──────┬──────┴──────┬───────┴──────┬───────┘
       └─────────────┴───── WebSocket/HTTP API ──┴────────┘
                            │
              ┌─────────────▼──────────────┐
              │  server/ (Node.js+Express) │  ── SQLite ktv.db
              │  API / 队列 / HLS / 网盘     │  ── FFmpeg 转码
              └──────┬──────────┬─────────┘
                     │          │
        ┌────────────▼──┐   ┌───▼─────────────┐
        │ 网盘驱动       │   │ ai-worker (Python)│
        │ 115/阿里/夸克/  │   │ Demucs 分离       │
        │ 迅雷/百度/移动/  │   │ WhisperX 对齐     │
        │ AList         │   │ station.py 面板  │
        └───────────────┘   └─────────────────┘
```

## 2. 核心数据模型（server/db.js）

| 表 | 用途 | 关键字段 |
|----|------|----------|
| `songs` | 曲库主表 | media_type(video/audio/cue)、is_network、is_strm、source_root、cache_*、audio_needs_soft、video_needs_soft、sep_status、vocal_path/accomp_path、align_status、lyrics/lyrics_word、instrumental、cloud_account_id |
| `queue` | 已点队列 | is_top、top_order(多次置顶排序)、is_autoplay(随机播放标记)、status(waiting/playing/done) |
| `separation_jobs` | AI任务队列 | job_type(separate/align)、status、worker、attempts、next_attempt_at(失败指数退避)、UNIQUE(song_id,job_type) 幂等 |
| `song_artists` | 歌手关联表 | 拆分合唱歌手，支撑歌手列表精确检索 |
| `tv_users` | 电视大屏登录账号 | sha256 哈希，独立于管理后台 ADMIN_PASSWORD |
| `settings` | 键值配置 | 预设、缓存策略、曲库来源、session_secret |

## 3. 播放链路（web/tv 多模式）

前端按歌曲特征选择播放模式（`MODE`：UNKNOWN/TRACKS/STEREO/MONO/NATIVE/DUAL/DIRECT_MKV/MSE_MKV）：

1. **本地 MKV/MP4** → MSE 解封装 `/stream/:id` 字节直传（mkv-player.js，服务端不转码）
2. **mp2 音频/问题视频编码**（scanner 探测回填 `audio_needs_soft`/`video_needs_soft`）→ 强制软解走 HLS `/hls/:id/master.m3u8`（服务端 ffmpeg 转 aac/H.264，VAAPI 硬解失败自动回退 libx264）
3. **网盘/云端** → 302 直链（`/api/songs/:id/source` → `/api/cloud/115-direct/...` 或 strm 内容 URL）→ 播放器直连 CDN；失败回退内部网盘代理
4. **分离完成的纯音频** → **DUAL 双 FLAC**：vocal/accomp 两个 `<audio>` 元素 + Web Audio gain 实现 0..1 连续人声滑块（垂直调音条，遥控器上下键细调）

HLS 关键点：`hlsgen.js` 按需提取 MKV 指定音轨（浏览器 HTMLMediaElement.audioTracks 在目标内核不可用，必须服务端提取）；音画不同步用 `pendingPlay` 机制（ctx suspended 时不创建 source，用户手势 resume 后按 video.currentTime 重播）。

## 4. 曲库扫描与来源

- **本地**：scanner.js 扫描 MV_DIR 多根目录 → 探测音轨/编码/时长 → 写入 songs（先插占位拿 id 再探测，见 `audio_tracks` 幂等迁移）
- **CUE 整轨**：cueParser.js 拆分虚拟分轨（cue_path + start/end_offset），播放时按区间截取
- **网盘 KTV 源（netktv）**：netktv-scan.js 经 AList 列出网盘目录 → 本地生成 STRM 文本指针（`/data/netseparated-strm/{hash}_vocals.strm`，幂等按 filename 匹配入库）→ 播放/分离任务 302 直连或走内部代理
- **MKV 源（netktv-mkv）**：netktv-mkv-scan.js 直接以网盘虚拟路径入库
- **缓存**：sourceCache.js 按 size/mtime 校验网络源本地缓存，LRU + 后台清理（cacheCleaner.js）

## 5. AI 分离/对齐闭环

```
admin/自动入队 → separation_jobs(separate/align)
      → ai-worker claim (/api/separate/jobs/claim)
      → 下载源音频（requests 跟随 302；strm 文本指针二次解析）
      → sep_once.py (Demucs 分离 vocals/accomp FLAC)
      → align_once.py (WhisperX 逐字歌词，VAD 预检测纯音乐)
      → 回传 /complete（multer 上传产物 + 歌词）
      → 服务端写入 vocal_path/accomp_path、lyrics_word
```

要点：
- 模型常驻单例（Demucs/WhisperX），消除每首冷启动，align ~15s、separate 提速 3 倍
- 纯音乐识别：对齐前音量 <-45dB 跳过 + 对齐后拟声词判纯音乐（两层校验）
- 失败指数退避（next_attempt_at），硬崩溃任务由 reclaimStale 回收
- 分离产物按「源文件路径 SHA256 前 16 位」命名目录，跨库复用；上传 115 网盘分离目录（人声/伴奏/歌词同目录）

## 6. 歌词管线

- LDDC（server/lddc，内嵌 Python 服务，端口 8766）：网易/QQ/酷我/lrclib 多源抓取，eapi/qmc 解密，krc/yrc 转逐字 LRC
- 服务端 `/api/songs/:id/lyrics`（DB 空时 online=1 走 LDDC 补抓）、`/api/lyrics/batch-missing` 批量补抓、`/api/cloud-lyrics/*` 上传网盘（115 可写/移动云盘只读）
- 歌词覆盖率统计仅算音频（排除 MKV 自带字幕）

## 7. 部署与 CI/CD

- **Docker**：app/docker/Dockerfile COPY 根目录 `server/`、`web/`（唯一真源），再 COPY `app/docker/web/clients`（APK/IPA 安装包，web/.gitignore 按体积忽略故单独存放）
- **CI**：push 到 main → docker.yml 构建 GHCR 镜像（no-cache，保证镜像=当前源码）→ NAS webhook 回调或 watchtower 每 5 分钟轮询自动部署
- **fnOS 应用**：cmd/wizard/config + tools/build_fnos_fpk.py（fnpack 打包，只取 docker-compose.yaml，镜像内才含完整代码）
- **AI Worker**：ai-worker/ 可跑 Windows 本机（station.py 面板，GPU 监控、动态线程）或 Docker 镜像

## 8. 已知遗留问题（2026-09-30 快照）

| 项 | 状态 |
|----|------|
| AI Worker 下载 115 偶发 403（CDN 按来源 IP 分配节点） | 🟡 缓解：worker 3 次指数退避 + /source 302 回退内部网盘代理；根治方向：服务端代理下载或 Worker 带 Cookie |
| 网盘 uploadFile 未实现（115/阿里/百度/夸克/迅雷） | ⏳ 待开发（影响「分离产物回传网盘」外扩） |
| watchtower 官方镜像切换（GHCR 网络恢复后） | ⏳ 运维待办 |

*最后更新：2026-09-30*
