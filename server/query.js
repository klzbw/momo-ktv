
const Database = require('better-sqlite3');
const db = new Database('/data/ktv.db');
const songs = db.prepare("SELECT id, title, artist, source_root FROM songs WHERE title LIKE ? OR artist LIKE ? LIMIT 10").all('%雨果%', '%雨果%');
console.log("搜索'雨果':", songs.length, "首");
songs.forEach(s => console.log("  " + s.id + ": [" + s.source_root + "] " + s.artist + " - " + s.title));
db.close();
