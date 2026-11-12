// Run daily (cron / Task Scheduler): npm run backup
require('dotenv').config(); const fs = require('fs'), D = require('better-sqlite3');
fs.mkdirSync('backups', { recursive: true });
new D(process.env.DB_FILE || 'data.db').backup('backups/data-' + new Date().toISOString().slice(0, 10) + '.db').then(() => console.log('Backup saved to backups/'));
