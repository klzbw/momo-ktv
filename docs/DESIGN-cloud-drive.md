# 网盘曲库集成设计方案

> 内置扫码添加 115 网盘 / 阿里云盘，指定文件夹自动串流播放，一次分离多设备共享。

---

## 1. 需求概述

### 1.1 核心目标
在 momo-ktv 管理后台中内置网盘管理功能，用户通过**扫码**即可添加 115 网盘和阿里云盘，选择网盘中的 KTV 文件夹作为曲库，momo-ktv 自动扫描入库，播放时通过网盘直链串流，不占用本地存储空间。

### 1.2 延伸目标
- **人声分离文件云同步**：本地 GPU/CPU 分离好的 vocals.flac / accompaniment.flac 上传到网盘，任意设备播放时自动下载缓存，实现"一次分离，到处使用"。
- **多网盘统一管理**：115、阿里云盘、WebDAV 等多种来源统一接口，可扩展。

### 1.3 用户体验流程
```
打开管理后台 → 网盘管理 → 添加网盘 → 选择115/阿里云盘
    ↓
显示二维码 → 手机扫码授权 → 网盘添加成功
    ↓
浏览网盘目录 → 选择KTV文件夹 → 设为曲库
    ↓
后台自动扫描 → 媒体文件入库 → 电视端点歌播放
    ↓
播放时通过直链串流 → 热门歌曲自动缓存本地
```

---

## 2. 整体架构

### 2.1 模块划分

```
momo-ktv 服务端
├── cloud-drive/                    # 网盘集成模块（新增）
│   ├── index.js                    # 模块入口，路由注册
│   ├── manager.js                  # 网盘账号管理（增删改查、token刷新）
│   ├── drivers/                    # 各网盘驱动
│   │   ├── base.js                 # 驱动基类（统一接口定义）
│   │   ├── pan115.js               # 115网盘驱动
│   │   ├── aliyun.js               # 阿里云盘驱动
│   │   └── webdav.js               # WebDAV通用驱动（后续扩展）
│   ├── scanner.js                  # 网盘文件夹扫描器
│   ├── streamer.js                 # 直链获取与串流代理
│   ├── cache.js                    # 本地缓存管理（LRU淘汰）
│   └── separation-sync.js          # 人声分离文件云同步
├── db.js                           # 数据库（新增网盘相关表）
├── scanner.js                      # 曲库扫描（扩展：支持网盘来源）
├── hlsgen.js                       # HLS转码（扩展：支持网盘直链输入）
└── sourceCache.js                  # 源缓存（扩展：支持网盘来源）
```

### 2.2 数据流向

```
扫码授权 → 保存token到数据库 → 定时刷新token
    ↓
选择文件夹 → 记录挂载路径 → 后台扫描任务
    ↓
扫描文件列表 → 生成歌曲记录（source_type=cloud） → 入库
    ↓
点歌播放 → 获取网盘直链 → ffmpeg转码HLS → 客户端播放
    ↓
热门歌曲 → 缓存到本地 /data/cloud-cache/ → 下次直接用本地
```

---

## 3. 数据库设计

### 3.1 新增表

#### cloud_accounts（网盘账号表）
```sql
CREATE TABLE IF NOT EXISTS cloud_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver TEXT NOT NULL,              -- 驱动类型: pan115 / aliyun / webdav
  name TEXT NOT NULL,                -- 用户自定义名称，如"我的115"
  access_token TEXT,                 -- 访问令牌
  refresh_token TEXT,                -- 刷新令牌
  token_expires_at DATETIME,         -- 令牌过期时间
  user_info TEXT,                    -- 用户信息JSON（昵称、头像、容量等）
  status TEXT DEFAULT 'active',      -- active / expired / error
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### cloud_libraries（网盘曲库表）
```sql
CREATE TABLE IF NOT EXISTS cloud_libraries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,       -- 关联 cloud_accounts.id
  mount_path TEXT NOT NULL,          -- 网盘内路径，如 /KTV/华语
  local_name TEXT NOT NULL,          -- 本地显示名称，如"115-华语KTV"
  scan_status TEXT DEFAULT 'idle',   -- idle / scanning / done / error
  last_scan_at DATETIME,             -- 上次扫描时间
  song_count INTEGER DEFAULT 0,      -- 扫描到的歌曲数
  enabled INTEGER DEFAULT 1,         -- 是否启用
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES cloud_accounts(id)
);
```

#### cloud_files（网盘文件缓存表）
```sql
CREATE TABLE IF NOT EXISTS cloud_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL,       -- 关联 cloud_libraries.id
  file_id TEXT NOT NULL,             -- 网盘文件ID（驱动相关）
  file_path TEXT NOT NULL,           -- 网盘内完整路径
  file_name TEXT NOT NULL,           -- 文件名
  file_size INTEGER,                 -- 文件大小（字节）
  file_hash TEXT,                     -- 文件哈希（用于缓存匹配）
  song_id INTEGER,                    -- 关联 songs.id（扫描后填充）
  cached_locally INTEGER DEFAULT 0,  -- 是否已缓存到本地
  local_cache_path TEXT,              -- 本地缓存路径
  last_played_at DATETIME,            -- 上次播放时间（LRU用）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(library_id, file_id),
  FOREIGN KEY (library_id) REFERENCES cloud_libraries(id)
);
```

### 3.2 songs 表扩展
```sql
-- 新增字段（ALTER TABLE 增量添加）
ALTER TABLE songs ADD COLUMN source_type TEXT DEFAULT 'local';  -- local / cloud / strm
ALTER TABLE songs ADD COLUMN cloud_file_id INTEGER;              -- 关联 cloud_files.id
```

---

## 4. 网盘驱动设计

### 4.1 驱动基类接口（base.js）

```javascript
class CloudDriveBase {
  // === 认证相关 ===
  async getQRCode() {}                // 获取登录二维码
  async checkQRStatus(qrId) {}        // 轮询扫码状态
  async refreshToken() {}              // 刷新access_token

  // === 文件操作 ===
  async listFiles(path) {}             // 列出目录下的文件
  async getFileInfo(fileId) {}         // 获取文件详情
  async getDownloadUrl(fileId) {}      // 获取下载直链（支持Range）

  // === 上传相关（人声分离同步用） ===
  async uploadFile(localPath, remotePath) {}  // 上传文件
  async mkdir(remotePath) {}           // 创建目录

  // === 工具 ===
  async getUserInfo() {}               // 获取用户信息（容量等）
  async testConnection() {}            // 测试连接是否正常
}
```

### 4.2 115 网盘驱动（pan115.js）

**认证方式**：扫码登录（115 网页端扫码接口）
- 获取二维码：`https://qrcodeapi.115.com/api/1.0/web/1.0/qrcode/getqrcode/`
- 轮询状态：`https://qrcodeapi.115.com/api/1.0/web/1.0/qrcode/getstatus/`
- 扫码成功后获取 cookie（UID + CID + SEID）

**文件操作**：
- 列目录：`https://webapi.115.com/files?aid=...&cid=...`
- 下载直链：`https://webapi.115.com/files/download?pickcode=...`
- 上传：`https://uplb.115.com/3.0/saveupload.php`（分片上传）

**注意事项**：
- 115 直链有效期较短（几小时），播放时需实时获取
- 有并发限制，建议单账号同时下载不超过 3 个
- cookie 可能过期，需要定期检测并提示重新扫码

### 4.3 阿里云盘驱动（aliyun.js）

**认证方式**：扫码 OAuth（阿里云盘开放平台）
- 授权地址：`https://open.aliyundrive.com/oauth/authorize`
- 获取 token：`https://open.aliyundrive.com/oauth/access_token`
- 刷新 token：`https://open.aliyundrive.com/oauth/refresh_token`

**文件操作**（OpenAPI）：
- 列目录：`POST /adrive/v1.0/openFile/list`
- 文件详情：`POST /adrive/v1.0/openFile/get`
- 下载直链：`POST /adrive/v1.0/openFile/getDownloadUrl`
- 上传：`PUT /adrive/v1.0/openFile/create` + 分片上传

**注意事项**：
- 阿里云盘 OpenAPI 有调用频率限制（QPS）
- 直链有效期 15 分钟，播放时实时获取
- 需要申请开放平台应用（client_id / client_secret）

---

## 5. 扫描与入库

### 5.1 扫描流程
```
用户选择网盘文件夹 → 创建 cloud_libraries 记录
    ↓
后台扫描任务（scanner.js）
    ↓
递归遍历网盘目录 → 过滤媒体文件（mkv/mp4/flac/mp3/...）
    ↓
写入 cloud_files 表
    ↓
解析文件名 → 提取标题/歌手 → 写入 songs 表（source_type=cloud）
    ↓
更新 cloud_libraries.song_count + scan_status=done
```

### 5.2 增量扫描
- 记录每次扫描的文件列表快照
- 下次扫描时对比，只处理新增/删除/修改的文件
- 避免重复扫描大文件夹

### 5.3 定时扫描
- 配置扫描间隔（默认每 6 小时）
- 也可手动触发"立即扫描"
- 扫描时不阻塞播放

---

## 6. 播放与串流

### 6.1 播放流程
```
tvOS端点歌 → 请求播放歌曲（source_type=cloud）
    ↓
检查本地缓存（cloud_files.cached_locally=1）
    ├─ 有本地缓存 → 直接用本地文件走现有 HLS 转码
    └─ 无本地缓存 → 调网盘驱动 getDownloadUrl() 获取直链
                    ↓
                    ffmpeg 直接读取 http 直链 → HLS 转码 → 播放
                    ↓
                    同时后台下载到本地缓存（如果歌曲被标记为"热门"）
```

### 6.2 直链代理
- 网盘直链可能有有效期、防盗链等限制
- momo-ktv 提供一个代理端点：`/api/cloud/stream/{file_id}`
- 代理自动刷新直链、处理 Range 请求、转发数据流
- 客户端/ffmpeg 只需要访问本地代理地址，不关心直链变化

### 6.3 本地缓存策略
- 缓存目录：`/data/cloud-cache/`
- 缓存大小限制：可配置（默认 20GB）
- LRU 淘汰：最久未播放的文件优先删除
- 缓存触发：播放次数超过阈值（默认 2 次）的歌曲自动缓存
- 手动缓存：管理后台可手动"缓存到本地"

---

## 7. 人声分离文件云同步

### 7.1 背景
- 本地 ai-worker 工作站通过 Demucs 分离人声/伴奏，生成 `vocals.flac` + `accompaniment.flac`
- 分离文件按源文件路径的 SHA256 前16位命名目录
- 目前只存在本地，其他设备无法使用

### 7.2 云同步方案
```
本地分离完成 → 上传到网盘 /momo-ktv/separated/<sha256key>/
    ├─ vocals.flac
    └─ accompaniment.flac
    ↓
任意设备播放歌曲 → 检查本地分离文件
    ├─ 有 → 直接用
    └─ 无 → 检查网盘 /momo-ktv/separated/<sha256key>/
            ├─ 有 → 下载到本地缓存 → 启用 DUAL 双轨播放
            └─ 无 → 走普通播放（可触发后台分离任务）
```

### 7.3 上传流程
- ai-worker 分离完成后，调 momo-ktv API 上传分离文件
- momo-ktv 接收后，通过网盘驱动上传到指定目录
- 上传完成后记录到数据库（separation_cloud 表）
- 支持断点续传、并发上传

### 7.4 下载缓存
- 播放时检测到网盘有分离文件，后台下载
- 下载到 `/data/separated/<sha256key>/`（与现有分离文件目录一致）
- 下载完成后自动切换到 DUAL 双轨播放
- 下载进度可在电视端显示

---

## 8. 管理后台界面

### 8.1 网盘管理页面
- 网盘账号列表（显示名称、类型、状态、已用容量）
- 添加网盘按钮 → 弹出选择驱动（115/阿里云盘）
- 扫码授权界面（显示二维码，轮询状态）
- 网盘详情（曲库列表、扫描状态、文件数）

### 8.2 曲库管理页面（扩展）
- 现有本地曲库列表
- 新增"网盘曲库"标签页
- 每个网盘曲库显示：名称、来源网盘、路径、歌曲数、上次扫描时间
- 操作：立即扫描、启用/禁用、删除

### 8.3 缓存管理页面
- 本地缓存使用情况（总大小、文件数）
- 缓存歌曲列表（可手动删除）
- 缓存策略配置（大小限制、缓存阈值）

---

## 9. API 设计

### 9.1 网盘账号管理
```
GET    /api/cloud/accounts              # 列出所有网盘账号
POST   /api/cloud/accounts              # 添加网盘账号（返回二维码）
GET    /api/cloud/accounts/:id/qrcode   # 获取扫码状态
DELETE /api/cloud/accounts/:id           # 删除网盘账号
POST   /api/cloud/accounts/:id/refresh   # 手动刷新token
```

### 9.2 网盘文件浏览
```
GET    /api/cloud/accounts/:id/browse?path=...   # 浏览网盘目录
```

### 9.3 网盘曲库管理
```
GET    /api/cloud/libraries              # 列出所有网盘曲库
POST   /api/cloud/libraries              # 添加网盘曲库（选择文件夹）
POST   /api/cloud/libraries/:id/scan     # 触发扫描
DELETE /api/cloud/libraries/:id           # 删除网盘曲库
```

### 9.4 串流代理
```
GET    /api/cloud/stream/:file_id        # 串流代理（支持Range）
```

### 9.5 分离文件同步
```
POST   /api/cloud/separation/upload      # 上传分离文件
GET    /api/cloud/separation/:song_id    # 查询分离文件状态
POST   /api/cloud/separation/:song_id/download  # 触发下载分离文件
```

---

## 10. 开发计划

### 阶段一：基础框架（1-2周）
- [ ] 数据库表设计与迁移
- [ ] 驱动基类与接口定义
- [ ] 115 网盘驱动（扫码登录 + 文件列表 + 直链获取）
- [ ] 管理后台网盘管理页面（账号列表 + 添加 + 扫码）
- [ ] 网盘文件浏览 API

### 阶段二：扫描与播放（1-2周）
- [ ] 网盘曲库管理（添加/删除/扫描）
- [ ] 网盘文件扫描器（递归遍历 + 媒体文件过滤 + 入库）
- [ ] 串流代理（直链刷新 + Range 转发）
- [ ] HLS 转码支持网盘直链输入
- [ ] 电视端播放验证

### 阶段三：缓存与优化（1周）
- [ ] 本地缓存管理（LRU 淘汰 + 大小限制）
- [ ] 热门歌曲自动缓存
- [ ] 增量扫描
- [ ] 定时扫描
- [ ] 性能优化（并发控制、预加载）

### 阶段四：人声分离云同步（1周）
- [ ] 分离文件上传 API
- [ ] ai-worker 集成上传
- [ ] 播放时自动检测网盘分离文件
- [ ] 后台下载缓存
- [ ] 下载进度显示

### 阶段五：阿里云盘 + 扩展（1周）
- [ ] 阿里云盘驱动（OAuth 扫码 + 文件操作）
- [ ] WebDAV 通用驱动（可选）
- [ ] 多网盘同时使用
- [ ] 文档与使用说明

---

## 11. 风险与注意事项

### 11.1 技术风险
| 风险 | 影响 | 应对 |
|------|------|------|
| 115 API 变化 | 扫码/直链失效 | 封装驱动层，变化只改驱动 |
| 网盘限速 | 播放卡顿 | 本地缓存 + 预加载 + 并发控制 |
| token 过期 | 无法访问 | 自动刷新 + 过期提醒 + 重新扫码 |
| 直链有效期短 | 播放中断 | 串流代理自动刷新 + ffmpeg 重试 |

### 11.2 法律合规
- 本功能仅用于用户访问自己的网盘内容
- 不提供盗版资源下载、不存储用户文件
- 用户需遵守网盘服务条款和版权法规

### 11.3 性能考虑
- 网盘扫描是 IO 密集型，放后台线程，不阻塞主服务
- 直链获取有网络延迟，做内存缓存（短期）
- ffmpeg 读取 http 流需要设置合理的超时和重试
- 多用户同时播放网盘歌曲时，注意带宽和并发限制

---

## 12. 后续扩展方向

- **更多网盘支持**：百度网盘、夸克网盘、123云盘、OneDrive、Google Drive
- **离线下载**：在管理后台添加磁力/电驴链接，离线到网盘后自动入库
- **网盘搜索**：跨网盘搜索歌曲
- **网盘同步**：本地曲库自动同步到网盘备份
- **分享功能**：生成网盘曲库分享链接，好友可直接添加
