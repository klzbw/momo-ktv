const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || '/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'ktv.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS songs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  artist TEXT,
  language TEXT,
  genre TEXT,
  filename TEXT UNIQUE NOT NULL,
  filepath TEXT NOT NULL,
  cover TEXT,
  duration INTEGER,
  pinyin TEXT,
  play_count INTEGER DEFAULT 0,
  audio_tracks INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id INTEGER NOT NULL,
  nickname TEXT DEFAULT '匿名歌手',
  is_top INTEGER DEFAULT 0,
  status TEXT DEFAULT 'waiting', -- waiting | playing | done
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (song_id) REFERENCES songs(id)
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id INTEGER NOT NULL,
  nickname TEXT,
  played_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(song_id, device_id)
);

-- 歌名统一规范为"歌手-歌曲名-语种-风格"，一首歌可能有多位歌手（文件名里
-- 用空格分隔，如"刀郎 张三-XXX-国语-流行.mkv"）。songs.artist 仍然保留
-- 完整的、空格分隔的原始歌手字符串，用于列表简单展示、标题/歌手模糊搜索；
-- 这张关联表把每位歌手拆成独立的一行，用来支撑"歌手列表"按单个歌手精确
-- 查找该歌手参与的所有歌曲（含合唱曲目），并让每位歌手在歌手列表里分别
-- 展示、分别计数，而不是被合唱的字符串整体绑在一起。每次歌曲的歌手字段
-- 变化（扫描新增、后台编辑）都要重新同步这张表，见 server/index.js 里的
-- syncSongArtists()。
CREATE TABLE IF NOT EXISTS song_artists (
  song_id INTEGER NOT NULL,
  artist TEXT NOT NULL,
  PRIMARY KEY (song_id, artist),
  FOREIGN KEY (song_id) REFERENCES songs(id)
);
CREATE INDEX IF NOT EXISTS idx_song_artists_artist ON song_artists(artist);

-- 简单的键值配置表。历史上曾经用它存过「曲库管理」的管理员密码哈希
-- (key = 'admin_password_hash')——那一版是首次打开管理后台时由用户自己
-- 设置、存进这张表。现在改为管理员密码在 docker-compose.yml 里用
-- ADMIN_PASSWORD 环境变量定义（见 server/index.js 顶部注释），这里不再
-- 写这个 key 了，但历史遗留的行留着不清理也无妨，不会被读取。
-- 现在这张表主要用来存：语种/风格预设、缓存清理策略、曲库来源配置，以及
-- 新增的 session_secret（见下方 tv_users 相关注释）等跟随 /data 持久化、
-- 不需要用户重新设置的运行期配置。
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- 需求(K歌主页面登录)：管理后台「用户管理」里新增的账号，专门用来登录
-- 电视/大屏「主页面」(/tv、/tv/clean.html)，跟上面 ADMIN_PASSWORD 定义的
-- 管理员账号是两回事——管理员账号管的是「管理后台」本身(改曲库、改设置)，
-- 这里的账号只用来控制"谁能打开K歌大屏"，两者互不影响、可以有多个。
-- password_hash 用 sha256(见 server/index.js sha256Hex)，不是明文存储；
-- 删除某个账号后，该账号已经签发出去的"记住登录"token 会在下次校验时
-- 因为查不到 username 而失效，不需要额外维护一张"已吊销 token"名单。
CREATE TABLE IF NOT EXISTS tv_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- AI 人声分离 / 逐字歌词对齐 的任务队列。分离与对齐都在独立的 GPU 机器
-- (worker，见 P3)上跑：服务端把待处理歌曲入队，worker 通过 /api/separate/
-- jobs/claim 领取、处理完再把产物(vocals.wav/accompaniment.wav、逐字歌词)
-- 回传。一首歌同一类型只保留一条任务(UNIQUE)，重复请求幂等，不会堆重复任务。
CREATE TABLE IF NOT EXISTS separation_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id INTEGER NOT NULL,
  job_type TEXT NOT NULL,              -- separate=人声分离, align=逐字歌词对齐
  status TEXT NOT NULL DEFAULT 'pending', -- pending|processing|done|failed
  worker TEXT,                         -- 领取该任务的 worker 标识
  progress INTEGER DEFAULT 0,          -- 0-100
  error TEXT,
  result_json TEXT,                    -- 完成时的产物元信息(JSON)
  attempts INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  claimed_at DATETIME,
  finished_at DATETIME,
  UNIQUE(song_id, job_type)
);
CREATE INDEX IF NOT EXISTS idx_sepjobs_pick ON separation_jobs(status, job_type, id);
`);

// Bug修复：老版本数据库里没有 audio_tracks 列，CREATE TABLE IF NOT EXISTS 对已存在的
// 表不会补列，这里做一次幂等迁移，升级安装时也能补上，不影响已有数据。
try {
  const cols = db.prepare("PRAGMA table_info(songs)").all().map(c => c.name);
  if (!cols.includes('audio_tracks')) {
    db.exec('ALTER TABLE songs ADD COLUMN audio_tracks INTEGER');
  }
  // 歌名规范化为"歌手-歌曲名-语种-风格"新增的两个字段，老库同样需要补列，
  // 具体的值由 scanner.js 里对老曲目的一次性回填逻辑负责填充（见那边注释），
  // 这里只负责建列，不在这里猜测/回填值。
  if (!cols.includes('language')) {
    db.exec('ALTER TABLE songs ADD COLUMN language TEXT');
  }
  if (!cols.includes('genre')) {
    db.exec('ALTER TABLE songs ADD COLUMN genre TEXT');
  }
  // 需求(本地mv多路径支持 + 网盘本地缓存)新增的几列：
  //   source_root   —— 这首歌是从 MV_DIR/MV_DIR_NET 配置的哪一个根目录扫到的
  //                     (存根目录本身的绝对路径)，多路径场景下用于诊断、以及
  //                     "某个根目录被移除后能不能安全批量清理对应曲目"这类
  //                     管理操作；单路径场景下永远是同一个值，不影响现有行为。
  //   is_network    —— 1 表示这首歌来自 MV_DIR_NET 配置的网络路径，播放/探测
  //                     前需要先走 sourceCache.js 缓存到本地；0 表示本地路径，
  //                     完全沿用原来"直接读 filepath"的逻辑，不受本次改动影响。
  //   cache_path / cache_status / cache_src_size / cache_src_mtime
  //                 —— sourceCache.js 用来记录本地缓存文件的位置、状态
  //                     ('none'|'pending'|'caching'|'ready'|'failed')，以及
  //                     缓存时源文件的大小/mtime(用于判断源文件是否被替换过、
  //                     缓存是否已经过期需要重新拷贝)。本地文件(is_network=0)
  //                     这几列始终是初始值，不会被用到。
  if (!cols.includes('source_root')) {
    db.exec('ALTER TABLE songs ADD COLUMN source_root TEXT');
  }
  if (!cols.includes('is_network')) {
    db.exec('ALTER TABLE songs ADD COLUMN is_network INTEGER DEFAULT 0');
  }
  if (!cols.includes('cache_path')) {
    db.exec('ALTER TABLE songs ADD COLUMN cache_path TEXT');
  }
  if (!cols.includes('cache_status')) {
    db.exec("ALTER TABLE songs ADD COLUMN cache_status TEXT DEFAULT 'none'");
  }
  if (!cols.includes('cache_src_size')) {
    db.exec('ALTER TABLE songs ADD COLUMN cache_src_size INTEGER');
  }
  if (!cols.includes('cache_src_mtime')) {
    db.exec('ALTER TABLE songs ADD COLUMN cache_src_mtime INTEGER');
  }
  // 需求(网盘STRM支持)：is_network 原本的语义是"filepath 本身就是可以直接
  // 读的网络路径"，而 .strm 文件的 filepath 是本地磁盘上的一个文本文件，
  // 要读出内容才能拿到真正的源地址——这决定了两者"扫描阶段该不该探测"的
  // 处理时机不同（is_network 现有逻辑扫描时就探测；is_strm 必须延后到点歌
  // 加入队列那一刻才第一次探测/下载，见 scanner.js/index.js 里的用法），
  // 所以单独开一列，不复用 is_network，避免把两种不同触发时机的来源混在
  // 一起判断。
  if (!cols.includes('is_strm')) {
    db.exec('ALTER TABLE songs ADD COLUMN is_strm INTEGER DEFAULT 0');
  }
  // 需求修复("硬解直连没声音，切音轨才报硬解失败自动切软解")：根因是源文件
  // 音频编码是 mp2(MPEG-1 Layer II)——这类老式卡拉OK压制的 MKV 很常见，但
  // Android 并不保证每台设备的 MediaCodec 都内置 mp2 软/硬解码器(不像 aac/
  // mp3 那样是 CDD 强制项)，导致硬解模式下画面能出、但音频渲染器初始化直接
  // 抛 DecoderInitializationException，且这个失败要等真正切音轨/开始播放
  // 时才会暴露，用户体验上是"莫名其妙没声音，一操作就自动切软解"。
  // audio_needs_soft = 1 表示"这首歌的音频编码已知在客户端硬解下大概率播不出
  // 声音，应该让客户端直接走软解(HLS，服务端已转码成 aac)，不要再尝试硬解直连
  // 然后等失败"。具体判定逻辑见 scanner.js 的 isProblemAudioCodec()，扫描/
  // 点歌探测阶段与 index.js 的 /stream 直连兜底探测都会回填这一列，覆盖新
  // 曲目和已入库的老曲目两种场景，不需要用户手动重新扫描曲库。
  if (!cols.includes('audio_needs_soft')) {
    db.exec('ALTER TABLE songs ADD COLUMN audio_needs_soft INTEGER DEFAULT 0');
  }
  // 需求修复("RV40硬解黑屏，声音正常")：跟 audio_needs_soft 完全对称的视频
  // 编码版本。RV40(RealVideo)是这类问题里最典型的一个——不同于 mp2 那种
  // "硬解模式下没声音"的失败模式，视频编码不支持在 Android 端表现得更隐蔽：
  // 部分设备/ROM 上能找到厂商塞的软件解码器组件，MediaCodec 层面"成功"初始化
  // 不抛任何异常，但根本没有把解出来的帧真正送上 Surface，客户端的
  // onPlayerError()永远不会触发，播放器自己也不知道出了问题。video_needs_soft
  // = 1 表示"这首歌的视频编码已知在客户端硬解下大概率黑屏，应该让客户端直接
  // 走软解(HLS，服务端已转码成标准H.264)，不要再尝试硬解直连"。具体判定逻辑
  // 见 scanner.js 的 isProblemVideoCodec()，扫描/点歌探测阶段与 index.js 的
  // /stream 直连、/api/decode-mode/report 上报兜底探测都会回填这一列，覆盖
  // 新曲目和已入库的老曲目两种场景，不需要用户手动重新扫描曲库。
  if (!cols.includes('video_needs_soft')) {
    db.exec('ALTER TABLE songs ADD COLUMN video_needs_soft INTEGER DEFAULT 0');
  }
  // 需求(一键清洗 - 手动忽略误命中)："一键清洗"是启发式识别(忽略词/语种/
  // 风格关键字)，难免会有管理员一眼就能看出来是误命中、但又不方便靠调整
  // 忽略词列表本身解决的个例(比如某首歌的歌名里恰好包含了某个忽略词，调整
  // 忽略词列表会影响其它歌曲)。clean_ignored = 1 表示管理员已经手动确认过
  // "这首歌不需要被一键清洗处理"，/api/admin/clean/preview 以后每次预览都
  // 会跳过这首歌(不管命中与否)，避免它反复出现在预览列表里干扰管理员批量
  // 确认；只影响清洗预览范围，不影响这首歌本身的播放/其它管理操作，也随时
  // 可以在"已忽略"列表里取消。
  if (!cols.includes('clean_ignored')) {
    db.exec('ALTER TABLE songs ADD COLUMN clean_ignored INTEGER DEFAULT 0');
  }
  // 同上，但用于"文件名解析"这个独立的整理工具——解析用的是固定模板拆字段，
  // 跟"一键清洗"的忽略词/语种/风格识别是完全不同的匹配逻辑，管理员在其中
  // 一个工具里确认"这首歌不需要处理"，不代表另一个工具也该跳过它，所以
  // 单独开一个字段，两边各管各的、互不影响。
  if (!cols.includes('parse_ignored')) {
    db.exec('ALTER TABLE songs ADD COLUMN parse_ignored INTEGER DEFAULT 0');
  }

  // ===== 音频K歌改造新增列（幂等迁移，老库自动补列，不影响已有数据）=====
  const addCol = (name, decl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE songs ADD COLUMN ${decl}`); };
  // media_type: video=带画面文件, audio=纯音频(mp3/flac/wav/ape...), cue=CUE整轨虚拟分轨
  addCol('media_type', "media_type TEXT");
  // 刮削出来的专辑/年份/音轨号
  addCol('album', "album TEXT");
  addCol('year', "year TEXT");
  addCol('track_no', "track_no INTEGER");
  // CUE 整轨：cue_path=整轨音频真实路径，cue_track=第几轨，start/end_offset=截取区间(秒)
  addCol('cue_path', "cue_path TEXT");
  addCol('cue_track', "cue_track INTEGER");
  addCol('start_offset', "start_offset REAL DEFAULT 0");
  addCol('end_offset', "end_offset REAL");
  // 歌词：lyrics=逐行LRC原文，lyrics_word=逐字增强LRC(P5)，lyrics_source=local/netease/kuwo/qq/ai
  addCol('lyrics', "lyrics TEXT");
  addCol('lyrics_word', "lyrics_word TEXT");
  addCol('lyrics_source', "lyrics_source TEXT");
  // AI 人声分离：sep_status=none/pending/done/failed，vocal/accomp_path 为分离产物路径；
  // align_status=逐字歌词对齐状态 none/pending/done/failed
  addCol('sep_status', "sep_status TEXT DEFAULT 'none'");
  addCol('vocal_path', "vocal_path TEXT");
  addCol('accomp_path', "accomp_path TEXT");
  addCol('align_status', "align_status TEXT DEFAULT 'none'");
} catch (e) { console.error('音轨/语种/风格字段迁移失败:', e.message); }

// Bug修复(置顶后再置顶另一首，原先置顶的歌会被打回原始排序位置)：老的
// is_top 只是一个 0/1 布尔标记，同一时刻只能记住"谁是当前唯一被置顶的
// 那首"——一旦有新的歌被置顶，旧的置顶标记会被清空，这首歌就完全失去了
// "曾经被置顶过"的信息，排序上只能退回按 id ASC(点歌顺序)，等于从第 2 位
// 直接弹回它最初排队时的位置(比如第 5 位)，而不是预期的"顺位顺延到第
// 3 位"。
// 改用 top_order(可为空的整数)记录"这首歌第几次被置顶操作选中"，值越大
// 表示置顶得越晚，排序时按 top_order DESC 排在一起——最近一次被置顶的排
// 最前(紧跟正在播放之后)，更早被置顶、但还没播放/取消的那些依次排在它
// 后面，而不是被挤回各自最初的点歌顺序；从没被置顶过的歌 top_order 为
// NULL，排在所有置顶过的歌之后，互相之间仍按 id ASC(点歌顺序)排列。
// 保留 is_top 列不删，避免破坏可能依赖它的旧数据/备份，服务端逻辑改为
// 完全以 top_order 为准。
try {
  const queueCols = db.prepare("PRAGMA table_info(queue)").all().map(c => c.name);
  if (!queueCols.includes('top_order')) {
    db.exec('ALTER TABLE queue ADD COLUMN top_order INTEGER');
  }
  // 需求(随机播放曲目不进已点队列/最近唱过，且点歌时直接切歌)：is_autoplay=1
  // 标记这一行是"已点队列播完后自动随机播放"插入的曲目(见 server/index.js
  // promoteNextWaitingOrAutoplay())，不是用户真正点的歌。之前只靠
  // nickname==='随机播放' 这个约定俗成的字符串来识别，万一真有用户把自己的
  // 昵称也改成"随机播放"就会被误判；单独开一列做显式、可靠的标记，跟
  // nickname 的实际取值完全脱钩。
  if (!queueCols.includes('is_autoplay')) {
    db.exec('ALTER TABLE queue ADD COLUMN is_autoplay INTEGER DEFAULT 0');
  }
} catch (e) { console.error('queue.top_order/is_autoplay 字段迁移失败:', e.message); }

// song_artists 关联表是本次新增的，老库里原有的曲目还没有对应的拆分记录。
// 这里做一次性回填：只要这张表还是空的、而 songs 里已经有数据，就按现有
// songs.artist 字符串（空格分隔）拆分出每一位歌手，写进 song_artists。
// 之后新增/编辑歌曲都会实时同步这张表（见 server/index.js 的
// syncSongArtists()），这里只处理"表刚建出来、还没有任何记录"这一次性场景，
// 不会覆盖后续已经同步过的数据。
try {
  const artistRowCount = db.prepare('SELECT COUNT(*) c FROM song_artists').get().c;
  const songRowCount = db.prepare('SELECT COUNT(*) c FROM songs').get().c;
  if (artistRowCount === 0 && songRowCount > 0) {
    const rows = db.prepare("SELECT id, artist FROM songs WHERE artist IS NOT NULL AND artist != ''").all();
    const insertArtist = db.prepare('INSERT OR IGNORE INTO song_artists (song_id, artist) VALUES (?, ?)');
    const backfill = db.transaction((allRows) => {
      for (const row of allRows) {
        const names = String(row.artist).split(/\s+/).map(s => s.trim()).filter(Boolean);
        for (const name of names) insertArtist.run(row.id, name);
      }
    });
    backfill(rows);
  }
} catch (e) { console.error('song_artists 关联表回填失败:', e.message); }

module.exports = db;
