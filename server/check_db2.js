const Database = require('better-sqlite3');
const db = new Database('/data/ktv.db');

console.log("=== songs 表结构 ===");
const columns = db.prepare("PRAGMA table_info(songs)").all();
columns.forEach(c => console.log(c.name + " " + c.type));

console.log("\n=== 歌曲数量 ===");
const count = db.prepare("SELECT COUNT(*) as cnt FROM songs").get();
console.log("总歌曲数:", count.cnt);

console.log("\n=== 前3首歌曲 ===");
const songs = db.prepare("SELECT id, title, artist, filename, filepath, audio_tracks FROM songs LIMIT 3").all();
songs.forEach(s => console.log(JSON.stringify(s)));

console.log("\n=== 搜索接口测试 ===");
const search = db.prepare("SELECT id, title, artist FROM songs WHERE title LIKE ? LIMIT 5").all('%测试%');
console.log("搜索'测试':", search.length, "首");

db.close();
