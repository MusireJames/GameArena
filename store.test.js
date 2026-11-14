// Tests for off-site backup, restore and the "never start on an empty database" safety. Run: node --test store.test.js
const { test, before, after, beforeEach } = require('node:test'), assert = require('node:assert'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
let srv, objects, requests, failGet;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-store-'));
before(async () => {
  srv = http.createServer((req, res) => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, date: req.headers['x-amz-date'] });
    if (!/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request,SignedHeaders=host;x-amz-content-sha256;x-amz-date,Signature=[0-9a-f]{64}$/.test(req.headers.authorization || '')) { res.writeHead(403); return res.end('bad signature'); }
    if (req.method === 'PUT') { objects.set(req.url, Buffer.concat(chunks)); res.writeHead(200); return res.end(); }
    if (failGet) { res.writeHead(500); return res.end('boom'); }
    const o = objects.get(req.url); if (!o) { res.writeHead(404); return res.end('<Error>NoSuchKey</Error>'); } res.writeHead(200); res.end(o);
  }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { BACKUP_S3_ENDPOINT: 'http://127.0.0.1:' + srv.address().port, BACKUP_S3_BUCKET: 'bkt', BACKUP_S3_ACCESS_KEY: 'AK', BACKUP_S3_SECRET_KEY: 'SK', BACKUP_S3_REGION: 'auto', BACKUP_S3_PREFIX: 'ga/' });
  delete process.env.BACKUP_KEY;
});
after(() => { srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(() => { objects = new Map(); requests = []; failGet = false; delete process.env.BACKUP_KEY; });
const store = () => require('./store');
const mkdb = (file, rows = 3) => { const db = store().open(DatabaseSync, file); db.exec('create table if not exists users(id integer primary key, name text, balance integer)'); for (let i = 1; i <= rows; i++) db.prepare('insert into users(name,balance) values(?,?)').run('player' + i, i * 100); return db; };

test('S3 signer matches the official AWS Signature V4 test vector', () => {
  const h = require('./s3').sign({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', region: 'us-east-1', accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', headers: { Range: 'bytes=0-9' }, now: new Date('2013-05-24T00:00:00Z') });
  assert.equal(h.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});
test('database opens in WAL mode with full durability', () => {
  const db = mkdb(path.join(tmp, 'a', 'b', 'x.db')); assert.equal(db.prepare('pragma journal_mode').get().journal_mode, 'wal'); assert.equal(db.prepare('pragma synchronous').get().synchronous, 2); db.close();
});
test('wiped disk: the database comes back from the off-site copy, byte for byte in content', async () => {
  const f = path.join(tmp, 'live.db'), db = mkdb(f, 5); await store().upload(db, 'test');
  for (const k of ['/bkt/ga/latest.db.gz', '/bkt/ga/daily/' + new Date().toISOString().slice(0, 10) + '.db.gz']) assert.ok(objects.has(k), k + ' uploaded');
  assert.ok([...objects.keys()].some(k => /\/bkt\/ga\/hourly\/\d\d\.db\.gz/.test(k)));
  db.close(); for (const x of ['', '-wal', '-shm']) fs.rmSync(f + x, { force: true });   // Render wipes the disk
  assert.equal(await store().restoreIfMissing(f), 'restored');
  const back = new DatabaseSync(f); assert.deepEqual(back.prepare('select name, balance from users order by id').all().map(r => [r.name, r.balance]), [1, 2, 3, 4, 5].map(i => ['player' + i, i * 100])); back.close();
});
test('an existing database is NEVER overwritten by a restore', async () => {
  const f = path.join(tmp, 'keep.db'), db = mkdb(f, 2); await store().upload(db); db.prepare('insert into users(name,balance) values(?,?)').run('newer', 1); db.close();
  assert.equal(await store().restoreIfMissing(f), 'present'); const b = new DatabaseSync(f); assert.equal(b.prepare('select count(*) c from users').get().c, 3); b.close();
});
test('first ever start (no backup yet) starts fresh; no backup storage configured does nothing', async () => {
  assert.equal(await store().restoreIfMissing(path.join(tmp, 'fresh.db')), 'nobackup');
  const saved = process.env.BACKUP_S3_BUCKET; delete process.env.BACKUP_S3_BUCKET; assert.equal(await store().restoreIfMissing(path.join(tmp, 'none.db')), 'none'); process.env.BACKUP_S3_BUCKET = saved;
});
test('a network/server error during restore THROWS, so the server refuses to start on an empty database', async () => {
  const f = path.join(tmp, 'live2.db'), db = mkdb(f); await store().upload(db); db.close(); fs.rmSync(f); fs.rmSync(f + '-wal', { force: true }); fs.rmSync(f + '-shm', { force: true });
  failGet = true; await assert.rejects(() => store().restoreIfMissing(f), /download failed \(500\)/); assert.ok(!fs.existsSync(f), 'no empty database was created');
});
test('encrypted backups: restore works with the key, fails with the wrong key, and the stored bytes are not a readable database', async () => {
  process.env.BACKUP_KEY = 'correct horse battery staple';
  const f = path.join(tmp, 'enc.db'), db = mkdb(f, 2); await store().upload(db); db.close();
  const stored = objects.get('/bkt/ga/latest.db.gz'); assert.ok(stored.subarray(0, 4).equals(Buffer.from('GAB1'))); assert.ok(!stored.includes(Buffer.from('player1')) && !stored.includes(Buffer.from('SQLite format')));
  for (const x of ['', '-wal', '-shm']) fs.rmSync(f + x, { force: true });
  process.env.BACKUP_KEY = 'wrong key'; await assert.rejects(() => store().restoreIfMissing(f), /wrong BACKUP_KEY/); assert.ok(!fs.existsSync(f));
  delete process.env.BACKUP_KEY; await assert.rejects(() => store().restoreIfMissing(f), /BACKUP_KEY is not set/);
  process.env.BACKUP_KEY = 'correct horse battery staple'; assert.equal(await store().restoreIfMissing(f), 'restored');
});
test('shutdown snapshot saves the very latest data', async () => {
  const f = path.join(tmp, 'sd.db'), db = mkdb(f, 1); db.prepare("insert into users(name,balance) values('last-second-deposit', 999)").run();
  assert.equal(await store().snapshotNow(db, 'shutdown'), true); db.close(); fs.rmSync(f); fs.rmSync(f + '-wal', { force: true }); fs.rmSync(f + '-shm', { force: true });
  await store().restoreIfMissing(f); const b = new DatabaseSync(f); assert.equal(b.prepare("select balance from users where name='last-second-deposit'").get().balance, 999); b.close();
});
test('a corrupt or foreign file is refused', async () => {
  const zlib = require('zlib'); objects.set('/bkt/ga/latest.db.gz', zlib.gzipSync(Buffer.from('this is not a database')));
  await assert.rejects(() => store().restoreIfMissing(path.join(tmp, 'bad.db')), /not a SQLite database/);
});
