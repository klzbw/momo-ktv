// enqueue-batch.js —— 批量把本地待分离歌曲入队（分离 + 逐字对齐）
//
// 用途：扫描所有"本地纯音频/整轨(CUE)、尚未分离"的歌曲，调用 separate.js 的 enqueue()
//       入队 separate+align 任务，由 GPU worker(pc-51) 依次领取处理。
//
// 运行方式（在 NAS 容器内）：
//   docker exec momo-ktv node /app/server/enqueue-batch.js            # 全量入队
//   docker exec momo-ktv node /app/server/enqueue-batch.js --limit 5  # 只入队 5 首（测试用）
//   docker exec momo-ktv node /app/server/enqueue-batch.js --dry-run  # 只统计不入队
//
// 过滤条件：media_type IN ('audio','cue') AND is_network=0 AND sep_status='none'
//           且不是纯音乐/轻音乐（worker 会跳过，但入队纯属浪费 GPU，这里提前剔除）。
// 幂等：separate.js enqueue() 本身对 pending/processing/done 做去重，重复跑安全。

const path = require('path');
const db = require('./db');
const sep = require('./separate');

// 与 ai-worker/worker.py 的 INSTRUMENTAL_RE 保持一致：命中即视为纯音乐，不入队。
// 匹配乐器名/纯音乐关键词/演奏曲等。
const INSTRUMENTAL_RE = new RegExp(
  '古筝|二胡|钢琴|吉他|琵琶|笛子?|洞箫|箫|笙|唢呐|马头琴|纯音乐|演奏|民乐|交响|协奏曲|' +
  '提琴|小提琴|大提琴|中提琴|低音提琴|葫芦丝|巴乌|轻音乐|器乐|试音|HIFI|古琴|扬琴|' +
  '京胡|三弦|江南丝竹|吹打|New Age|Instrumental|伴奏|无人声|纯演奏|独奏|重奏|奏鸣曲|' +
  '交响曲|管弦乐|室内乐|电子琴|双电子琴|手风琴|口琴|架子鼓|定音鼓|木琴|钟琴|管风琴|' +
  '竖琴|长笛|短笛|单簧管|双簧管|小号|长号|圆号|大号|贝斯|合成器|风琴|萨克斯|排箫|尺八|' +
  '伽倻琴|三味线|太鼓|钢片琴|颤音琴|马林巴|三角铁|响板|沙锤|铃鼓|康加鼓|邦戈鼓|' +
  '纯音乐版|演奏版|纯享版|无人声版|卡拉OK版|KTV版|消音版|伴奏版|轻音乐版|NewAge|新世纪',
  'i');

function isInstrumental(title, artist, album, genre) {
  const blob = [title, artist, album, genre].filter(Boolean).join(' ');
  return INSTRUMENTAL_RE.test(blob);
}

function parseArgs(argv) {
  const args = { limit: Infinity, dryRun: false, type: 'both' };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--limit=')) args.limit = parseInt(a.split('=')[1], 10);
    else if (a === '--limit') { /* handled below */ }
    else if (a.startsWith('--type=')) args.type = a.split('=')[1];
  }
  // support "--limit N" two-arg form
  const i = argv.indexOf('--limit');
  if (i >= 0 && argv[i + 1]) args.limit = parseInt(argv[i + 1], 10);
  return args;
}

function main() {
  const { limit, dryRun, type } = parseArgs(process.argv.slice(2));

  // 本地待分离歌曲：纯音频/整轨、非网络源、尚未分离。
  // 排除 all-flacs/ 路径：这些是历史转换中断留下的 0 字节占位 FLAC（备份用，非真实源），
  // 且与真实源文件重复，入队只会全部失败。
  const rows = db.prepare(
    `SELECT id, title, artist, album, genre, media_type, sep_status
       FROM songs
      WHERE media_type IN ('audio','cue')
        AND IFNULL(is_network,0) = 0
        AND sep_status = 'none'
        AND filename NOT LIKE '%all-flacs/%'
      ORDER BY id ASC`
  ).all();

  let enqueued = 0, skippedInstr = 0, skippedNotLocal = 0;
  const songIds = [];
  for (const r of rows) {
    if (isInstrumental(r.title, r.artist, r.album, r.genre)) { skippedInstr++; continue; }
    songIds.push(r.id);
    enqueued++;
    if (songIds.length >= limit) break;
  }

  console.log('=== enqueue-batch ===');
  console.log('候选本地待分离歌曲总数:', rows.length);
  console.log('剔除纯音乐/轻音乐:', skippedInstr);
  console.log('本次将入队(separate+align):', songIds.length, dryRun ? '[dry-run 不实际写入]' : '');
  if (songIds.length) {
    const sample = db.prepare(
      `SELECT id, title, artist, media_type FROM songs WHERE id IN (${songIds.slice(0, 5).map(() => '?').join(',')})`
    ).all(...songIds.slice(0, 5));
    console.log('样例:', JSON.stringify(sample, null, 0));
  }

  if (dryRun) {
    console.log('dry-run 结束，未入队任何任务。');
    return;
  }

  const res = sep.enqueue(db, { songIds, type, force: false });
  console.log('enqueue 结果:', JSON.stringify({ added: res.added, skipped: res.skipped, queued: res.queued.length }));

  // 打印当前队列统计
  const st = sep.stats(db);
  console.log('当前队列统计:', JSON.stringify(st));
}

main();
