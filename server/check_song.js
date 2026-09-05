const Database = require('better-sqlite3');
const db = new Database('/data/ktv.db');

const song = db.prepare('SELECT id, title, artist, source_root, is_network, is_strm, vocal_path, accomp_path FROM songs WHERE id = 90805').get();
console.log("歌曲详情:");
console.log(JSON.stringify(song, null, 2));

// 测试正则表达式
if (song.vocal_path) {
  const match = String(song.vocal_path).match(/([a-f0-9]{16})_vocals\.strm/i);
  console.log("\n正则匹配结果:", match ? match[1] : "无匹配");
}

db.close();
