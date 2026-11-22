require('dotenv').config(); const crypto = require('crypto');
const express = require('express'), http = require('http'), { Server } = require('socket.io'), Database = require('better-sqlite3'),
  bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), { Chess } = require('chess.js'), messaging = require('./messaging'), pp = require('./palpluss'), createPayments = require('./payments'), store = require('./store'), BG = require('./boardgames'), FEES = require('./fees');
const CK = require('./checkers'), BOTS = require('./bots'), SF = require('./stockfish'), { ckSide, ckMoves } = CK;
const E = process.env, FEE = +E.PLATFORM_FEE || 0.1;
const PROD = E.NODE_ENV === 'production' || !!E.RENDER || E.FORCE_PRODUCTION === '1', STAKES = E.STAKES_ENABLED !== '0';   // Render counts as production even if NODE_ENV was forgotten
// There is NO public default secret: a secret that is known to everyone lets anyone forge a login as any player.
const SECRET = E.JWT_SECRET || (PROD ? '' : crypto.randomBytes(32).toString('hex')), CB_SECRET = E.CALLBACK_SECRET || (PROD ? '' : 'dev-callback-secret');
const JWT_OPTS = { algorithms: ['HS256'] }, GOOGLE_ID = E.GOOGLE_CLIENT_ID || '';
const TEST_DICE = !PROD && E.TEST_DICE ? E.TEST_DICE.split(',').map(Number) : [];   // test hook only, ignored in production   // STAKES_ENABLED=0 launches free play only
if (PROD) {   // refuse to run live with unsafe settings
  const bad = [];
  if (!E.JWT_SECRET || E.JWT_SECRET.length < 32 || /put-a-long|change-me|dev-secret/.test(E.JWT_SECRET)) bad.push('JWT_SECRET must be a random string of 32+ characters (run: npm run secret)');
  if (E.DEV_SHOW_CODES === '1') bad.push('Remove DEV_SHOW_CODES from .env');
  if (!/^https:\/\//.test(E.BASE_URL || '')) bad.push('BASE_URL must be your public https address');
  if (STAKES && (!E.CALLBACK_SECRET || E.CALLBACK_SECRET.length < 16)) bad.push('CALLBACK_SECRET must be set (run: npm run secret)');
  if (STAKES && !E.PALPLUSS_API_KEY) bad.push('PALPLUSS_API_KEY is missing (or set STAKES_ENABLED=0 to launch with free play only)');
  if (E.RENDER && !E.ALLOW_TEMP_DB && !store.configured() && !/^\/(var\/data|data|mnt|disk)\//.test(E.DB_FILE || '')) bad.push('Render wipes its disk on every deploy, so customer accounts and money records would be lost. Attach a Persistent Disk and set DB_FILE=/var/data/data.db, or set the BACKUP_S3_* variables (see DEPLOY.md)');
  if (!E.AT_API_KEY && !messaging.emailConfigured()) bad.push('Set up SMS (AT_API_KEY) or email (MAIL_RELAY_URL + MAIL_RELAY_SECRET, or SMTP_HOST) so verification codes can be sent');
  if (bad.length) { console.error('\nCannot start in production:\n - ' + bad.join('\n - ') + '\n'); process.exit(1); }
  if (STAKES && !/^p[pk]_live_/.test(E.PALPLUSS_API_KEY || '')) console.warn('WARNING: PALPLUSS_API_KEY is not a live key (pp_live_...), so no real money will move.');
  if (STAKES && !E.LICENCE_NO) console.warn('WARNING: LICENCE_NO is not set. Do not accept real-money play without a Gambling Regulatory Authority (GRA) licence.');
}
const db = store.open(Database, E.DB_FILE || 'data.db');   // WAL + synchronous=FULL: a committed deposit survives a crash
db.exec(`create table if not exists users(id integer primary key, phone text unique, name text, hash text, balance integer default 0);
create table if not exists txs(id integer primary key, uid integer, type text, amount integer, ref text, status text default 'pending', created text default current_timestamp)`);
try { db.exec('alter table tournaments add column live integer default 0'); } catch {}
try { db.exec('alter table plays add column vs_bot integer default 0'); } catch {}
try { db.exec('alter table chat add column vdur integer default 0'); } catch {}   // voice messages: length in seconds (0 = a text message)
db.exec('create table if not exists voice(id integer primary key, chat_id integer, mime text, data blob)');   // tournaments can be made live (watchable) by their creator
for (const c of ['dob text', 'daily_limit integer default 0', 'excluded_until text', 'rating integer default 1000', "kyc text default 'none'", 'id_number text', 'kyc_photo text', 'ip text', 'email text', "channel text default 'sms'", 'verified integer default 0', 'tv integer default 0', 'uuid text', 'is_bot integer default 0', 'ref_code text', 'referred_by integer', 'ref_paid integer default 0']) try { db.exec('alter table users add column ' + c); } catch {}
// Every account gets a random permanent id. Login tokens carry it, so a token can never be mistaken for another person's account
// (account numbers 1, 2, 3... are re-used if a database is ever replaced, and that is how people ended up in each other's accounts).
db.exec(`update users set uuid=lower(hex(randomblob(16))) where uuid is null;
create trigger if not exists users_uuid after insert on users when new.uuid is null begin update users set uuid=lower(hex(randomblob(16))) where id=new.id; end;
create unique index if not exists ux_users_uuid on users(uuid)`);
db.exec(`create table if not exists plays(id integer primary key, uid integer, game text, stake integer, result text, net integer, pair text, created text default current_timestamp);
create table if not exists ledger(id integer primary key, uid integer, amount integer, note text, created text default current_timestamp);
create table if not exists otps(id integer primary key, key text, purpose text, code_hash text, payload text, expires integer, attempts integer default 0, sent_at integer);
create table if not exists tournaments(id integer primary key, uid integer, name text, game text, fee integer default 0, g integer default 2, size integer, rounds integer, tc text, status text default 'open', pool integer default 0, winner integer, created text default current_timestamp, started text);
create table if not exists t_players(tid integer, uid integer, primary key(tid, uid));
create table if not exists t_matches(id integer primary key, tid integer, round integer, idx integer, players text, winner integer, room integer, status text default 'pending', draws integer default 0);
create table if not exists chat(id integer primary key, uid integer, name text, text text, reply_to integer, created text default current_timestamp);
create table if not exists tickets(id integer primary key, uid integer, msg text, status text default 'open', created text default current_timestamp);
create table if not exists house(id integer primary key, amount integer, created text default current_timestamp);
create table if not exists flags(id integer primary key, note text, created text default current_timestamp);
create table if not exists escrow(rid integer, uid integer, amount integer, primary key(rid, uid))`);
db.exec("insert into ledger(uid,amount,note) select id,balance,'opening balance' from users where balance!=0 and id not in (select uid from ledger)");
try { db.exec('create unique index if not exists ux_email on users(email) where email is not null'); } catch {}
db.exec(`create table if not exists bonuses(id integer primary key, uid integer, amount integer, at integer, unlocked integer default 0, ref_uid integer, created text default current_timestamp);
create unique index if not exists ux_ref_code on users(ref_code) where ref_code is not null`);
// ---- Referrals: the inviter gets a bonus when a friend who joined with the link makes a deposit. The bonus is locked (cannot be withdrawn) until the inviter has played a staked game. ----
const REF_ON = E.REFERRALS !== '0', REF_BONUS = +E.REFERRAL_BONUS || 10, REF_MIN = +E.REFERRAL_MIN_DEPOSIT || 50, REF_MAX = +E.REFERRAL_MAX_PER_USER || 20;
function newRef() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; for (;;) { let c = ''; for (let i = 0; i < 6; i++) c += A[crypto.randomInt(0, A.length)]; if (!db.prepare('select 1 from users where ref_code=?').get(c)) return c; } }
const ensureRef = id => { let c = db.prepare('select ref_code c from users where id=?').get(id)?.c; if (!c) { c = newRef(); db.prepare('update users set ref_code=? where id=?').run(c, id); } return c; };
db.prepare('select id from users where ref_code is null and is_bot=0').all().forEach(u => ensureRef(u.id));
const refUser = code => { code = String(code || '').trim().toUpperCase(); return /^[A-Z0-9]{4,10}$/.test(code) ? db.prepare('select id from users where ref_code=? and is_bot=0').get(code)?.id || null : null; };
const lockedOf = uid => db.prepare('select coalesce(sum(amount),0) s from bonuses where uid=? and unlocked=0').get(uid).s;
function refBonus(uid, amt) {   // called after a deposit has been credited
  if (!REF_ON || amt < REF_MIN) return;
  const u = db.prepare('select name, referred_by rb, ref_paid rp, ip from users where id=?').get(uid); if (!u || !u.rb || u.rp) return;
  const ref = db.prepare('select id, ip from users where id=? and is_bot=0').get(u.rb); if (!ref) return;
  const skip = why => { db.prepare('update users set ref_paid=2 where id=? and ref_paid=0').run(uid); if (why) db.prepare('insert into flags(note) values(?)').run(why); };
  if (db.prepare('select count(*) c from bonuses where uid=?').get(ref.id).c >= REF_MAX) return skip('Referral bonus not paid: account ' + ref.id + ' reached the limit of ' + REF_MAX + ' referral bonuses.');
  if (u.ip && ref.ip && u.ip === ref.ip) return skip('Referral bonus not paid: accounts ' + ref.id + ' and ' + uid + ' use the same internet address (possible self-referral). If they are real friends, pay it by hand.');
  let paid = false;
  txn(() => { if (db.prepare('update users set ref_paid=1 where id=? and ref_paid=0').run(uid).changes) { add(ref.id, REF_BONUS, 'referral bonus'); db.prepare('insert into bonuses(uid,amount,at,ref_uid) values(?,?,?,?)').run(ref.id, REF_BONUS, Date.now(), uid); paid = true; } });
  if (paid) { pushBal(ref.id); online.get(ref.id)?.emit('note', 'You earned KES ' + REF_BONUS + ': ' + u.name + ' joined with your link and deposited. Play one staked game to unlock it for withdrawal.'); }
}
const app = express(); app.set('trust proxy', 1); app.use(express.json({ limit: '4mb', verify: (req, res, buf) => { req.rawBody = buf; } })); app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()' });
  if (PROD) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'); next(); });
app.use('/api', (req, res, next) => { res.set({ 'Cache-Control': 'no-store', Vary: 'Authorization' }); next(); });
app.use('/api', (req, res, next) => { if (req.method === 'POST') res.on('finish', () => store.touch()); next(); });   // save an off-site copy a few seconds after any change   // a proxy or browser must never reuse one person's answer for another
app.get('/.well-known/assetlinks.json', (req, res) => {   // lets a Play Store (TWA) build open the site full screen
  const fp = (E.ANDROID_SHA256 || '').split(',').map(x => x.trim()).filter(Boolean);
  res.json(E.ANDROID_PACKAGE && fp.length ? [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: E.ANDROID_PACKAGE, sha256_cert_fingerprints: fp } }] : []);
});
app.get('/healthz', (req, res) => { try { db.prepare('select 1').get(); res.send('ok'); } catch { res.status(500).send('db error'); } });
app.get('/api/config', (req, res) => res.json({ stakes: STAKES, licence: E.LICENCE_NO || '', google: GOOGLE_ID, tfee: E.TOURNAMENT_FEE ? +E.TOURNAMENT_FEE : 0.1 }));
const legal = f => (req, res) => res.type('html').send(require('fs').readFileSync(require('path').join(__dirname, 'public', f), 'utf8')   // fills the legal templates from .env
  .replace(/\[COMPANY NAME\]/g, E.COMPANY_NAME || '[COMPANY NAME]').replace(/\[EMAIL\]/g, E.SUPPORT_EMAIL || '[EMAIL]')
  .replace(/\[LICENCE NUMBER\]/g, E.LICENCE_NO || '[LICENCE NUMBER]').replace(/\[ADD YOUR LICENSED HELPLINE AND SUPPORT ORGANISATION DETAILS\]/g, E.HELPLINE || '[ADD YOUR LICENSED HELPLINE AND SUPPORT ORGANISATION DETAILS]'));
['terms', 'privacy', 'responsible'].forEach(p => app.get('/' + p + '.html', legal(p + '.html')));
app.use(express.static('public'));
const srv = http.createServer(app), io = new Server(srv);
const kePhone = p => { const n = norm(p); return /^254[17]\d{8}$/.test(n) ? n : null; };   // Kenyan mobile numbers only (07.., 01.., +254..)
const norm = p => { p = String(p).replace(/\D/g, ''); return p.startsWith('0') ? '254' + p.slice(1) : p.startsWith('254') ? p : '254' + p; };
const tok = id => { const r = db.prepare('select tv, uuid from users where id=?').get(id); return jwt.sign({ id, u: r.uuid, tv: r.tv || 0 }, SECRET, { expiresIn: '7d' }); };   // u = the account's random permanent id; tv changes when the password is reset, which signs out other devices
const sameAccount = (row, p) => !!row && !!p.u && row.uuid === p.u && (row.tv || 0) === (p.tv || 0);   // old tokens (no "u") and tokens for a replaced database are refused
const auth = (req, res, next) => { try { const p = jwt.verify(String(req.headers.authorization || '').slice(7), SECRET, JWT_OPTS), row = db.prepare('select tv, uuid from users where id=?').get(p.id); if (!sameAccount(row, p)) throw new Error('stale login'); req.uid = p.id; next(); } catch { res.status(401).json({ error: 'login' }); } };
const bal = id => db.prepare('select balance from users where id=?').get(id).balance;
const add = (id, n, note = n > 0 ? 'credit' : 'debit') => { db.prepare('update users set balance=balance+? where id=?').run(n, id); if (n) db.prepare('insert into ledger(uid,amount,note) values(?,?,?)').run(id, n, note); };   // every wallet change is logged
const phoneOf = id => db.prepare('select phone from users where id=?').get(id)?.phone;
const REVIEW = +E.WITHDRAW_REVIEW_OVER || 5000, isAdmin = id => (E.ADMIN_PHONES || '').split(',').filter(Boolean).map(norm).includes(phoneOf(id));

const txn = fn => { db.exec('BEGIN IMMEDIATE'); try { const v = fn(); db.exec('COMMIT'); return v; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } };   // all or nothing, so a crash never leaves money half moved
const hold = (rid, uid, amt) => { if (amt) txn(() => { add(uid, -amt, 'stake'); db.prepare('insert or replace into escrow(rid,uid,amount) values(?,?,?)').run(rid, uid, amt); }); };   // a stake taken for a live game is also written to disk...
const unhold = (rid, uid) => db.prepare('delete from escrow where rid=? and uid=?').run(rid, uid);
txn(() => { for (const e of db.prepare('select * from escrow').all()) add(e.uid, e.amount, 'stake refund (server restarted)'); db.exec('delete from escrow'); });   // ...because games live only in memory: at start-up every stake still held is given back
const hits = new Map(), fails = new Map();   // fails: wrong-password times per phone   // simple in-memory rate limiter
const limit = (n, ms) => (req, res, next) => { const k = req.ip + req.baseUrl + req.path, now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < ms);
  if (a.length >= n) return res.status(429).json({ error: 'Too many attempts. Please wait a minute.' }); a.push(now); hits.set(k, a); next(); };
app.use(['/api/login', '/api/register', '/api/otp', '/api/reset'], limit(30, 60000));   // per endpoint, per IP (many phones share one IP on mobile networks)
app.use(['/api/deposit', '/api/withdraw'], limit(12, 60000)); app.use('/api/tournaments', limit(60, 60000));
app.get('/api/leaderboard', (req, res) => res.json(db.prepare(   // top 5 people by games won, with the last game each one won (no ratings shown)
  "select u.name, count(*) wins, (select p2.game from plays p2 where p2.uid=u.id and p2.result='win' and p2.vs_bot=0 order by p2.id desc limit 1) last_game, max(p.created) last_at from plays p join users u on u.id=p.uid where p.result='win' and p.vs_bot=0 and u.is_bot=0 group by u.id order by wins desc, max(p.id) desc limit 5").all()));
app.get('/api/history', auth, (req, res) => {
  const a = db.prepare("select type t, '' label, amount, status, created at from txs where uid=? order by id desc limit 20").all(req.uid);
  const b = db.prepare("select 'game' t, game label, net amount, result status, created at from plays where uid=? order by id desc limit 20").all(req.uid);
  res.json([...a, ...b].sort((x, y) => y.at.localeCompare(x.at)).slice(0, 25));
});
app.post('/api/limits', auth, (req, res) => {   // responsible play: daily deposit limit and self-exclusion
  if (req.body.daily != null) db.prepare('update users set daily_limit=? where id=?').run(Math.max(0, Math.floor(+req.body.daily) || 0), req.uid);
  if (req.body.exclude) { const until = new Date(Date.now() + Math.min(180, +req.body.exclude || 1) * 864e5).toISOString();
    db.prepare('update users set excluded_until=? where id=? and (excluded_until is null or excluded_until < ?)').run(until, req.uid, until); }
  res.json({ ok: true });
});
const admin = (req, res, next) => isAdmin(req.uid) ? next() : res.status(403).json({ error: 'Admins only' });
app.get('/api/admin/summary', auth, admin, async (req, res) => {
  const n = q => db.prepare(q).get().v;
  res.json({ users: n('select count(*) v from users where is_bot=0'), balances: n('select coalesce(sum(balance),0) v from users where is_bot=0'),
    botNet: n("select coalesce(sum(net),0) v from plays where uid in (select id from users where is_bot=1)"), botToday: -botLossToday(), botGames: n("select count(*) v from plays where uid in (select id from users where is_bot=1)"),
    refPaid: n('select coalesce(sum(amount),0) v from bonuses'), refCount: n('select count(*) v from bonuses'), refLocked: n('select coalesce(sum(amount),0) v from bonuses where unlocked=0'),
    deposits: n("select coalesce(sum(amount),0) v from txs where type='deposit' and status='done'"),
    withdrawals: n("select coalesce(sum(amount),0) v from txs where type='withdraw' and status='done'"),
    fees: n('select coalesce(sum(amount),0) v from house'),
    mismatch: n("select count(*) v from users u where balance != (select coalesce(sum(amount),0) from ledger where uid=u.id)"),
    depositors: n("select count(distinct uid) v from txs where type='deposit' and status='done'"),
    active: n("select count(distinct uid) v from plays where created > datetime('now','-1 day')"),
    byGame: db.prepare('select game, count(*) plays, coalesce(sum(stake),0) staked from plays group by game').all(),
    kyc: db.prepare("select id, name, phone, id_number from users where kyc='pending'").all(),
    tickets: db.prepare("select t.id, t.msg, t.created, u.name, u.phone from tickets t join users u on u.id=t.uid where t.status='open' order by t.id").all(),
    ...pay.overview(), payBalance: await svcBalance(),   // review / queued / stuck withdrawals, and the PalPluss service wallet balance
    depReview: db.prepare("select t.id, t.ref, t.amount, t.created, t.note, u.phone from txs t join users u on u.id=t.uid where t.type='deposit' and t.status='review' order by t.id").all(),
    flags: db.prepare('select note, created from flags order by id desc limit 20').all() });
});
// ---- Deposits (STK Push) and withdrawals (B2C) through PalPluss. All the money logic is in payments.js and is tested in payments.test.js ----
const alertAdmin = text => { console.warn('ALERT:', text); try { db.prepare('insert into flags(note) values(?)').run('ALERT: ' + String(text).slice(0, 480)); } catch {} if (E.ADMIN_EMAIL) messaging.notify(E.ADMIN_EMAIL, 'GameArena alert', text).catch(e => console.error('Alert email failed:', e.message)); };
const pay = createPayments({ db, add, pushBal, pp, alert: alertAdmin, baseUrl: E.BASE_URL || '', secret: CB_SECRET, locked: lockedOf, onDeposited: refBonus });
const svc = { at: 0, v: null }; const svcBalance = async () => { if (Date.now() - svc.at > 60000) { svc.at = Date.now(); try { svc.v = await pp.serviceBalance(); } catch { svc.v = null; } } return svc.v; };
app.post('/api/palpluss/webhook/:secret/:id', (req, res) => {   // PalPluss does not sign webhooks, so this is only a nudge: payments.js confirms the result wnsport-Security', 'max-age=31536000; includeSubDomains'); next(); });
app.use('/api', (req, res, next) => { res.set({ 'Cache-Control': 'no-store', Vary: 'Authorization' }); next(); });
app.use('/api', (req, res, next) => { if (req.method === 'POST') res.on('finish', () => store.touch()); next(); });   // save an off-site copy a few seconds after any change   // a proxy or browser must never reuse one person's answer for another
app.get('/.well-known/assetlinks.json', (req, res) => {   // lets a Play Store (TWA) build open the site full screen
  const fp = (E.ANDROID_SHA256 || '').split(',').map(x => x.trim()).filter(Boolean);
  res.json(E.ANDROID_PACKAGE && fp.length ? [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: E.ANDROID_PACKAGE, sha256_cert_fingerprints: fp } }] : []);
});
app.get('/healthz', (req, res) => { try { db.prepare('select 1').get(); res.send('ok'); } catch { res.status(500).send('db error'); } });
app.get('/api/config', (req, res) => res.json({ stakes: STAKES, licence: E.LICENCE_NO || '', google: GOOGLE_ID, tfee: E.TOURNAMENT_FEE ? +E.TOURNAMENT_FEE : 0.1 }));
const legal = f => (req, res) => res.type('html').send(require('fs').readFileSync(require('path').join(__dirname, 'public', f), 'utf8')   // fills the legal templates from .env
  .replace(/\[COMPANY NAME\]/g, E.COMPANY_NAME || '[COMPANY NAME]').replace(/\[EMAIL\]/g, E.SUPPORT_EMAIL || '[EMAIL]')
  .replace(/\[LICENCE NUMBER\]/g, E.LICENCE_NO || '[LICENCE NUMBER]').replace(/\[ADD YOUR LICENSED HELPLINE AND SUPPORT ORGANISATION DETAILS\]/g, E.HELPLINE || '[ADD YOUR LICENSED HELPLINE AND SUPPORT ORGANISATION DETAILS]'));
['terms', 'privacy', 'responsible'].forEach(p => app.get('/' + p + '.html', legal(p + '.html')));
app.use(express.static('public'));
const srv = http.createServer(app), io = new Server(srv);
const kePhone = p => { const n = norm(p); return /^254[17]\d{8}$/.test(n) ? n : null; };   // Kenyan mobile numbers only (07.., 01.., +254..)
const norm = p => { p = String(p).replace(/\D/g, ''); return p.startsWith('0') ? '254' + p.slice(1) : p.startsWith('254') ? p : '254' + p; };
const tok = id => { const r = db.prepare('select tv, uuid from users where id=?').get(id); return jwt.sign({ id, u: r.uuid, tv: r.tv || 0 }, SECRET, { expiresIn: '7d' }); };   // u = the account's random permanent id; tv changes when the password is reset, which signs out other devices
const sameAccount = (row, p) => !!row && !!p.u && row.uuid === p.u && (row.tv || 0) === (p.tv || 0);   // old tokens (no "u") and tokens for a replaced database are refused
const auth = (req, res, next) => { try { const p = jwt.verify(String(req.headers.authorization || '').slice(7), SECRET, JWT_OPTS), row = db.prepare('select tv, uuid from users where id=?').get(p.id); if (!sameAccount(row, p)) throw new Error('stale login'); req.uid = p.id; next(); } catch { res.status(401).json({ error: 'login' }); } };
const bal = id => db.prepare('select balance from users where id=?').get(id).balance;
const add = (id, n, note = n > 0 ? 'credit' : 'debit') => { db.prepare('update users set balance=balance+? where id=?').run(n, id); if (n) db.prepare('insert into ledger(uid,amount,note) values(?,?,?)').run(id, n, note); };   // every wallet change is logged
const phoneOf = id => db.prepare('select phone from users where id=?').get(id)?.phone;
const REVIEW = +E.WITHDRAW_REVIEW_OVER || 5000, isAdmin = id => (E.ADMIN_PHONES || '').split(',').filter(Boolean).map(norm).includes(phoneOf(id));

const txn = fn => { db.exec('BEGIN IMMEDIATE'); try { const v = fn(); db.exec('COMMIT'); return v; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } };   // all or nothing, so a crash never leaves money half moved
const hold = (rid, uid, amt) => { if (amt) txn(() => { add(uid, -amt, 'stake'); db.prepare('insert or replace into escrow(rid,uid,amount) values(?,?,?)').run(rid, uid, amt); }); };   // a stake taken for a live game is also written to disk...
const unhold = (rid, uid) => db.prepare('delete from escrow where rid=? and uid=?').run(rid, uid);
txn(() => { for (const e of db.prepare('select * from escrow').all()) add(e.uid, e.amount, 'stake refund (server restarted)'); db.exec('delete from escrow'); });   // ...because games live only in memory: at start-up every stake still held is given back
const hits = new Map(), fails = new Map();   // fails: wrong-password times per phone   // simple in-memory rate limiter
const limit = (n, ms) => (req, res, next) => { const k = req.ip + req.baseUrl + req.path, now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < ms);
  if (a.length >= n) return res.status(429).json({ error: 'Too many attempts. Please wait a minute.' }); a.push(now); hits.set(k, a); next(); };
app.use(['/api/login', '/api/register', '/api/otp', '/api/reset'], limit(30, 60000));   // per endpoint, per IP (many phones share one IP on mobile networks)
app.use(['/api/deposit', '/api/withdraw'], limit(12, 60000)); app.use('/api/tournaments', limit(60, 60000));
app.get('/api/leaderboard', (req, res) => res.json(db.prepare("select name, rating from users u where is_bot=0 order by rating desc limit 10").all()));
app.get('/api/history', auth, (req, res) => {
  const a = db.prepare("select type t, '' label, amount, status, created at from txs where uid=? order by id desc limit 20").all(req.uid);
  const b = db.prepare("select 'game' t, game label, net amount, result status, created at from plays where uid=? order by id desc limit 20").all(req.uid);
  res.json([...a, ...b].sort((x, y) => y.at.localeCompare(x.at)).slice(0, 25));
});
app.post('/api/limits', auth, (req, res) => {   // responsible play: daily deposit limit and self-exclusion
  if (req.body.daily != null) db.prepare('update users set daily_limit=? where id=?').run(Math.max(0, Math.floor(+req.body.daily) || 0), req.uid);
  if (req.body.exclude) { const until = new Date(Date.now() + Math.min(180, +req.body.exclude || 1) * 864e5).toISOString();
    db.prepare('update users set excluded_until=? where id=? and (excluded_until is null or excluded_until < ?)').run(until, req.uid, until); }
  res.json({ ok: true });
});
const admin = (req, res, next) => isAdmin(req.uid) ? next() : res.status(403).json({ error: 'Admins only' });
app.get('/api/admin/summary', auth, admin, async (req, res) => {
  const n = q => db.prepare(q).get().v;
  res.json({ users: n('select count(*) v from users where is_bot=0'), balances: n('select coalesce(sum(balance),0) v from users where is_bot=0'),
    botNet: n("select coalesce(sum(net),0) v from plays where uid in (select id from users where is_bot=1)"), botToday: -botLossToday(), botGames: n("select count(*) v from plays where uid in (select id from users where is_bot=1)"),
    refPaid: n('select coalesce(sum(amount),0) v from bonuses'), refCount: n('select count(*) v from bonuses'), refLocked: n('select coalesce(sum(amount),0) v from bonuses where unlocked=0'),
    deposits: n("select coalesce(sum(amount),0) v from txs where type='deposit' and status='done'"),
    withdrawals: n("select coalesce(sum(amount),0) v from txs where type='withdraw' and status='done'"),
    fees: n('select coalesce(sum(amount),0) v from house'),
    mismatch: n("select count(*) v from users u where balance != (select coalesce(sum(amount),0) from ledger where uid=u.id)"),
    depositors: n("select count(distinct uid) v from txs where type='deposit' and status='done'"),
    active: n("select count(distinct uid) v from plays where created > datetime('now','-1 day')"),
    byGame: db.prepare('select game, count(*) plays, coalesce(sum(stake),0) staked from plays group by game').all(),
    kyc: db.prepare("select id, name, phone, id_number from users where kyc='pending'").all(),
    tickets: db.prepare("select t.id, t.msg, t.created, u.name, u.phone from tickets t join users u on u.id=t.uid where t.status='open' order by t.id").all(),
    ...pay.overview(), payBalance: await svcBalance(),   // review / queued / stuck withdrawals, and the PalPluss service wallet balance
    depReview: db.prepare("select t.id, t.ref, t.amount, t.created, t.note, u.phone from txs t join users u on u.id=t.uid where t.type='deposit' and t.status='review' order by t.id").all(),
    flags: db.prepare('select note, created from flags order by id desc limit 20').all() });
});
// ---- Deposits (STK Push) and withdrawals (B2C) through PalPluss. All the money logic is in payments.js and is tested in payments.test.js ----
const alertAdmin = text => { console.warn('ALERT:', text); try { db.prepare('insert into flags(note) values(?)').run('ALERT: ' + String(text).slice(0, 480)); } catch {} if (E.ADMIN_EMAIL) messaging.notify(E.ADMIN_EMAIL, 'GameArena alert', text).catch(e => console.error('Alert email failed:', e.message)); };
const pay = createPayments({ db, add, pushBal, pp, alert: alertAdmin, baseUrl: E.BASE_URL || '', secret: CB_SECRET, locked: lockedOf, onDeposited: refBonus });
const svc = { at: 0, v: null }; const svcBalance = async () => { if (Date.now() - svc.at > 60000) { svc.at = Date.now(); try { svc.v = await pp.serviceBalance(); } catch { svc.v = null; } } return svc.v; };
app.post('/api/palpluss/webhook/:secret/:id', (req, res) => {   // PalPluss does not sign webhooks, so this is only a nudge: payments.js confirms the result with PalPluss before moving any money
  const a = Buffer.from(String(req.params.secret)), b = Buffer.from(CB_SECRET);
  if (!CB_SECRET || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).end();
  res.sendStatus(200);   // answer first, as PalPluss asks
  pay.webhook(+req.params.id, req.body).catch(e => console.error('PalPluss webhook error:', e.message));
});
app.get('/api/pay/status/:id', auth, async (req, res) => {   // the page polls this after a deposit
  const status = await pay.depositStatus(req.uid, req.params.id); status ? res.json({ status }) : res.status(404).json({ error: 'Not found' });
});
// ---- Sign in with Google ----
async function googleVerify(idToken) {
  const r = await fetch((E.GOOGLE_TOKENINFO_URL || 'https://oauth2.googleapis.com/tokeninfo') + '?id_token=' + encodeURIComponent(idToken)), j = await r.json().catch(() => ({}));
  if (!GOOGLE_ID || !r.ok || j.aud !== GOOGLE_ID || String(j.email_verified) !== 'true' || !j.email) throw new Error('Google sign-in failed. Please try again.');
  return { email: j.email.toLowerCase(), name: j.name || j.email.split('@')[0] };
}
app.post('/api/google/start', async (req, res) => {
  try { const g = await googleVerify(String(req.body.credential || '')), u = db.prepare('select id from users where email=?').get(g.email);
    if (u) return finishLogin(u.id, req, res);   // Google has already verified this email
    res.json({ needProfile: true, gt: jwt.sign({ gem: g.email, gname: g.name }, SECRET, { expiresIn: '15m' }), email: g.email, name: g.name }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/google/complete', (req, res) => {
  let g; try { g = jwt.verify(String(req.body.token || ''), SECRET); if (!g.gem) throw 0; } catch { return res.status(400).json({ error: 'Your Google sign-in expired. Please try again.' }); }
  const ph = norm(req.body.phone || ''), dob = req.body.dob;
  if (!/^254\d{9}$/.test(ph)) return res.status(400).json({ error: 'Enter a valid Kenyan phone number' });
  if (!dob || !((Date.now() - new Date(dob)) / 3.15576e10 >= 18)) return res.status(400).json({ error: 'You must be 18 or older to register' });
  if (db.prepare('select 1 from users where phone=?').get(ph)) return res.status(400).json({ error: 'This phone number is already registered' });
  try { const u = db.prepare('insert into users(phone,name,hash,dob,email,channel,verified,ip) values(?,?,?,?,?,?,1,?)').run(ph, String(g.gname || 'Player').slice(0, 20), bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10), dob, g.gem, 'email', req.ip);
    const nid = u.lastInsertRowid; ensureRef(nid); const rf = refUser(req.body.ref); if (rf && rf !== nid) db.prepare('update users set referred_by=? where id=?').run(rf, nid);
    res.json({ token: tok(nid) }); }
  catch { res.status(400).json({ error: 'This email or phone number is already registered' }); }
});
app.post('/api/kyc', auth, (req, res) => {
  const { idNumber, photo } = req.body;
  if (!/^\d{6,10}$/.test(String(idNumber || ''))) return res.status(400).json({ error: 'Enter a valid national ID number' });
  if (!/^data:image\/(jpeg|png);base64,/.test(photo || '') || photo.length > 3e6) return res.status(400).json({ error: 'Upload a JPG or PNG photo of your ID under 2 MB' });
  db.prepare("update users set kyc='pending', id_number=?, kyc_photo=? where id=? and kyc!='approved'").run(idNumber, photo, req.uid); res.json({ ok: true });
});
app.post('/api/ticket', auth, (req, res) => {
  const m = String(req.body.msg || '').trim().slice(0, 1000); if (!m) return res.status(400).json({ error: 'Write a message first' });
  db.prepare('insert into tickets(uid,msg) values(?,?)').run(req.uid, m); res.json({ ok: true });
});
app.get('/api/admin/kyc/:uid', auth, admin, (req, res) => res.json(db.prepare('select id_number, kyc_photo photo from users where id=?').get(+req.params.uid) || {}));
app.post('/api/admin/kyc', auth, admin, (req, res) => { db.prepare("update users set kyc=? where id=? and kyc='pending'").run(req.body.action === 'approve' ? 'approved' : 'rejected', +req.body.uid); res.json({ ok: true }); });
app.post('/api/admin/ticket', auth, admin, (req, res) => { db.prepare("update tickets set status='closed' where id=?").run(+req.body.id); res.json({ ok: true }); });
app.post('/api/admin/withdrawal', auth, admin, async (req, res) => {   // approve = pay it now, reject = give the money back to the player's wallet
  try { const ok = req.body.action === 'reject' ? pay.adminReject(req.body.id) : await pay.adminApprove(req.body.id); ok ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found, or already handled' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// ---- Sign up and login with a one-time code sent by SMS or email ----
const OTP_TTL = 10 * 60 * 1000, OTP_COOLDOWN = 60 * 1000, LOGIN_OTP = E.LOGIN_OTP !== '0';
const DEV = E.DEV_SHOW_CODES === '1' && E.NODE_ENV !== 'production';   // test mode: show codes instead of sending them (never in production)
const hashCode = (code, key) => crypto.createHash('sha256').update(code + '|' + key + '|' + SECRET).digest('hex');
const mask = (ch, d) => ch === 'email' ? d.replace(/^(.).*(@.*)$/, '$1•••$2') : '•••••••' + d.slice(-3);
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
async function issueOtp(key, purpose, payload, channel, dest) {
  const old = db.prepare('select sent_at from otps where key=? and purpose=?').get(key, purpose);
  if (old && Date.now() - old.sent_at < OTP_COOLDOWN) throw new Error('Please wait a minute before asking for another code');
  const code = String(crypto.randomInt(100000, 1000000)), drop = () => db.prepare('delete from otps where key=? and purpose=?').run(key, purpose);
  drop();
  db.prepare('insert into otps(key,purpose,code_hash,payload,expires,sent_at) values(?,?,?,?,?,?)').run(key, purpose, hashCode(code, key), JSON.stringify({ ...payload, _ch: channel, _dest: dest }), Date.now() + OTP_TTL, Date.now());
  let sent; try { sent = await messaging.send(channel, dest, code); } catch (e) { drop(); throw e; }
  if (!sent && !DEV) { drop(); throw new Error(channel === 'email' ? 'Email sending is not set up yet' : 'SMS sending is not set up yet. For local testing add DEV_SHOW_CODES=1 to .env'); }
  if (!sent) console.log(`[TEST MODE] ${purpose} code for ${dest}: ${code}`);
  return { channel, dest: mask(channel, dest), devCode: !sent ? code : undefined };
}
function checkOtp(key, purpose, code) {
  const o = db.prepare('select * from otps where key=? and purpose=?').get(key, purpose);
  if (!o || o.expires < Date.now()) return { error: 'Code expired. Please request a new one.' };
  if (o.attempts >= 5) { db.prepare('delete from otps where id=?').run(o.id); return { error: 'Too many wrong attempts. Please request a new code.' }; }
  if (!crypto.timingSafeEqual(Buffer.from(hashCode(String(code || '').trim(), key)), Buffer.from(o.code_hash))) {
    db.prepare('update otps set attempts=attempts+1 where id=?').run(o.id); return { error: 'Wrong code. Please try again.' }; }
  db.prepare('delete from otps where id=?').run(o.id); return { payload: JSON.parse(o.payload) };
}
app.post('/api/register/start', async (req, res) => {
  const { phone, name, password, dob, email, channel } = req.body, ph = norm(phone || ''), ch = 'email', em = String(email || '').trim().toLowerCase();
  if (!/^254\d{9}$/.test(ph)) return res.status(400).json({ error: 'Enter a valid Kenyan phone number' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Choose a password with at least 6 characters' });
  if (!dob || !((Date.now() - new Date(dob)) / 3.15576e10 >= 18)) return res.status(400).json({ error: 'You must be 18 or older to register' });
  if ((ch === 'email' || em) && !emailOk(em)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (db.prepare('select 1 from users where phone=?').get(ph)) return res.status(400).json({ error: 'This phone number is already registered' });
  if (em && db.prepare('select 1 from users where email=?').get(em)) return res.status(400).json({ error: 'This email is already registered' });
  try { res.json({ ok: true, ...await issueOtp(ph, 'signup', { phone: ph, name: String(name || 'Player').slice(0, 20), hash: bcrypt.hashSync(password, 10), dob, email: em || null, channel: ch, ip: req.ip, ref: String(req.body.ref || '').slice(0, 12) }, ch, ch === 'email' ? em : ph) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/register/verify', (req, res) => {
  const r = checkOtp(norm(req.body.phone || ''), 'signup', req.body.code); if (r.error) return res.status(400).json(r);
  const p = r.payload;
  try { const u = db.prepare('insert into users(phone,name,hash,dob,email,channel,verified,ip) values(?,?,?,?,?,?,1,?)').run(p.phone, p.name, p.hash, p.dob, p.email, p.channel, p.ip); const nid = u.lastInsertRowid; ensureRef(nid); const rf = refUser(p.ref); if (rf && rf !== nid) db.prepare('update users set referred_by=? where id=?').run(rf, nid); res.json({ token: tok(nid) }); }
  catch { res.status(400).json({ error: 'This phone number or email is already registered' }); }
});
const finishLogin = (id, req, res) => { db.prepare('update users set ip=? where id=?').run(req.ip, id); res.json({ token: tok(id) }); };
app.post('/api/login/start', async (req, res) => {
  const ph = norm(req.body.phone || ''), u = db.prepare('select * from users where phone=?').get(ph);
  const f = (fails.get(ph) || []).filter(x => Date.now() - x < 600000);
  if (f.length >= 8) return res.status(429).json({ error: 'Too many wrong passwords. Try again in 10 minutes, or reset your password.' });
  if (!u || !bcrypt.compareSync(req.body.password || '', u.hash)) { f.push(Date.now()); fails.set(ph, f); return res.status(401).json({ error: 'Wrong phone or password' }); }
  fails.delete(ph);
  if (!LOGIN_OTP || !u.email) return finishLogin(u.id, req, res);
  const ch = 'email';
  try { res.json({ otp: true, ...await issueOtp(ph, 'login', { id: u.id }, ch, ch === 'email' ? u.email : ph) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/login/verify', (req, res) => {
  const r = checkOtp(norm(req.body.phone || ''), 'login', req.body.code); if (r.error) return res.status(400).json(r);
  finishLogin(r.payload.id, req, res);
});
// ---- Forgot password: a code by email, then a new password ----
const findUser = id => { id = String(id || '').trim().toLowerCase(); return id.includes('@') ? db.prepare('select * from users where email=?').get(id) : db.prepare('select * from users where phone=?').get(norm(id)); };
app.post('/api/reset/start', async (req, res) => {
  const u = findUser(req.body.id), out = { ok: true };   // the answer is the same whether or not the account exists
  if (u) { const ch = u.email ? 'email' : 'sms';
    try { const info = await issueOtp(u.phone, 'reset', { id: u.id }, ch, ch === 'email' ? u.email : u.phone); if (info.devCode) out.devCode = info.devCode; }
    catch (e) { console.error('Password reset code not sent:', e.message); } }
  res.json(out);
});
app.post('/api/reset/verify', (req, res) => {
  const pw = String(req.body.password || ''); if (pw.length < 6) return res.status(400).json({ error: 'Choose a password with at least 6 characters' });
  const u = findUser(req.body.id); if (!u) return res.status(400).json({ error: 'Wrong or expired code. Please request a new one.' });
  const r = checkOtp(u.phone, 'reset', req.body.code); if (r.error) return res.status(400).json(r);
  db.prepare('update users set hash=?, tv=coalesce(tv,0)+1 where id=?').run(bcrypt.hashSync(pw, 10), u.id);   // also signs out every other device
  finishLogin(u.id, req, res);
});
app.post('/api/otp/resend', async (req, res) => {
  const ph = norm(req.body.phone || ''), purpose = req.body.purpose === 'login' ? 'login' : 'signup', o = db.prepare('select payload from otps where key=? and purpose=?').get(ph, purpose);
  if (!o) return res.status(400).json({ error: 'Please start again' });
  const { _ch, _dest, ...p } = JSON.parse(o.payload);
  try { res.json({ ok: true, ...await issueOtp(ph, purpose, p, _ch, _dest) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/me', auth, (req, res) => { const u = db.prepare('select id,name,phone,balance,rating,daily_limit,excluded_until,kyc from users where id=?').get(req.uid); res.json({ ...u, locked: Math.min(u.balance, lockedOf(req.uid)), admin: isAdmin(req.uid) }); });
app.get('/api/referral', auth, (req, res) => {
  const code = ensureRef(req.uid), q = s => db.prepare(s).get(req.uid);
  res.json({ on: REF_ON, code, link: (E.BASE_URL || '').replace(/\/$/, '') + '/?ref=' + code, bonus: REF_BONUS, min: REF_MIN,
    invited: q('select count(*) v from users where referred_by=?').v, rewarded: q('select count(*) v from bonuses where uid=?').v, earned: q('select coalesce(sum(amount),0) v from bonuses where uid=?').v, locked: lockedOf(req.uid) });
});

// ---- Deposit (M-Pesa STK Push) and withdraw (M-Pesa B2C), both through PalPluss ----
app.get('/api/quote', (req, res) => {   // what a deposit or withdrawal of this amount costs the player (PalPluss fees are paid by the player)
  const a = Math.floor(+req.query.amount); if (!(a > 0)) return res.json({});
  const df = FEES.depositFee(a), wf = FEES.b2cFee(a);
  res.json({ deposit: { fee: df, pay: a + df, receive: a }, withdraw: wf == null ? null : { fee: wf, debit: a + wf, receive: a } });
});
app.post('/api/deposit', auth, async (req, res) => {
  const amt = Math.floor(+req.body.amount); if (!STAKES) return res.status(403).json({ error: 'Deposits are not open yet' });
  if (!(amt >= 10)) return res.status(400).json({ error: 'Minimum KES 10' });
  if (amt > 150000) return res.status(400).json({ error: 'Maximum KES 150,000 per deposit' });
  const u0 = db.prepare('select daily_limit dl, excluded_until ex from users where id=?').get(req.uid);
  if (u0.ex && u0.ex > new Date().toISOString()) return res.status(403).json({ error: 'Your account is on a self-exclusion break' });
  if (u0.dl) { const used = db.prepare("select coalesce(sum(amount),0) s from txs where uid=? and type='deposit' and status!='failed' and date(created)=date('now')").get(req.uid).s;
    if (used + amt > u0.dl) return res.status(400).json({ error: 'This would exceed your daily deposit limit of KES ' + u0.dl }); }
  let ph = null; if (req.body.phone) { ph = kePhone(req.body.phone); if (!ph) return res.status(400).json({ error: 'Enter a valid Safaricom number, for example 0712345678' }); }
  try { const r = await pay.startDeposit(req.uid, amt, ph, FEES.depositFee(amt)); r.error ? res.status(400).json({ error: r.error }) : res.json({ ok: true, ref: r.id, message: r.message }); }
  catch (e) { console.error('Deposit failed:', e); res.status(500).json({ error: 'Could not start the deposit. Please try again.' }); }
});
app.post('/api/withdraw', auth, (req, res) => {   // the wallet is debited at once and the payout is sent straight away (or held for approval if it is large)
  const amt = Math.floor(+req.body.amount);
  if (!(amt >= 50)) return res.status(400).json({ error: 'Minimum KES 50' });
  if (amt > FEES.MAX_PAYOUT) return res.status(400).json({ error: 'Maximum KES ' + FEES.MAX_PAYOUT.toLocaleString('en') + ' per withdrawal' });
  let ph = null, force = false;
  if (req.body.phone) {   // paying out to a number other than the registered one: needs the password, and larger amounts are checked by an admin first
    ph = kePhone(req.body.phone); if (!ph) return res.status(400).json({ error: 'Enter a valid Safaricom number, for example 0712345678' });
    const u = db.prepare('select phone, hash from users where id=?').get(req.uid);
    if (ph === u.phone) ph = null;
    else { if (!bcrypt.compareSync(String(req.body.password || ''), u.hash)) return res.status(401).json({ error: 'Enter your password to withdraw to a different number' });
      force = amt >= (+E.OTHER_NUMBER_REVIEW_OVER || 1000); }
  }
  try { const r = pay.createWithdrawal(req.uid, amt, ph, force, FEES.b2cFee(amt)); res.json({ ok: true, review: r.review }); }
  catch (e) { e.user ? res.status(400).json({ error: e.message }) : (console.error('Withdrawal failed:', e), res.status(500).json({ error: 'Could not start the withdrawal. Please try again.' })); }
});

// ---- Multiplayer games ----
const rooms = new Map(), online = new Map(); let rid = 1;
// Ludo (2 players, 4 tokens each). pos: -1 yard, 0-50 main track, 51-55 home lane, 56 home.
const SAFE = [0, 8, 13, 21, 26, 34, 39, 47];
const tcParse = tc => { const [m, i] = String(tc || '10+0').split('+').map(Number), ok = m > 0 && m <= 60 && i >= 0 && i <= 60, M = ok ? m : 10, I = ok ? i : 0; return { clock: [M * 6e4, M * 6e4], inc: I * 1e3, tc: M + '+' + I }; };
const mkCode = () => { let c; do c = crypto.randomBytes(3).toString('hex').toUpperCase(); while ([...rooms.values()].some(r => r.code === c)); return c; };
const GAME_IDS = ['chess', 'tictactoe', 'ludo', 'checkers', ...BG.names];
const nextTurn = r => { do r.turn = (r.turn + 1) % r.players.length; while (r.out[r.turn]); };
const lmov = (L, p) => L.pos[p].map((x, t) => (x < 0 ? L.die === 6 : x + L.die <= 56) ? t : -1).filter(t => t >= 0);
function pushBal(uid) { const s = online.get(uid); if (s) s.emit('balance', bal(uid)); }
io.use((s, next) => { try { const p = jwt.verify(s.handshake.auth.token, SECRET, JWT_OPTS); s.uid = p.id; const row = db.prepare('select excluded_until e, tv, uuid from users where id=?').get(s.uid); if (!sameAccount(row, p)) throw new Error('stale'); const ex = row.e; if (ex && ex > new Date().toISOString()) return next(new Error('excluded')); next(); } catch { next(new Error('auth')); } });
const lobby = () => [...rooms.values()].filter(r => r.listed && !r.started && r.players.length < r.size).map(r => ({ code: r.open ? null : r.code, id: r.id, game: r.game, stake: r.stake, by: r.names[0], hid: r.players[0], n: r.players.length, size: r.size, open: !!r.open, live: !!r.live, tc: r.tc || null }));
const specN = id => io.sockets.adapter.rooms.get('v' + id)?.size || 0;   // how many people are watching a game
const liveList = () => [...rooms.values()].filter(r => r.live && r.started && !r.over).map(r => ({ id: r.id, game: r.game, stake: r.stake, names: r.names, w: specN(r.id), t: !!r.tid }));
let liveT = null; const liveTick = () => { if (liveT) return; liveT = setTimeout(() => { liveT = null; io.emit('live', liveList()); }, 300); };   // tell everyone, at most a few times a second
const view = r => ({ id: r.id, live: !!r.live, w: specN(r.id), game: r.game, stake: r.stake, ck: r.ck, ckm: r.ck && !r.over ? ckMoves(r.ck, r.turn, r.mustFrom) : [], left: r.started && !r.over ? Math.max(0, r.deadline - Date.now()) : null, tid: r.tid, tnote: r.tnote, bots: r.bots, lm: r.lm, chk: !!(r.chess && r.chess.inCheck()), line: r.line, winner: r.winner, pay: r.pay, drawBy: r.drawBy, tc: r.tc, clk: r.clock && r.started && !r.over ? r.clock.map((v, i) => i === r.turn ? Math.max(0, r.deadline - Date.now()) : v) : null, code: r.code, started: r.started, ready: r.ready, size: r.size, out: r.out, names: r.names, players: r.players, over: r.over, result: r.result, turn: r.turn, fen: r.chess ? r.chess.fen() : null, board: r.board, mv: BG.is(r.game) && r.started && !r.over ? BG.legal(r.game, r.board, r.turn) : [], note: r.note, ludo: r.ludo ? { msg: r.ludo.msg, seat: r.ludo.seat, pos: r.ludo.pos, die: r.ludo.die, last: r.ludo.last, movable: r.ludo.die ? lmov(r.ludo, r.turn) : [] } : null });
const TURN = { chess: 120000, checkers: 60000, ludo: 30000, tictactoe: 20000 };   // per-move time limits
const send = r => { if (r.started && !r.over) r.deadline = r.clock ? r.t0 + r.clock[r.turn] : Date.now() + (BG.is(r.game) ? BG.turnMs(r.game) : TURN[r.game]); r.ply = (r.ply || 0) + 1; io.to('r' + r.id).emit('state', view(r)); if (r.live) io.to('v' + r.id).emit('state', view(r)); botKick(r); };
function finish(r, winner, text) {   // winner = user id, or null for a draw (stakes refunded)
  if (r.over) return; r.over = true; r.result = text;
  const pot = r.stake * r.players.length, pay = Math.floor(pot * (1 - FEE)); r.winner = winner; r.pay = pay;
  if (r.stake) { txn(() => { winner == null ? r.players.forEach(p => add(p, r.stake, 'draw refund')) : add(winner, pay, 'winnings'); if (winner != null) db.prepare('insert into house(amount) values(?)').run(pot - pay); db.prepare('delete from escrow where rid=?').run(r.id); }); r.players.forEach(pushBal); }
  const pair = r.players.length === 2 && !r.bots ? r.players.slice().sort().join('-') : null;
  r.players.forEach(p => { const res = winner == null ? 'draw' : p === winner ? 'win' : 'loss';
    db.prepare('insert into plays(uid,game,stake,result,net,pair) values(?,?,?,?,?,?)').run(p, r.game, r.stake, res, res === 'win' ? pay - r.stake : res === 'loss' ? -r.stake : 0, pair); });
  if (winner != null && !r.bots) { const W = db.prepare('select rating from users where id=?').get(winner).rating; let gain = 0;
    r.players.forEach(p => { if (p === winner) return; const L = db.prepare('select rating from users where id=?').get(p).rating;
      const d = Math.round(24 / (1 + Math.pow(10, (W - L) / 400))); gain += d; db.prepare('update users set rating=max(100,rating-?) where id=?').run(d, p); });
    db.prepare('update users set rating=rating+? where id=?').run(gain, winner); }
  if (r.stake && pair) { const ips = r.players.map(p => db.prepare('select ip from users where id=?').get(p).ip); if (ips[0] && ips[0] === ips[1]) db.prepare('insert into flags(note) values(?)').run('Same IP: accounts ' + pair + ' played a staked game from one address'); }
  if (r.stake && pair) { const n = db.prepare("select count(*) c from plays where pair=? and stake>0 and created>datetime('now','-1 day')").get(pair).c / 2;
    if (n >= 5) db.prepare('insert into flags(note) values(?)').run('Possible collusion: accounts ' + pair + ' played ' + n + ' staked games in 24h'); }
  if (r.stake && r.startedAt && Date.now() - r.startedAt >= 20000) r.players.forEach((p, i) => {   // a referral bonus unlocks once its owner has played a real staked game that started after the bonus
    if (r.bots && r.bots[i]) return;
    if (db.prepare('update bonuses set unlocked=1 where uid=? and unlocked=0 and at<?').run(p, r.startedAt).changes) { pushBal(p); online.get(p)?.emit('note', 'Your referral bonus is now unlocked. You can withdraw it.'); online.get(p)?.emit('refresh'); } });
  if (r.mid) tMatchDone(r, winner);
  send(r); liveTick(); setTimeout(() => { rooms.delete(r.id); liveTick(); }, 60000);
}
function forfeit(r, i) {
  if (r.over || r.out[i]) return; r.out[i] = true;
  const alive = r.players.filter((_, k) => !r.out[k]);
  if (alive.length === 1) { const w = alive[0]; return finish(r, w, r.names[r.players.indexOf(w)] + ' wins (opponent forfeited)'); }
  if (r.ludo) r.ludo.pos[i] = [-1, -1, -1, -1];
  if (r.turn === i) { if (r.ludo) r.ludo.die = null; nextTurn(r); }
  send(r);
}
function timeout(r) {   // move timer ran out
  const i = r.turn; r.miss = r.miss || []; r.miss[i] = (r.miss[i] || 0) + 1;
  if (r.ludo && r.miss[i] < 3) { r.ludo.die = null; nextTurn(r); return send(r); }   // Ludo: skip turn, 3 timeouts forfeit
  forfeit(r, i);
}
setInterval(() => rooms.forEach(r => {
  if (!r.started || r.over) return; const now = Date.now();
  if (r.tid && now - r.born > 180000) {   // tournament no-shows: a player who never joined the match forfeits after 3 minutes
    const miss = r.players.map((u, i) => (r.seen[u] || r.out[i]) ? -1 : i).filter(i => i >= 0);
    if (miss.length === r.players.length) return finish(r, r.players[crypto.randomInt(0, r.players.length)], 'Nobody showed up. A random player advances.');
    if (miss.length) { miss.forEach(i => forfeit(r, i)); return; } }
  for (const [u, t] of Object.entries(r.away || {})) { const i = r.players.indexOf(+u); if (now - t > 60000 && i >= 0 && !r.out[i]) return forfeit(r, i); }   // 60s reconnect window
  if (now > r.deadline) timeout(r);
}), 1000);
function begin(r) {   // called when the host starts and everyone is ready
  r.started = true; r.startedAt = Date.now(); const n = r.players.length; liveTick();
  for (const u of r.players) { closeOpen(u, 'Your other open tables were closed because you started a game. Stakes returned.'); const ps = online.get(u); if (ps && ps.spec) { ps.leave('v' + ps.spec); ps.spec = null; } }
  if (r.game === 'chess') { r.chess = new Chess(); if (!r.clock) { r.clock = [6e5, 6e5]; r.inc = 0; } r.t0 = Date.now(); }
  else if (r.game === 'ludo') r.ludo = { pos: r.players.map(() => [-1, -1, -1, -1]), die: null, last: null, seat: n === 2 ? [0, 2] : [0, 1, 2, 3].slice(0, n) };
  else if (r.game === 'checkers') { r.ck = Array.from({ length: 64 }, (_, i) => ((i >> 3) + (i & 7)) & 1 ? ((i >> 3) < 3 ? 'b' : (i >> 3) > 4 ? 'w' : 0) : 0); r.mustFrom = null; }
  else if (BG.is(r.game)) r.board = BG.init(r.game);
  else r.board = Array(9).fill('');
}
function leave(s) {
  const r = rooms.get(s.rid); s.rid = null; if (!r) return;
  const i = r.players.indexOf(s.uid); if (i < 0) return;
  s.leave('r' + r.id);
  if (r.over) return;
  if (!r.started) {            // game not started: refund and remove the player
    if (r.stake) txn(() => { add(s.uid, r.stake, 'stake refund'); unhold(r.id, s.uid); }); pushBal(s.uid);
    r.players.splice(i, 1); r.names.splice(i, 1); r.ready.splice(i, 1); r.ready = r.ready.map(() => false);
    if (!r.players.length) rooms.delete(r.id); else send(r);
    return io.emit('lobby', lobby());
  }
  forfeit(r, i);
}
// ---- Public tables ("challenges"): anyone can accept without a code. A player may keep several open at once; they close when he starts any game. ----
const MAX_OPEN = 5, OPEN_MINUTES = +E.OPEN_TABLE_MINUTES || 30;
function closeTable(r, why) {   // removes an unstarted public table and returns the host's stake
  if (!rooms.get(r.id) || r.started) return; const h = r.players[0];
  if (r.stake) { txn(() => { add(h, r.stake, 'stake refund'); unhold(r.id, h); }); pushBal(h); }
  rooms.delete(r.id); const hs = online.get(h); if (hs) { hs.leave('r' + r.id); if (why) hs.emit('note', why); } io.emit('lobby', lobby());
}
const closeOpen = (uid, why) => { for (const r of [...rooms.values()]) if (r.open && !r.started && r.players[0] === uid) closeTable(r, why); };
setInterval(() => { const now = Date.now(); for (const r of [...rooms.values()]) if (r.open && !r.started && now - r.born > OPEN_MINUTES * 60000) closeTable(r, 'Your public table expired after ' + OPEN_MINUTES + ' minutes with no challenger. Your stake was returned.'); }, 30000);
// ---- Quick match: pair players who are searching for the same game and stake; both must accept ----
const queue = new Map(), proposals = new Map(); let pid = 1;
const qkey = (g, st, n) => g + ':' + st + ':' + n;
const uinfo = id => db.prepare('select name, rating from users where id=?').get(id);
const unq = u => { queue.forEach(q => { const i = q.indexOf(u); if (i >= 0) q.splice(i, 1); }); };
const qt = new Map(), rating = u => uinfo(u).rating, waited = u => (Date.now() - (qt.get(u) || Date.now())) / 1000;
function pick(q, need) {   // 2-player games: allowed rating gap starts at 100 and grows 25 per second of waiting
  if (q.length < need) return null;
  if (need > 2) return q.slice(0, need);
  for (let i = 0; i < q.length; i++) for (let j = i + 1; j < q.length; j++)
    if (Math.abs(rating(q[i]) - rating(q[j])) <= 100 + 25 * Math.max(waited(q[i]), waited(q[j]))) return [q[i], q[j]];
  return null;
}
function enqueue(u, key) {
  if (!queue.has(key)) queue.set(key, []);
  const q = queue.get(key); if (!q.includes(u)) { q.push(u); qt.set(u, Date.now()); }
  online.get(u)?.emit('queue', true); matchmake(key);
}
function matchmake(key) {
  const q = queue.get(key) || [], [game, stake, n] = key.split(':'), need = +n;
  let g;
  while ((g = pick(q, need))) {
    g.forEach(u => q.splice(q.indexOf(u), 1));
    const players = g, p = { id: pid++, game, stake: +stake, size: need, players, acc: new Set(), key };
    proposals.set(p.id, p);
    players.forEach(u => { const ps = online.get(u); if (!ps) return; ps.pid = p.id;
      ps.emit('match', { id: p.id, game, stake: +stake, size: need, secs: 15, opp: players.filter(x => x !== u).map(x => uinfo(x).name + ' (' + uinfo(x).rating + ')') }); });
    p.timer = setTimeout(() => cancelProposal(p, null), 15000);
  }
}
function cancelProposal(p, by, mode) {
  if (!proposals.delete(p.id)) return; clearTimeout(p.timer);
  p.players.forEach(u => { const ps = online.get(u); if (!ps) return; ps.pid = null;
    const keep = mode !== 'invalid' && u !== by && (by != null || p.acc.has(u));   // decliners and no-shows leave the queue
    if (u !== by) ps.emit('matchEnd', { msg: mode === 'invalid' ? 'Match cancelled. A player was unavailable.' : by != null ? 'Opponent declined. Searching again...' : p.acc.has(u) ? 'Opponent did not respond. Searching again...' : 'Match expired' });
    if (keep) enqueue(u, p.key); else ps.emit('queue', false); });
}
function answer(p, uid, ok) {
  if (!proposals.has(p.id) || !p.players.includes(uid)) return;
  if (!ok) return cancelProposal(p, uid);
  p.acc.add(uid); if (p.acc.size < p.players.length) return;
  const free = u => { const ps = online.get(u), c = ps && rooms.get(ps.rid); return ps && !(c && !c.over); };
  if (!p.players.every(free) || (p.stake && p.players.some(u => bal(u) < p.stake))) return cancelProposal(p, null, 'invalid');
  proposals.delete(p.id); clearTimeout(p.timer);
  const r = { id: rid++, game: p.game, stake: p.stake, size: p.size, out: [], code: mkCode(), listed: false, started: false, ready: p.players.map(() => true),
    players: [...p.players], names: p.players.map(u => uinfo(u).name), turn: 0, over: false };
  rooms.set(r.id, r);
  p.players.forEach(u => { hold(r.id, u, p.stake); const ps = online.get(u); ps.join('r' + r.id); ps.rid = r.id; ps.pid = null; ps.emit('queue', false); pushBal(u); });
  begin(r); send(r);   // both accepted, so no ready check: the game starts immediately
}
// ---- Tournaments: knockout brackets with an entry fee. The champion gets the pool minus the platform fee (TOURNAMENT_FEE, 10%). ----
const TFEE = E.TOURNAMENT_FEE ? +E.TOURNAMENT_FEE : 0.1;
const T_SIZES = { 2: [4, 8, 16, 32], 3: [9, 27], 4: [16, 64] };   // size must be players-per-match to the power of the number of rounds
const tn = id => db.prepare('select name from users where id=?').get(id)?.name || 'Player';
const tPrize = pool => Math.floor(pool * (1 - TFEE));
const tPlayers = tid => db.prepare('select uid from t_players where tid=? order by rowid').all(tid).map(x => x.uid);
const tPush = tid => io.emit('tupdate', { id: tid });
const excluded = id => { const e = db.prepare('select excluded_until e from users where id=?').get(id)?.e; return !!(e && e > new Date().toISOString()); };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function startMatch(t, m, swap) {   // every match is a normal game room with no stake: the entry fees were paid up front
  let ps = JSON.parse(m.players); if (swap) ps = ps.slice().reverse();
  db.prepare("update t_matches set players=?, status='live' where id=?").run(JSON.stringify(ps), m.id);
  const r = { id: rid++, game: t.game, stake: 0, size: ps.length, out: [], code: mkCode(), listed: false, live: !!t.live, started: false, ready: ps.map(() => true), players: ps, names: ps.map(tn), turn: 0, over: false, tid: t.id, mid: m.id, seen: {}, born: Date.now(), ...(t.game === 'chess' && tcParse(t.tc)) };
  rooms.set(r.id, r); begin(r); send(r);
  db.prepare('update t_matches set room=? where id=?').run(r.id, m.id);
  ps.forEach(u => online.get(u)?.emit('tmatch', { tid: t.id, tname: t.name, round: m.round, rounds: t.rounds, room: r.id, game: t.game, names: r.names }));
}
function startTournament(t) {
  const ps = shuffle(tPlayers(t.id)), g = t.g;
  db.prepare("update tournaments set status='running', started=current_timestamp where id=?").run(t.id);
  for (let r = 1; r <= t.rounds; r++) for (let i = 0; i < t.size / Math.pow(g, r); i++)   // every slot of the bracket is created now so it can be shown
    db.prepare('insert into t_matches(tid,round,idx,players) values(?,?,?,?)').run(t.id, r, i, r === 1 ? JSON.stringify(ps.slice(i * g, i * g + g)) : '[]');
  db.prepare('select * from t_matches where tid=? and round=1').all(t.id).forEach(m => startMatch(t, m));
}
function tMatchDone(r, winner) {   // called from finish() when a tournament game ends
  const m = db.prepare('select * from t_matches where id=?').get(r.mid), t = db.prepare('select * from tournaments where id=?').get(r.tid);
  if (!m || !t || m.status === 'done') return;
  if (winner == null) {   // a draw: replay with colours swapped; the third draw is settled by a coin flip
    const d = m.draws + 1; db.prepare('update t_matches set draws=? where id=?').run(d, m.id);
    if (d < 3) { r.tnote = 'Draw. The game is replayed.'; setTimeout(() => startMatch(t, { ...m, draws: d }, true), 1500); return; }
    const pl = JSON.parse(m.players); winner = pl[crypto.randomInt(0, pl.length)]; r.tnote = 'Third draw: ' + tn(winner) + ' advances by coin flip.';
  }
  db.prepare("update t_matches set winner=?, status='done' where id=?").run(winner, m.id);
  if (m.round === t.rounds) {   // the final: pay the champion
    const pool = db.prepare('select pool from tournaments where id=?').get(t.id).pool, prize = tPrize(pool);
    txn(() => { db.prepare("update tournaments set status='done', winner=? where id=?").run(winner, t.id);
      if (prize) add(winner, prize, 'tournament prize');
      if (pool - prize) db.prepare('insert into house(amount) values(?)').run(pool - prize); });
    pushBal(winner); r.tnote = tn(winner) + ' wins ' + t.name + (prize ? ' and KES ' + prize : '') + '!';
  } else {   // move the winner up, and start the next match as soon as all of its feeder matches are decided
    const pi = Math.floor(m.idx / t.g), parent = db.prepare('select * from t_matches where tid=? and round=? and idx=?').get(t.id, m.round + 1, pi);
    const kids = db.prepare('select winner from t_matches where tid=? and round=? and idx>=? and idx<? order by idx').all(t.id, m.round, pi * t.g, pi * t.g + t.g);
    r.tnote = tn(winner) + ' advances to round ' + (m.round + 1);
    if (kids.every(k => k.winner)) { const ps = JSON.stringify(kids.map(k => k.winner)); db.prepare('update t_matches set players=? where id=?').run(ps, parent.id); startMatch(t, { ...parent, players: ps }); }
  }
  tPush(t.id);
}
function joinT(tid, uid) {
  const t = db.prepare('select * from tournaments where id=?').get(tid); if (!t || t.status !== 'open') return 'This tournament is not open';
  const ps = tPlayers(tid); if (ps.includes(uid)) return 'You are already in this tournament'; if (ps.length >= t.size) return 'This tournament is full';
  if (excluded(uid)) return 'Your account is on a self-exclusion break';
  if (t.fee && bal(uid) < t.fee) return 'Insufficient balance. The entry fee is KES ' + t.fee;
  txn(() => { if (t.fee) add(uid, -t.fee, 'tournament entry'); db.prepare('insert into t_players(tid,uid) values(?,?)').run(tid, uid); db.prepare('update tournaments set pool=pool+? where id=?').run(t.fee, tid); }); pushBal(uid);
  if (ps.length + 1 === t.size) startTournament(db.prepare('select * from tournaments where id=?').get(tid));
  tPush(tid); return null;
}
function leaveT(tid, uid) {
  const t = db.prepare('select * from tournaments where id=?').get(tid); if (!t || t.status !== 'open') return 'You can only leave before the tournament starts';
  if (!tPlayers(tid).includes(uid)) return 'You are not in this tournament';
  txn(() => { db.prepare('delete from t_players where tid=? and uid=?').run(tid, uid);
    if (t.fee) { add(uid, t.fee, 'tournament entry refund'); db.prepare('update tournaments set pool=pool-? where id=?').run(t.fee, tid); } });
  pushBal(uid); tPush(tid); return null;
}
function cancelT(tid) {
  const t = db.prepare('select * from tournaments where id=?').get(tid); if (!t || t.status !== 'open') return 'Only a tournament that has not started can be cancelled';
  const ps = tPlayers(tid); txn(() => { ps.forEach(u => { if (t.fee) add(u, t.fee, 'tournament entry refund'); }); db.prepare("update tournaments set status='cancelled', pool=0 where id=?").run(tid); });
  ps.forEach(pushBal); tPush(tid); return null;
}
app.get('/api/tournaments', auth, (req, res) => {
  const rows = db.prepare("select t.*, u.name cname, w.name wname from tournaments t join users u on u.id=t.uid left join users w on w.id=t.winner where t.status in ('open','running') or (t.status='done' and t.started > datetime('now','-3 days')) order by case t.status when 'open' then 0 when 'running' then 1 else 2 end, t.id desc limit 40").all();
  res.json(rows.map(t => { const ps = tPlayers(t.id); return { id: t.id, name: t.name, game: t.game, fee: t.fee, g: t.g, size: t.size, n: ps.length, status: t.status, creator: t.cname, mine: t.uid === req.uid, joined: ps.includes(req.uid), prize: tPrize(t.fee * t.size), winner: t.wname, tc: t.tc, live: !!t.live }; }));
});
app.get('/api/tournaments/:id', auth, (req, res) => {
  const t = db.prepare('select t.*, u.name cname from tournaments t join users u on u.id=t.uid where t.id=?').get(+req.params.id); if (!t) return res.status(404).json({ error: 'Tournament not found' });
  const ps = tPlayers(t.id), ms = db.prepare('select * from t_matches where tid=? order by round, idx').all(t.id).map(m => { const pl = JSON.parse(m.players);
    return { id: m.id, round: m.round, idx: m.idx, status: m.status, winner: m.winner, players: pl.map(u => ({ id: u, name: tn(u) })), room: m.status === 'live' && pl.includes(req.uid) && rooms.has(m.room) ? m.room : null }; });
  res.json({ id: t.id, name: t.name, game: t.game, fee: t.fee, g: t.g, size: t.size, rounds: t.rounds, status: t.status, creator: t.cname, mine: t.uid === req.uid, joined: ps.includes(req.uid), players: ps.map(u => ({ id: u, name: tn(u) })), prize: tPrize(t.fee * t.size), feeRate: TFEE, live: !!t.live, winner: t.winner, wname: t.winner ? tn(t.winner) : null, tc: t.tc, matches: ms });
});
app.post('/api/tournaments', auth, (req, res) => {
  const b = req.body, game = b.game, name = String(b.name || '').trim().slice(0, 40), fee = Math.floor(+b.fee) || 0, size = Math.floor(+b.size);
  const g = game === 'ludo' ? Math.min(4, Math.max(2, Math.floor(+b.g) || 2)) : 2, bad = m => res.status(400).json({ error: m });
  if (!GAME_IDS.includes(game)) return bad('Pick a game');
  if (name.length < 3) return bad('Give the tournament a name of at least 3 letters');
  if (!T_SIZES[g].includes(size)) return bad('For ' + g + ' players per match the size must be one of: ' + T_SIZES[g].join(', '));
  if (fee < 0 || (fee > 0 && fee < 10) || fee > 100000) return bad('The entry fee must be 0, or between KES 10 and KES 100,000');
  if (fee > 0 && !STAKES) return bad('Real-money play is not open yet. Create a free tournament.');
  if (excluded(req.uid)) return bad('Your account is on a self-exclusion break');
  if (db.prepare("select count(*) c from tournaments where uid=? and status='open'").get(req.uid).c >= 3) return bad('You already have 3 open tournaments');
  if (b.enter !== false && fee && bal(req.uid) < fee) return bad('Insufficient balance to enter your own tournament (KES ' + fee + ')');
  const rounds = Math.round(Math.log(size) / Math.log(g)), tc = game === 'chess' ? tcParse(b.tc).tc : null;
  const id = db.prepare('insert into tournaments(uid,name,game,fee,g,size,rounds,tc,live) values(?,?,?,?,?,?,?,?,?)').run(req.uid, name, game, fee, g, size, rounds, tc, b.live ? 1 : 0).lastInsertRowid;
  if (b.enter !== false) joinT(id, req.uid);
  tPush(id); res.json({ ok: true, id });
});
const tAct = fn => (req, res) => { const t = db.prepare('select uid from tournaments where id=?').get(+req.params.id);
  if (fn === cancelT && t && t.uid !== req.uid && !isAdmin(req.uid)) return res.status(403).json({ error: 'Only the creator can cancel' });
  const e = fn(+req.params.id, req.uid); e ? res.status(400).json({ error: e }) : res.json({ ok: true }); };
app.post('/api/tournaments/:id/join', auth, tAct(joinT));
app.post('/api/tournaments/:id/leave', auth, tAct(leaveT));
app.post('/api/tournaments/:id/cancel', auth, tAct(cancelT));
setInterval(() => db.prepare("select id from tournaments where status='open' and created < datetime('now', ?)").all('-' + (+E.TOURNAMENT_OPEN_HOURS || 24) + ' hours').forEach(t => cancelT(t.id)), 600000);   // unfilled tournaments are cancelled and refunded
db.prepare("select * from t_matches where status='live'").all().forEach(m => { const t = db.prepare('select * from tournaments where id=?').get(m.tid); if (t && t.status === 'running') startMatch(t, m); });   // after a restart, live matches get new rooms

// ---- Public chat: everyone online can post, read and reply ----
const PUB_BAD = /(https?:|www\.|\b[a-z0-9-]{2,}\.(com|co|ke|net|org|me|io|app|xyz|info|ly)\b)/i;
const pubShape = r => ({ id: r.id, uid: r.uid, name: r.name, text: r.text, at: new Date(String(r.created).replace(' ', 'T') + 'Z').getTime(),
  rp: r.reply_to ? { id: r.reply_to, uid: r.pu, name: r.pn || 'Deleted', text: r.pt ? r.pt.slice(0, 90) : '(message deleted)' } : null });
const pubRows = () => db.prepare('select c.*, p.name pn, p.text pt, p.uid pu from chat c left join chat p on p.id=c.reply_to order by c.id desc limit 80').all().reverse().map(pubShape);
// ---- Bots: a clearly labelled computer opponent, offered ONLY to a player who has waited in "Find opponent" with nobody to play and who says yes. ----
const BOT_ON = E.BOTS !== '0', BOT_MAX = +E.BOT_MAX_STAKE || 50, BOT_WAIT = (+E.BOT_WAIT_SECONDS || 20) * 1000, BOT_LOSS = +E.BOT_DAILY_LOSS || 300;
const BOT_PAID = (E.BOT_STAKED_GAMES === undefined ? 'tictactoe,connect4,ludo' : E.BOT_STAKED_GAMES).split(',').map(x => x.trim()).filter(Boolean);   // bots play for money ONLY in these games; every other game is free-play against a bot
const botOk = (game, stake) => stake === 0 || (stake <= BOT_MAX && BOT_PAID.includes(game));
BOTS.NAMES.forEach(n => db.prepare("insert or ignore into users(phone,name,hash,is_bot,verified,rating) values(?,?,'!',1,1,1000)").run('bot-' + n.toLowerCase(), '🤖 Bot ' + n));
function botLossToday() { return -db.prepare("select coalesce(sum(net),0) s from plays where uid in (select id from users where is_bot=1) and created > datetime('now','-1 day')").get().s; }
function pickBotUser(stake) {
  const used = new Set(); rooms.forEach(r => { if (r.bots && !r.over) r.players.forEach((p, i) => { if (r.bots[i]) used.add(p); }); });
  const free = db.prepare('select id, name from users where is_bot=1').all().filter(b => !used.has(b.id)); if (!free.length) return null;
  const b = free[crypto.randomInt(0, free.length)]; if (stake && bal(b.id) < stake) add(b.id, 500, 'bot bankroll'); return b;   // the bot plays with house money, capped per day by BOT_DAILY_LOSS
}
function botKick(r) {   // called after every state change: if it is a bot's turn, move after a short, human-like pause
  if (!r.bots || !r.started || r.over || r.botT || r.botWait || !r.bots[r.turn]) return;
  r.botT = setTimeout(() => { r.botT = null; botAct(r); }, 1000 + crypto.randomInt(0, 2000));
}
function botAct(r) {
  if (!rooms.has(r.id) || r.over || !r.started || !r.bots[r.turn]) return;
  const i = r.turn, uid = r.players[i], p0 = r.ply;
  const verify = () => {   // if the bot's move changed nothing (illegal or failed), play any legal move so the game can never freeze
    if (r.over || !rooms.has(r.id) || r.ply !== p0 || !r.bots[r.turn] || r.turn !== i) return;
    console.error('Bot made no move in', r.game, 'room', r.id, '. Using a fallback move.');
    try { const m = BOTS.anyMove(r, i, { lmov }); if (m) doMove(r, uid, r.names[i], m); else if (r.game === 'ludo') { r.ludo.die = null; nextTurn(r); send(r); } } catch (e) { console.error('Bot fallback failed:', e); }
  };
  if (r.game === 'chess' && SF.available()) {   // Stockfish thinks in a separate process; the built-in bot is the fallback
    const fen = r.chess.fen(); r.botWait = true;
    return SF.best(fen).then(u => {
      r.botWait = false; if (r.over || r.turn !== i || r.chess.fen() !== fen) return;
      let m = null; if (u) { const f = u.slice(0, 2), t = u.slice(2, 4); if (r.chess.moves({ verbose: true }).some(x => x.from === f && x.to === t)) m = { from: f, to: t, promotion: u[4] || 'q' }; }
      if (!m) { console.error('Stockfish gave no usable move (' + u + '). Using the built-in chess bot.'); m = BOTS.pickMove(r, i, {}); }
      if (m) doMove(r, uid, r.names[i], m); verify();
    }).catch(e => { r.botWait = false; console.error('Stockfish bot error:', e); verify(); });
  }
  try {
    if (r.game === 'ludo' && !r.ludo.die) doRoll(r, uid);
    else { const m = BOTS.pickMove(r, i, { lmov, SAFE }); if (m) doMove(r, uid, r.names[i], m); }
  } catch (e) { console.error('Bot error:', e); }
  verify();
}
function botScan() {   // someone has been waiting a while with nobody to play: offer a bot (they must accept)
  if (!BOT_ON) return; const now = Date.now();
  queue.forEach((q, key) => { const [game, stake, n] = key.split(':'); if ((+n !== 2 && game !== 'ludo') || !botOk(game, +stake)) return;   // Ludo: a 3 or 4 player search can also become a 2-player game with a bot
    if (+stake > 0 && botLossToday() >= BOT_LOSS) return;
    q.forEach(u => { const s = online.get(u), t = qt.get(u); if (!s || !t || s.pid || s.botAsk === t || now - t < BOT_WAIT) return; s.botAsk = t; s.emit('botOffer', { game, stake: +stake, max: BOT_MAX }); }); });
}
setInterval(botScan, 2000);
setInterval(() => queue.forEach((_, k) => matchmake(k)), 2000);
function doMove(r, uid, me, m) {   // one move by a person or a bot; every rule check lives here
  if (!r || r.over || !r.started || r.players[r.turn] !== uid) return;
    r.drawBy = null;
    if (r.game === 'ludo') {
      const L = r.ludo, p = r.turn, t = m.t, st = L.seat[p] * 13;
      if (!L.die || !lmov(L, p).includes(t)) return;
      const d = L.die; L.die = null; L.msg = null; let captured = false;
      const n = L.pos[p][t] = L.pos[p][t] < 0 ? 0 : L.pos[p][t] + d;
      if (n <= 50) { const g = (st + n) % 52;
        if (!SAFE.includes(g)) L.pos.forEach((arr, q) => { if (q !== p) L.pos[q] = arr.map(y => { const hit = y >= 0 && y <= 50 && (L.seat[q] * 13 + y) % 52 === g; if (hit) captured = true; return hit ? -1 : y; }); }); }
      if (L.pos[p].every(y => y === 56)) return finish(r, uid, me + ' wins');
      if (captured) L.msg = me + ' captured a piece! Roll again'; else if (d === 6) L.msg = me + ' rolled a six! Roll again';
      if (d !== 6 && !captured) nextTurn(r);   // a six or a capture earns another roll
      return send(r);
    }
    if (r.game === 'checkers') {
      const side = r.turn, from = m.from, to = m.to;
      const mv = ckMoves(r.ck, side, r.mustFrom).find(x => x.from === from && x.to === to); if (!mv) return;
      const res = CK.ckApply(r.ck, side, mv, r.mustFrom); r.ck = res.b; r.lm = [from, to]; r.mustFrom = res.mustFrom;
      if (res.winner != null) return finish(r, uid, me + ' wins');
      if (res.side !== side) nextTurn(r);
      return send(r);
    }
    if (BG.is(r.game)) {   // Connect Four, Gomoku, Reversi: rules live in boardgames.js
      const t = BG.play(r.game, r.board, r.turn, m); if (!t) return;
      r.board = t.board; r.lm = t.lm; r.note = t.note ? r.names[r.turn] + ' ' + t.note : null;
      if (t.over) { r.line = t.over.line; const w = t.over.winner; r.turn = t.next; return finish(r, w == null ? null : r.players[w], w == null ? t.over.text : r.names[w] + ' wins (' + t.over.text + ')'); }
      r.turn = t.next; return send(r);
    }
    if (r.game === 'chess') {
      try { r.chess.move({ from: m.from, to: m.to, promotion: 'q' }); } catch { return; }
      { const now = Date.now(); r.clock[r.turn] += r.inc - (now - r.t0); r.t0 = now; }
      r.lm = [m.from, m.to];
      nextTurn(r);
      if (r.chess.isCheckmate()) return finish(r, uid, me + ' wins by checkmate');
      if (r.chess.isDraw()) return finish(r, null, 'Draw. Stakes refunded');
    } else {
      const i = m.i, b = r.board; if (!(i >= 0 && i < 9) || b[i]) return;
      b[i] = r.turn ? 'O' : 'X'; r.lm = i; nextTurn(r);
      const L = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
      const wl = L.find(l => b[l[0]] && l.every(k => b[k] === b[l[0]])); if (wl) { r.line = wl; return finish(r, uid, me + ' wins'); }
      if (b.every(x => x)) return finish(r, null, 'Draw. Stakes refunded');
    }
    send(r);
}
function doRoll(r, uid) {   // dice are rolled on the server with a cryptographic RNG, for people and bots alike
  if (!r || r.over || r.game !== 'ludo' || !r.started || r.players[r.turn] !== uid || r.ludo.die) return;
    const L = r.ludo, p = r.turn; let d = TEST_DICE.length ? TEST_DICE.shift() : crypto.randomInt(1, 7);
    L.msg = null; L.dry = L.dry || [];
    if (!L.pos[p].some(x => x >= 0)) {   // catch-up rule: all pieces in the yard while an opponent is out => a six within 2 rolls
      const oppOut = L.pos.some((ps, q) => q !== p && !r.out[q] && ps.some(x => x >= 0));
      if (d !== 6 && oppOut && (L.dry[p] || 0) >= 1) d = 6;
      L.dry[p] = d === 6 ? 0 : (L.dry[p] || 0) + 1;
    } else L.dry[p] = 0;
    L.die = L.last = d;
    if (!lmov(L, r.turn).length) { L.die = null; nextTurn(r); }
    send(r);
}
io.on('connection', s => {
  const uid = s.uid; online.set(uid, s); io.emit('online', online.size);
  const me = db.prepare('select name from users where id=?').get(uid).name;
  s.emit('balance', bal(uid)); s.emit('lobby', lobby()); s.emit('live', liveList());
  const back = [...rooms.values()].find(r => r.started && !r.over && r.players.includes(uid));   // reconnect to a game in progress
  if (back) { s.join('r' + back.id); s.rid = back.id; if (back.away) delete back.away[uid]; if (back.seen) back.seen[uid] = true; send(back); }
  const busy = () => { const c = rooms.get(s.rid); return c && !c.over; };
  const find = code => [...rooms.values()].find(r => !r.open && r.code === String(code || '').trim().toUpperCase() && !r.started && r.players.length < r.size);
  s.on('create', ({ game, stake, size, listed, tc, live }, cb) => {
    stake = Math.floor(+stake) || 0;
    if (!GAME_IDS.includes(game) || stake < 0) return;
    if (busy()) return cb?.({ error: 'Finish your current game first' });
    if (stake && !STAKES) return cb?.({ error: 'Real-money play is not open yet. Play a free table.' });
    if (stake && bal(uid) < stake) return cb?.({ error: 'Insufficient balance' });
    const r = { id: rid++, game, stake, size: game === 'ludo' ? Math.min(4, Math.max(2, Math.floor(+size) || 4)) : 2, out: [], ...(game === 'chess' && tcParse(tc)), code: mkCode(), listed: !!listed, live: !!live, started: false, ready: [false], players: [uid], names: [me], turn: 0, over: false };
    const prev = rooms.get(s.rid); if (prev && prev.over) s.to('r' + prev.id).emit('rematch', { code: r.code, by: me, stake });
    hold(r.id, uid, stake);   // the host's stake is held in escrow
    rooms.set(r.id, r); s.join('r' + r.id); s.rid = r.id; pushBal(uid); cb?.({ code: r.code }); io.emit('lobby', lobby()); send(r);
  });
  // ---- Watching live games: spectators get the same board updates, but can never move, chat into the game or see anything private ----
  const stopWatching = () => { if (s.spec) { s.leave('v' + s.spec); s.spec = null; liveTick(); } };
  s.on('spectate', ({ id } = {}, cb) => {
    const c = rooms.get(s.rid); if (c && !c.over && c.players.includes(uid)) return cb?.({ error: 'Finish your current game first' });
    const r = rooms.get(Math.floor(+id)); if (!r || !r.live || !r.started) return cb?.({ error: 'This game is not live any more' });
    if (r.players.includes(uid)) return cb?.({ error: 'You are playing in this game' });
    stopWatching(); s.join('v' + r.id); s.spec = r.id; liveTick(); s.emit('state', view(r)); cb?.({ ok: true });
  });
  s.on('unspectate', () => stopWatching());
  s.on('peek', ({ code }, cb) => {   // show a table's rules before the player agrees to stake
    const r = find(code);
    cb?.(r ? { code: r.code, game: r.game, stake: r.stake, size: r.size, host: r.names[0], n: r.players.length } : { error: 'No open table with that code' });
  });
  s.on('join', ({ code }, cb) => {   // joining = agreeing to the rules and paying the stake
    const r = find(code); if (!r || r.players.includes(uid)) return cb?.({ error: 'No open table with that code' });
    if (busy()) return cb?.({ error: 'Finish your current game first' });
    if (r.stake && bal(uid) < r.stake) return cb?.({ error: 'Insufficient balance. This table needs KES ' + r.stake });
    hold(r.id, uid, r.stake); r.players.push(uid); r.names.push(me); r.ready = r.players.map(() => false);
    s.join('r' + r.id); s.rid = r.id; pushBal(uid); cb?.({ ok: true }); io.emit('lobby', lobby()); send(r);
  });
  s.on('open', ({ game, stake, tc, live } = {}, cb) => {   // create a public table and wait for a challenger
    stake = Math.floor(+stake) || 0;
    if (!GAME_IDS.includes(game) || stake < 0) return cb?.({ error: 'Pick a game' });
    if (busy()) return cb?.({ error: 'Finish your current game first' });
    if (stake && !STAKES) return cb?.({ error: 'Real-money play is not open yet. Play a free table.' });
    if (stake && bal(uid) < stake) return cb?.({ error: 'Insufficient balance' });
    if ([...rooms.values()].filter(x => x.open && !x.started && x.players[0] === uid).length >= MAX_OPEN) return cb?.({ error: 'You can have up to ' + MAX_OPEN + ' open tables at once' });
    const r = { id: rid++, game, stake, size: 2, out: [], ...(game === 'chess' && tcParse(tc)), code: mkCode(), listed: true, open: true, live: !!live, started: false, ready: [true], players: [uid], names: [me], turn: 0, over: false, born: Date.now() };
    hold(r.id, uid, stake); rooms.set(r.id, r); s.join('r' + r.id); pushBal(uid); io.emit('lobby', lobby()); cb?.({ ok: true, id: r.id });   // the host is not pulled into a game screen: he can keep browsing and open more tables
  });
  s.on('cancelTable', ({ id } = {}, cb) => { const r = rooms.get(Math.floor(+id)); if (!r || !r.open || r.started || r.players[0] !== uid) return cb?.({ error: 'That table is gone' }); closeTable(r); cb?.({ ok: true }); });
  s.on('accept', ({ id } = {}, cb) => {   // accept a challenge: both players stake and the game starts at once
    const r = rooms.get(Math.floor(+id)); if (!r || !r.open || r.started || r.players.length >= 2) return cb?.({ error: 'Someone else got there first, or the table was closed' });
    const h = r.players[0]; if (h === uid) return cb?.({ error: 'That is your own table' });
    if (busy()) return cb?.({ error: 'Finish your current game first' });
    const hs0 = online.get(h), hc = hs0 && rooms.get(hs0.rid); if (!hs0 || (hc && !hc.over)) return cb?.({ error: 'That player is busy or offline right now' });
    if (r.stake && bal(uid) < r.stake) return cb?.({ error: 'Insufficient balance. This table needs KES ' + r.stake });
    hold(r.id, uid, r.stake); r.players.push(uid); r.names.push(me); r.ready = [true, true]; r.open = false;
    s.join('r' + r.id); s.rid = r.id; const hs = online.get(h); hs.join('r' + r.id); hs.rid = r.id;
    pushBal(uid); begin(r); hs.emit('challenge', { by: me }); io.emit('lobby', lobby()); send(r); cb?.({ ok: true });
  });
  s.on('ready', v => { const r = rooms.get(s.rid); if (!r || r.started) return; r.ready[r.players.indexOf(uid)] = !!v; send(r); });
  s.on('start', () => {
    const r = rooms.get(s.rid);
    if (!r || r.started || r.players[0] !== uid || r.players.length < 2 || !r.ready.every(Boolean)) return;
    begin(r); io.emit('lobby', lobby()); send(r);
  });
  s.on('move', m => doMove(rooms.get(s.rid), uid, me, m));
  s.on('roll', () => doRoll(rooms.get(s.rid), uid));
  s.on('find', ({ game, stake, size }, cb) => {
    stake = Math.floor(+stake) || 0; const n = game === 'ludo' ? Math.min(4, Math.max(2, Math.floor(+size) || 2)) : 2;
    if (!GAME_IDS.includes(game) || stake < 0) return;
    if (busy() || s.pid) return cb?.({ error: 'Finish your current game first' });
    if (stake && !STAKES) return cb?.({ error: 'Real-money play is not open yet. Play a free game.' });
    if (stake && bal(uid) < stake) return cb?.({ error: 'Insufficient balance. You need KES ' + stake });
    unq(uid); enqueue(uid, qkey(game, stake, n)); cb?.({ ok: true });
  });
  s.on('playBot', ({ game, stake } = {}, cb) => {
    stake = Math.floor(+stake) || 0;
    if (!BOT_ON || !GAME_IDS.includes(game) || stake < 0 || !botOk(game, stake)) return cb?.({ error: 'Bots only play for free in this game. Wait for a person, or try a free game.' });
    if (busy() || s.pid) return cb?.({ error: 'Finish your current game first' });
    if (stake && !STAKES) return cb?.({ error: 'Real-money play is not open yet.' });
    if (stake && bal(uid) < stake) return cb?.({ error: 'Insufficient balance. You need KES ' + stake });
    if (stake && botLossToday() >= BOT_LOSS) return cb?.({ error: 'The bots are resting right now. Please wait for a person.' });
    if (![2, 3, 4].some(n => (n === 2 || game === 'ludo') && (queue.get(qkey(game, stake, n)) || []).includes(uid))) return cb?.({ error: 'Search for an opponent first' });
    const bot = pickBotUser(stake); if (!bot) return cb?.({ error: 'All bots are busy. Please keep waiting for a person.' });
    unq(uid); s.emit('queue', false);
    const first = crypto.randomInt(0, 2) === 0, players = first ? [uid, bot.id] : [bot.id, uid];
    const r = { id: rid++, game, stake, size: 2, out: [], code: mkCode(), listed: false, started: false, ready: [true, true], players, names: players.map(p => uinfo(p).name), turn: 0, over: false, bots: players.map(p => p === bot.id) };
    rooms.set(r.id, r); players.forEach(p => hold(r.id, p, stake)); s.join('r' + r.id); s.rid = r.id; pushBal(uid);
    begin(r); send(r); cb?.({ ok: true, bot: bot.name });
  });
  s.on('cancelFind', () => { unq(uid); s.emit('queue', false); });
  s.on('accept', ({ id }) => { const p = proposals.get(id); if (p) answer(p, uid, true); });
  s.on('decline', ({ id }) => { const p = proposals.get(id); if (p) answer(p, uid, false); });
  let pubTimes = [];
  s.on('pubhist', (_, cb) => cb?.(pubRows()));
  s.on('pub', ({ text, reply } = {}, cb) => {
    const t = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!t) return cb?.({ error: 'Write a message first' });
    if (PUB_BAD.test(t) || /\d{9,}/.test(t.replace(/[\s.\-+()]/g, ''))) return cb?.({ error: 'Links and phone numbers are not allowed in public chat' });
    const now = Date.now(); pubTimes = pubTimes.filter(x => now - x < 60000);
    if (pubTimes.length && now - pubTimes[pubTimes.length - 1] < 1500) return cb?.({ error: 'Slow down a little' });
    if (pubTimes.length >= 12) return cb?.({ error: 'You are sending too many messages. Please wait a minute.' });
    pubTimes.push(now);
    const rp = reply ? db.prepare('select id from chat where id=?').get(+reply) : null;
    const r = db.prepare('insert into chat(uid,name,text,reply_to) values(?,?,?,?)').run(uid, me, t, rp ? rp.id : null);
    db.prepare('delete from chat where id < ?').run(r.lastInsertRowid - 500);
    io.emit('pubmsg', pubShape(db.prepare('select c.*, p.name pn, p.text pt, p.uid pu from chat c left join chat p on p.id=c.reply_to where c.id=?').get(r.lastInsertRowid))); cb?.({ ok: true });
  });
  s.on('pubdel', ({ id } = {}) => { if (!isAdmin(uid)) return; db.prepare('delete from chat where id=?').run(+id); io.emit('pubdel', +id); });
  s.on('tjoin', ({ room } = {}, cb) => {   // a player steps into their tournament match
    const r = rooms.get(+room); if (!r || !r.mid || r.over || !r.players.includes(uid)) return cb?.({ error: 'This match is no longer available' });
    if (busy() && s.rid !== r.id) return cb?.({ error: 'Finish your current game first' });
    s.join('r' + r.id); s.rid = r.id; r.seen[uid] = true; if (r.away) delete r.away[uid]; send(r); cb?.({ ok: true });
  });
  s.on('legal', ({ sq }, cb) => { const r = rooms.get(s.rid); if (!r || !r.chess || r.over || r.players[r.turn] !== uid || typeof sq !== 'string') return cb?.([]); try { cb?.(r.chess.moves({ square: sq, verbose: true }).map(m => m.to)); } catch { cb?.([]); } });
  let lastChat = 0;
  s.on('chat', t => { const r = rooms.get(s.rid); if (!r || typeof t !== 'string' || !t.trim() || Date.now() - lastChat < 700) return; lastChat = Date.now(); io.to('r' + r.id).emit('chat', { n: me, m: t.slice(0, 200) }); });
  s.on('drawOffer', () => { const r = rooms.get(s.rid); if (!r || !r.started || r.over || r.game === 'ludo' || r.players.length !== 2 || r.drawBy) return; if (r.bots) return s.emit('note', 'The bot declined your draw offer.'); r.drawBy = uid; send(r); });
  s.on('drawAccept', () => { const r = rooms.get(s.rid); if (!r || !r.started || r.over || !r.drawBy || r.drawBy === uid) return; finish(r, null, 'Draw agreed. Stakes refunded'); });
  s.on('resign', () => leave(s));
  s.on('disconnect', () => {
    if (s.spec) liveTick();
    const cur = online.get(uid); if (cur === s) online.delete(uid); else if (cur) return;
    io.emit('online', online.size); unq(uid); if (!online.has(uid)) setTimeout(() => { if (!online.has(uid)) closeOpen(uid); }, 30000);   // a host who disappears does not leave dead tables behind
 [...proposals.values()].filter(p => p.players.includes(uid)).forEach(p => cancelProposal(p, uid));
    const r = rooms.get(s.rid);
    if (r && r.started && !r.over) { (r.away = r.away || {})[uid] = Date.now(); send(r); } else leave(s);   // 60s to reconnect mid-game
  });
});
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Something went wrong. Please try again.' }); });
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));
srv.listen(E.PORT || 3000, () => { console.log('Chess bot: ' + (SF.available() ? 'Stockfish' : 'built-in engine (Stockfish is not installed)')); console.log('GameArena running on port ' + (E.PORT || 3000) + (STAKES ? '' : ' (free play only)')); pay.start(); store.startBackups(db); });
let closing = false;   // a deploy sends SIGTERM: stop taking requests, save one last off-site snapshot, then exit
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, async () => {
  if (closing) return; closing = true; pay.stop(); SF.stop(); srv.close(); setTimeout(() => process.exit(0), 25000).unref();
  try { await store.snapshotNow(db, 'shutdown'); } catch (e) { console.error('Shutdown backup failed:', e.message); }
  try { db.close(); } catch {} process.exit(0);
}));
