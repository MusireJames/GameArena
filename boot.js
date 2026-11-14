// Start here (npm start). Restores the database from the off-site backup if the disk was wiped, then starts the server.
require('dotenv').config();
const store = require('./store'), file = process.env.DB_FILE || 'data.db';
(async () => {
  try {
    const r = await store.restoreIfMissing(file);
    if (r === 'restored') console.log('Database was missing, so it was restored from the latest off-site backup.');
    else if (r === 'nobackup') console.log('No database and no backup yet: starting fresh.');
  } catch (e) {
    // Do NOT start with an empty database: the next backup would overwrite the real data. Exit so the host retries.
    console.error('\nCould not restore the database from the off-site backup: ' + e.message + '\nNot starting, to protect your data. Check BACKUP_S3_* and BACKUP_KEY, then restart.\n');
    process.exit(1);
  }
  require('./server');
})();
