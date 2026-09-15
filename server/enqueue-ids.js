// enqueue-ids.js —— 按 song id 列表入队 separate+align（测试用）
// 用法: node /app/server/enqueue-ids.js 79822 79742 81522 79944
const db = require('./db');
const sep = require('./separate');
const ids = process.argv.slice(2).map(s => parseInt(s, 10)).filter(n => Number.isInteger(n));
const res = sep.enqueue(db, { songIds: ids, type: 'both', force: false });
console.log('enqueue ids', ids, '->', JSON.stringify({ added: res.added, skipped: res.skipped, queued: res.queued }));
console.log(JSON.stringify(sep.stats(db)));
