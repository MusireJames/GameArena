// Keeps customer data safe.
//  1. open():  SQLite in WAL mode with synchronous=FULL, so a committed deposit survives a crash or power cut.
//  2. Off-site snapshots to any S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS S3...): every BACKUP_INTERVAL_MIN minutes
//     when something changed, and once more when the server is shut down for a deploy. Compressed, and encrypted when BACKUP_KEY is set.
//  3. restoreIfMissing(): if the database file is gone (Render wipes its disk on every deploy unless you attach a Persistent Disk),
//     the latest snapshot is downloaded before the server starts. A failed download STOPS the start: an empty database must never
//     replace the real one.
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto'), s3 = require('./s3');
const E = process.env, MAGIC = Buffer.from('GAB1'), SQLITE = Buffer.from('SQLite format 3\0');
const prefix = () => (E.BACKUP_S3_PREFIX || 'gamearena/').replace(/^\/+/, '').replace(/([^/])$/, '$1/');
const keyFor = () => E.BACKUP_KEY ? crypto.scryptSync(E.BACKUP_KEY, 'gamearena-backup-v1', 32) : null;

function open(Database, file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma ? (db.pragma('journal_mode = WAL'), db.pragma('synchronous = FULL'), db.pragma('busy_timeout = 5000')) : db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
  return db;
}

// ---- pack / unpack a snapshot ----
function pack(raw) {
  const gz = zlib.gzipSync(raw, { level: 6 }), k = keyFor(); if (!k) return gz;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv), body = Buffer.concat([c.update(gz), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}
function unpack(buf) {
  if (buf.subarray(0, 4).equals(MAGIC)) {
    const k = keyFor(); if (!k) throw new Error('This backup is encrypted but BACKUP_KEY is not set');
    const d = crypto.createDecipheriv('aes-256-gcm', k, buf.subarray(4, 16)); d.setAuthTag(buf.subarray(16, 32));
    try { buf = Buffer.concat([d.update(buf.subarray(32)), d.final()]); } catch { throw new Error('Could not decrypt the backup: wrong BACKUP_KEY?'); }
  } else if (keyFor()) throw new Error('BACKUP_KEY is set but this backup is not encrypted');
  const raw = zlib.gunzipSync(buf); if (!raw.subarray(0, 16).equals(SQLITE)) throw new Error('The backup file is not a SQLite database');
  return raw;
}

// ---- snapshot ----
async function snapshotFile(db, dest) {   // a consistent copy of the live database, safe while the site is running
  fs.rmSync(dest, { force: true });
  if (typeof db.backup === 'function') await db.backup(dest); else db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
}
async function upload(db, why = 'timer') {
  if (!s3.configured()) return false;
  const tmp = path.join(require('os').tmpdir(), 'gamearena-snap-' + process.pid + '.db');
  try {
    await snapshotFile(db, tmp);
    const blob = pack(fs.readFileSync(tmp)), now = new Date(), p = prefix();
    await s3.put(p + 'latest.db.gz', blob);
    await s3.put(p + 'hourly/' + String(now.getUTCHours()).padStart(2, '0') + '.db.gz', blob);   // 24 rolling hourly copies, in case something bad is ever written to "latest"
    await s3.put(p + 'daily/' + now.toISOString().slice(0, 10) + '.db.gz', blob);
    console.log(`Off-site backup saved (${why}, ${(blob.length / 1048576).toFixed(2)} MB)`); return true;
  } finally { fs.rmSync(tmp, { force: true }); }
}

let timer = null, lastChanges = -1, running = false, runFn = null, pending = null;
function startBackups(db) {
  if (!s3.configured()) { console.warn('Off-site backups are NOT configured (BACKUP_S3_*). Your data is only as safe as the disk it is on.'); return; }
  const every = Math.max(1, +E.BACKUP_INTERVAL_MIN || 2) * 60000;
  const run = async why => {
    if (running) return; running = true;
    try { const c = db.prepare('select total_changes() c').get().c; if (why !== 'startup' && c === lastChanges) return; lastChanges = c; await upload(db, why); }
    catch (e) { console.error('Off-site backup FAILED:', e.message); lastChanges = -1; } finally { running = false; }
  };
  runFn = run; setTimeout(() => run('startup'), 15000).unref?.(); timer = setInterval(() => run('timer'), every); timer.unref?.();
}
/** Called after any change request (sign-up, deposit, withdrawal...): saves a fresh copy a few seconds later, so new accounts are not lost if the host restarts. */
function touch() {
  if (!runFn || pending) return;
  pending = setTimeout(() => { pending = null; runFn('change'); }, 8000); pending.unref?.();
}
/** Called when the server is told to stop (a deploy or restart): saves the very latest data before the disk can be wiped. */
async function snapshotNow(db, why = 'shutdown') {
  clearInterval(timer);
  if (!s3.configured()) return false;
  const t = Date.now(); while (running && Date.now() - t < 15000) await new Promise(r => setTimeout(r, 100));
  return upload(db, why);
}

// ---- restore ----
async function restoreIfMissing(file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return 'present';
  if (!s3.configured()) return 'none';
  const p = prefix(); let buf = await s3.get(p + 'latest.db.gz');   // throws on network trouble: the caller must NOT carry on with an empty database
  if (!buf) return 'nobackup';                                       // first ever start: nothing to restore
  const raw = unpack(buf);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = file + '.restoring'; fs.writeFileSync(tmp, raw); fs.rmSync(file + '-wal', { force: true }); fs.rmSync(file + '-shm', { force: true }); fs.renameSync(tmp, file);
  return 'restored';
}
/** Fetch one named snapshot (for manual recovery): node store.js restore hourly/07  or  daily/2026-11-12 */
async function restoreFrom(name, file) { const b = await s3.get(prefix() + name + '.db.gz'); if (!b) throw new Error('No such backup: ' + name); fs.writeFileSync(file, unpack(b)); }

module.exports = { touch, open, pack, unpack, upload, startBackups, snapshotNow, restoreIfMissing, restoreFrom, snapshotFile, configured: s3.configured };
