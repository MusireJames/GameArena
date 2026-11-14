// Manual / scheduled backup:  npm run backup            saves backups/data-DATE.db and (if BACKUP_S3_* is set) uploads it off-site
// Restore a named off-site copy:  node backup.js restore latest   |   node backup.js restore hourly/07   |   node backup.js restore daily/2026-11-12
//   (stop the server first; this writes ./restored.db, check it, then replace your database file with it)
require('dotenv').config(); const fs = require('fs'), store = require('./store');
(async () => {
  if (process.argv[2] === 'restore') { await store.restoreFrom(process.argv[3] || 'latest', 'restored.db'); return console.log('Saved restored.db. Stop the server, then replace your database file with it.'); }
  const D = require('better-sqlite3'), db = new D(process.env.DB_FILE || 'data.db');
  fs.mkdirSync('backups', { recursive: true }); const f = 'backups/data-' + new Date().toISOString().slice(0, 10) + '.db';
  await store.snapshotFile(db, f); console.log('Backup saved to ' + f);
  if (store.configured()) await store.upload(db, 'manual'); else console.log('Off-site backup is not configured (BACKUP_S3_*).');
})().catch(e => { console.error(e.message); process.exit(1); });
