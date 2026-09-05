const Database = require('better-sqlite3');
const db = new Database('/data/momo.db');

console.log("=== songs 表结构 ===");
const columns = db.prepare("PRAGMA table_info(songs)").all();
columns.forEach(c => console.log(c.name + " " + c.type));

console.log("\n=== 歌曲数量 ===");
const count = db.prepare("SELECT COUNT(*) as cnt FROM songs").get();
console.log("总歌曲数:", count.cnt);

const hasSourceType = columns.some(c => c.name === 'source_type');
console.log("\n=== source_type 字段 ===");
console.log("存在:", hasSourceType);

console.log("\n=== 前5首歌曲 ===");
const songs = db.prepare("SELECT id, title, artist, filename, filepath FROM songs LIMIT 5").all();
songs.forEach(s => console.log(JSON.stringify(s)));

db.close();
