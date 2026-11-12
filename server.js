require('dotenv').config(); const crypto = require('crypto');
const express = require('express'), http = require('http'), { Server } = require('socket.io'), Database = require('better-sqlite3'),
  bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), { Chess } = require('chess.js'), daraja = require('./daraja'), messaging = require('./messaging'), paystack = require('./paystack');
const E = process.env, FEE = +E.PLATFORM_FEE || 0.1, SECRET = E.JWT_SECRET || 'dev-secret', CB_SECRET = E.CALLBACK_SECRET || 'dev-callback-secret';
const PROD = E.NODE_ENV === 'production', STAKES = E.STAKES_ENABLED !== '0';
const PAY = E.PAYMENT_PROVIDER === 'daraja' ? 'daraja' : 'paystack', GOOGLE_ID = E.GOOGLE_CLIENT_ID || '';
const TEST_DICE = !PROD && E.TEST_DICE ? E.TEST_DICE.split(',').map(Number) : [];   // test hook only, ignored in production   // STAKES_ENABLED=0 launches free play only
if (PROD) {   // refuse to run live with unsafe settings
  const bad = [];
  if (!E.JWT_SECRET || E.JWT_SECRET.length < 32 || /put-a-long|change-me|dev-secret/.test(E.JWT_SECRET)) bad.push('JWT_SECRET must be a random string of 32+ characters (run: npm run secret)');
  if (E.DEV_SHOW_CODES === '1') bad.push('Remove DEV_SHOW_CODES from .env');
  if (!/^https:\/\//.test(E.BASE_URL || '')) bad.push('BASE_URL must be your public https address');
  if (STAKES && PAY === 'daraja' && (!E.CALLBACK_SECRET || E.CALLBACK_SECRET.length < 16)) bad.push('CALLBACK_SECRET must be set (run: npm run secret)');
  if (STAKES && PAY === 'daraja' && (!E.DARAJA_CONSUMER_KEY || !E.DARAJA_PASSKEY)) bad.push('Daraja keys are missing (or set STAKES_ENABLED=0 to launch with free play only)');
  if (STAKES && PAY === 'paystack' && !E.PAYSTACK_SECRET_KEY) bad.push('PAYSTACK_SECRET_KEY is missing (or set STAKES_ENABLED=0 to launch with free play only)');
  if (!E.AT_API_KEY && !E.SMTP_HOST) bad.push('Set up SMS (AT_API_KEY) or email (SMTP_HOST) so verification codes can be sent');
  if (bad.length) { console.error('\nCannot start in production:\n - ' + bad.join('\n - ') + '\n'); process.exit(1); }
  if (STAKES && PAY === 'daraja' && E.DARAJA_ENV !== 'production') console.warn('WARNING: DARAJA_ENV is not "production", so no real money will move.');
  if (STAKES && PAY === 'paystack' && !/^sk_live_/.test(E.PAYSTACK_SECRET_KEY || '')) console.warn('WARNING: PAYSTACK_SECRET_KEY is not a live key (sk_live_...), so no real money will move.');
  if (STAKES && !E.LICENCE_NO) console.warn('WARNING: LICENCE_NO is not set. Do not accept real-money play without a Gambling Regulatory Authority (GRA) licence.');
}
const db = new Database(E.DB_FILE || 'data.db');
db.exec(`create table if not exists users(id integer primary key, phone text unique, name text, hash text, balance integer default 0);
create table if not exists txs(id integer primary key, uid integer, type text, amount integer, ref text, status text default 'pending', created text default current_timestamp)`);
for (const c of ['dob text', 'daily_limit integer default 0', 'excluded_until text', 'rating integer default 1000', "kyc text default 'none'", 'id_number text', 'kyc_photo text', 'ip text', 'email text', "channel text default 'sms'", 'verified integer default 0', 'tv integer default 0']) try { db.exec('alter table users add column ' + c); } catch {}
db.exec(`create table if not exists plays(id integer primary key, uid integer, game text, stake integer, result text, net integer, pair text, created text default current_timestamp);
create table if not exists ledger(id integer primary key, uid integer, amount integer, note text, created text default current_timestamp);
create table if not exists otps(id integer primary key, key text, purpose text, code_hash text, payload text, expires integer, attempts integer default 0, sent_at integer);
create table if not exists tournaments(id integer primary key, uid integer, name text, game text, fee integer default 0, g integer default 2, size integer, rounds integer, tc text, status text default 'open', pool integer default 0, winner integer, created text default current_timestamp, started text);
create table if not exists t_players(tid integer, uid integer, primary key(tid, uid));
create table if not exists t_matches(id integer primary key, tid integer, round integer, idx integer, players text, winner integer, room integer, status text default 'pending', draws integer default 0);
create table if not exists chat(id integer primary key, uid integer, name text, text text, reply_to integer, created text default current_timestamp);
create table if not exists tickets(id integer primary key, uid integer, msg text, status text default 'open', created text default current_timestamp);
create table if not exists house(id integer primary key, amount integer, created text default current_timestamp);
create table if not exists flags(id integer primary key, note text, created text default current_timestamp)`);
db.exec("insert into ledger(uid,amount,note) select id,balance,'opening balance' from users where balance!=0 and id not in (select uid from ledger)");
try { db.exec('create unique index if not exists ux_email on users(email) where email is not null'); } catch {}
const app = express(); app.set('trust proxy', 1); app.use(express.json({ limit: '4mb', verify: (req, res, buf) => { req.rawBody = buf; } })); app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
  if (PROD) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'); next(); });
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
const norm = p => { p = String(p).replace(/\D/g, ''); return p.startsWith('0') ? '254' + p.slice(1) : p.startsWith('254') ? p : '254' + p; };
const tok = id => jwt.sign({ id, tv: db.prepare('select tv from users where id=?').get(id)?.tv || 0 }, SECRET, { expiresIn: '7d' });   // tv changes when the password is reset, which signs out other devices
const auth = (req, res, next) => { try { const p = jwt.verify((req.headers.authorization || '').slice(7), SECRET), row = db.prepare('select tv from users where id=?').get(p.id); if (!row || (row.tv || 0) !== (p.tv || 0)) throw new Error('stale login'); req.uid = p.id; next(); } catch { res.status(401).json({ error: 'login' }); } };
const bal = id => db.prepare('select balance from users where id=?').get(id).balance;
const add = (id, n, note = n > 0 ? 'credit' : 'debit') => { db.prepare('update users set balance=balance+? where id=?').run(n, id); if (n) db.prepare('insert into ledger(uid,amount,note) values(?,?,?)').run(id, n, note); };   // every wallet change is logged
const phoneOf = id => db.prepare('select phone from users where id=?').get(id)?.phone;
const REVIEW = +E.WITHDRAW_REVIEW_OVER || 5000, isAdmin = id => (E.ADMIN_PHONES || '').split(',').filter(Boolean).map(norm).includes(phoneOf(id));

const cbAuth = (req, res, next) => req.params.secret === CB_SECRET ? next() : res.status(403).end();   // only Safaricom (who knows the secret URL) can credit wallets
const hits = new Map(), fails = new Map();   // fails: wrong-password times per phone   // simple in-memory rate limiter
const limit = (n, ms) => (req, res, next) => { const k = req.ip + req.baseUrl + req.path, now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < ms);
  if (a.length >= n) return res.status(429).json({ error: 'Too many attempts. Please wait a minute.' }); a.push(now); hits.set(k, a); next(); };
app.use(['/api/login', '/api/register', '/api/otp', '/api/reset'], limit(30, 60000));   // per endpoint, per IP (many phones share one IP on mobile networks) app.use(['/api/deposit', '/api/withdraw'], limit(12, 60000)); app.use('/api/tournaments', limit(60, 60000));
app.get('/api/leaderboard', (req, res) => res.json(db.prepare("select name, rating from users u order by rating desc limit 10").all()));
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
app.get('/api/admin/summary', auth, admin, (req, res) => {
  const n = q => db.prepare(q).get().v;
  res.json({ users: n('select count(*) v from users'), balances: n('select coalesce(sum(balance),0) v from users'),
    deposits: n("select coalesce(sum(amount),0) v from txs where type='deposit' and status='done'"),
    withdrawals: n("select coalesce(sum(amount),0) v from txs where type='withdraw' and status='done'"),
    fees: n('select coalesce(sum(amount),0) v from house'),
    mismatch: n("select count(*) v from users u where balance != (select coalesce(sum(amount),0) from ledger where uid=u.id)"),
    depositors: n("select count(distinct uid) v from txs where type='deposit' and status='done'"),
    active: n("select count(distinct uid) v from plays where created > datetime('now','-1 day')"),
    byGame: db.prepare('select game, count(*) plays, coalesce(sum(stake),0) staked from plays group by game').all(),
    kyc: db.prepare("select id, name, phone, id_number from users where kyc='pending'").all(),
    tickets: db.prepare("select t.id, t.msg, t.created, u.name, u.phone from tickets t join users u on u.id=t.uid where t.status='open' order by t.id").all(),
    review: db.prepare("select t.id, t.amount, t.created, u.name, u.phone from txs t join users u on u.id=t.uid where t.type='withdraw' and t.status='review' order by t.id").all(),
    stuck: db.prepare("select t.id, t.amount, t.created, u.phone from txs t join users u on u.id=t.uid where t.type='withdraw' and t.status='pending' and t.created < datetime('now','-1 hour')").all(),
    flags: db.prepare('select note, created from flags order by id desc limit 20').all() });
});
// ---- Paystack: webhook (authoritative), status check, payouts ----
const vAt = new Map();
function settleDeposit(t, d) {   // d = Paystack transaction data, from the webhook or from the verify call
  if (!t || t.status !== 'pending') return;
  if (d.status === 'success') {
    if (d.amount !== t.amount * 100 || (d.currency && d.currency !== 'KES')) {
      db.prepare("update txs set status='review' where id=?").run(t.id);
      db.prepare('insert into flags(note) values(?)').run('Deposit amount mismatch on tx ' + t.id + ': expected ' + t.amount * 100 + ', Paystack said ' + d.amount + ' ' + d.currency); return; }
    db.prepare("update txs set status='done' where id=?").run(t.id); add(t.uid, t.amount, 'M-Pesa deposit'); pushBal(t.uid);
  } else if (['failed', 'abandoned', 'reversed'].includes(d.status)) { db.prepare("update txs set status='failed' where id=?").run(t.id); pushBal(t.uid); }
}
function settleTransfer(t, status) {
  if (!t) return;
  if (status === 'success' && t.status === 'pending') { db.prepare("update txs set status='done' where id=?").run(t.id); pushBal(t.uid); }
  else if (status === 'success' && t.status === 'failed') db.prepare('insert into flags(note) values(?)').run('Paystack paid withdrawal tx ' + t.id + ' that was already refunded to the wallet. Check this account.');
  else if (status !== 'success' && ['pending', 'done'].includes(t.status)) { db.prepare("update txs set status='failed' where id=?").run(t.id); add(t.uid, t.amount, 'withdrawal failed, refunded'); pushBal(t.uid); }
}
app.post('/api/paystack/webhook', (req, res) => {
  const sig = String(req.headers['x-paystack-signature'] || ''), want = crypto.createHmac('sha512', E.PAYSTACK_SECRET_KEY || '').update(req.rawBody || '').digest('hex');
  if (!E.PAYSTACK_SECRET_KEY || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return res.status(401).end();
  res.sendStatus(200);
  const { event, data } = req.body || {}; if (!data || !data.reference) return;
  const dep = () => db.prepare("select * from txs where ref=? and type='deposit'").get(data.reference), wd = () => db.prepare("select * from txs where ref=? and type='withdraw'").get(data.reference);
  if (event === 'charge.success') settleDeposit(dep(), { ...data, status: 'success' });
  else if (event === 'charge.failed') settleDeposit(dep(), { status: 'failed' });
  else if (event === 'transfer.success') settleTransfer(wd(), 'success');
  else if (event === 'transfer.failed' || event === 'transfer.reversed') settleTransfer(wd(), 'failed');
});
app.get('/api/pay/status/:ref', auth, async (req, res) => {   // the page polls this after a deposit
  const t = db.prepare("select * from txs where ref=? and uid=? and type='deposit'").get(req.params.ref, req.uid); if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.status === 'pending' && PAY === 'paystack' && Date.now() - (vAt.get(t.ref) || 0) > 8000) {   // webhook late or missed: ask Paystack directly
    vAt.set(t.ref, Date.now()); try { settleDeposit(t, await paystack.verify(t.ref)); } catch {} }
  res.json({ status: db.prepare('select status from txs where id=?').get(t.id).status });
});
async function sendPayout(t) {   // t = a withdrawal row; returns the provider reference
  const u = db.prepare('select name, phone from users where id=?').get(t.uid);
  if (PAY === 'daraja') return (await daraja.b2c(u.phone, t.amount, t.id)).ConversationID;
  const ref = 'wd_' + t.id + '_' + crypto.randomBytes(3).toString('hex');
  db.prepare('update txs set ref=? where id=?').run(ref, t.id);   // saved first so the transfer webhook can find it
  const rc = await paystack.recipient(u.name, u.phone), d = await paystack.transfer(rc.recipient_code, t.amount, ref);
  if (d.status === 'otp') throw new Error('PAYOUT_OTP');   // transfer OTP is switched on in the Paystack dashboard
  return ref;
}
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
    res.json({ token: tok(u.lastInsertRowid) }); }
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
app.post('/api/admin/withdrawal', auth, admin, async (req, res) => {
  const t = db.prepare("select * from txs where id=? and type='withdraw' and status='review'").get(+req.body.id); if (!t) return res.status(404).json({ error: 'Not found' });
  if (req.body.action === 'reject') { db.prepare("update txs set status='rejected' where id=?").run(t.id); add(t.uid, t.amount, 'withdrawal rejected'); pushBal(t.uid); return res.json({ ok: true }); }
  try { const ref = await sendPayout(t); db.prepare("update txs set status='pending', ref=? where id=?").run(ref, t.id); res.json({ ok: true }); }
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
  try { res.json({ ok: true, ...await issueOtp(ph, 'signup', { phone: ph, name: String(name || 'Player').slice(0, 20), hash: bcrypt.hashSync(password, 10), dob, email: em || null, channel: ch, ip: req.ip }, ch, ch === 'email' ? em : ph) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/register/verify', (req, res) => {
  const r = checkOtp(norm(req.body.phone || ''), 'signup', req.body.code); if (r.error) return res.status(400).json(r);
  const p = r.payload;
  try { const u = db.prepare('insert into users(phone,name,hash,dob,email,channel,verified,ip) values(?,?,?,?,?,?,1,?)').run(p.phone, p.name, p.hash, p.dob, p.email, p.channel, p.ip); res.json({ token: tok(u.lastInsertRowid) }); }
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
app.get('/api/me', auth, (req, res) => res.json({ ...db.prepare('select id,name,phone,balance,rating,daily_limit,excluded_until,kyc from users where id=?').get(req.uid), admin: isAdmin(req.uid) }));

// ---- Deposit (M-Pesa STK Push) ----
app.post('/api/deposit', auth, async (req, res) => {
  const amt = Math.floor(+req.body.amount); if (!STAKES) return res.status(403).json({ error: 'Deposits are not open yet' });
  if (!(amt >= 10)) return res.status(400).json({ error: 'Minimum KES 10' });
  const u0 = db.prepare('select daily_limit dl, excluded_until ex from users where id=?').get(req.uid);
  if (u0.ex && u0.ex > new Date().toISOString()) return res.status(403).json({ error: 'Your account is on a self-exclusion break' });
  if (u0.dl) { const used = db.prepare("select coalesce(sum(amount),0) s from txs where uid=? and type='deposit' and status!='failed' and date(created)=date('now')").get(req.uid).s;
    if (used + amt > u0.dl) return res.status(400).json({ error: 'This would exceed your daily deposit limit of KES ' + u0.dl }); }
  if (PAY === 'paystack') {   // Paystack sends the M-Pesa prompt; the webhook (or the status check) credits the wallet
    const u1 = db.prepare('select phone, email from users where id=?').get(req.uid), ref = 'dep_' + req.uid + '_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
    const tx = db.prepare('insert into txs(uid,type,amount,ref) values(?,?,?,?)').run(req.uid, 'deposit', amt, ref);   // saved first so a fast webhook can find it
    try { const d = await paystack.chargeMpesa(u1.email || u1.phone + '@pay.stakearena.app', u1.phone, amt, ref); return res.json({ ok: true, ref, message: d.display_text || 'Check your phone and enter your M-Pesa PIN' }); }
    catch (e) { db.prepare("update txs set status='failed' where id=?").run(tx.lastInsertRowid); return res.status(400).json({ error: e.message }); }
  }
  try { const r = await daraja.stk(phoneOf(req.uid), amt);
    db.prepare('insert into txs(uid,type,amount,ref) values(?,?,?,?)').run(req.uid, 'deposit', amt, r.CheckoutRequestID); res.json({ ok: true, ref: r.CheckoutRequestID }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/daraja/stk-callback/:secret', cbAuth, (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'ok' });
  const cb = req.body?.Body?.stkCallback; if (!cb) return;
  const t = db.prepare("select * from txs where ref=? and status='pending'").get(cb.CheckoutRequestID); if (!t) return;
  const paid = Math.round(+cb.CallbackMetadata?.Item?.find(i => i.Name === 'Amount')?.Value);
  if (cb.ResultCode === 0 && paid !== t.amount) { db.prepare("update txs set status='review' where id=?").run(t.id); db.prepare('insert into flags(note) values(?)').run('Deposit amount mismatch on tx ' + t.id + ': expected ' + t.amount + ', callback said ' + paid); return; }
  if (cb.ResultCode === 0) { db.prepare("update txs set status='done' where id=?").run(t.id); add(t.uid, t.amount, 'M-Pesa deposit'); pushBal(t.uid); }
  else db.prepare("update txs set status='failed' where id=?").run(t.id);
});
// ---- Withdraw (M-Pesa B2C) ----
app.post('/api/withdraw', auth, async (req, res) => {
  const amt = Math.floor(+req.body.amount);
  if (!(amt >= 50)) return res.status(400).json({ error: 'Minimum KES 50' });
  if (amt > 150000) return res.status(400).json({ error: 'Maximum KES 150,000 per withdrawal' });
  if (bal(req.uid) < amt) return res.status(400).json({ error: 'Insufficient balance' });
  add(req.uid, -amt, 'withdrawal');
  const r = db.prepare('insert into txs(uid,type,amount,ref) values(?,?,?,?)').run(req.uid, 'withdraw', amt, '');
  if (amt >= REVIEW) { db.prepare("update txs set status='review' where id=?").run(r.lastInsertRowid); pushBal(req.uid); return res.json({ ok: true, review: true }); }
  try { const ref = await sendPayout({ id: r.lastInsertRowid, uid: req.uid, amount: amt });
    db.prepare('update txs set ref=? where id=?').run(ref, r.lastInsertRowid); pushBal(req.uid); res.json({ ok: true }); }
  catch (e) { add(req.uid, amt, 'withdrawal failed, refunded'); db.prepare("update txs set status='failed' where id=?").run(r.lastInsertRowid); pushBal(req.uid); console.error('Payout failed:', e.message); res.status(500).json({ error: e.message === 'PAYOUT_OTP' ? 'Payouts are temporarily unavailable. Please try again later.' : e.message }); }
});
app.post('/api/daraja/b2c-result/:secret', cbAuth, (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'ok' });
  const r = req.body?.Result; if (!r) return;
  const t = db.prepare("select * from txs where type='withdraw' and ref=? and status='pending'").get(r.ConversationID); if (!t) return;
  if (r.ResultCode === 0) db.prepare("update txs set status='done' where id=?").run(t.id);
  else { db.prepare("update txs set status='failed' where id=?").run(t.id); add(t.uid, t.amount, 'withdrawal failed, refunded'); pushBal(t.uid); }
});
app.post('/api/daraja/b2c-timeout/:secret', cbAuth, (req, res) => res.json({ ResultCode: 0 }));

// ---- Multiplayer games ----
const rooms = new Map(), online = new Map(); let rid = 1;
// Ludo (2 players, 4 tokens each). pos: -1 yard, 0-50 main track, 51-55 home lane, 56 home.
const SAFE = [0, 8, 13, 21, 26, 34, 39, 47];
// Checkers (American rules: forced captures, multi-jumps, kings). Board = 64 cells; w/W = player 1, b/B = player 2.
const ckSide = p => p.toLowerCase() === 'w' ? 0 : 1;
const ckDirs = p => p === 'w' ? [[-1,-1],[-1,1]] : p === 'b' ? [[1,-1],[1,1]] : [[-1,-1],[-1,1],[1,-1],[1,1]];
function ckMoves(b, side, only) {
  const caps = [], steps = [];
  for (let i = 0; i < 64; i++) {
    const p = b[i]; if (!p || ckSide(p) !== side || (only != null && i !== only)) continue;
    for (const [dr, dc] of ckDirs(p)) {
      const r1 = (i >> 3) + dr, c1 = (i & 7) + dc; if (r1 < 0 || r1 > 7 || c1 < 0 || c1 > 7) continue;
      const j = r1 * 8 + c1;
      if (!b[j]) steps.push({ from: i, to: j });
      else if (ckSide(b[j]) !== side) { const r2 = r1 + dr, c2 = c1 + dc; if (r2 >= 0 && r2 < 8 && c2 >= 0 && c2 < 8 && !b[r2 * 8 + c2]) caps.push({ from: i, to: r2 * 8 + c2, cap: j }); }
    }
  }
  return caps.length ? caps : (only != null ? [] : steps);
}
const tcParse = tc => { const [m, i] = String(tc || '10+0').split('+').map(Number), ok = m > 0 && m <= 60 && i >= 0 && i <= 60, M = ok ? m : 10, I = ok ? i : 0; return { clock: [M * 6e4, M * 6e4], inc: I * 1e3, tc: M + '+' + I }; };
const mkCode = () => { let c; do c = crypto.randomBytes(3).toString('hex').toUpperCase(); while ([...rooms.values()].some(r => r.code === c)); return c; };
const nextTurn = r => { do r.turn = (r.turn + 1) % r.players.length; while (r.out[r.turn]); };
const lmov = (L, p) => L.pos[p].map((x, t) => (x < 0 ? L.die === 6 : x + L.die <= 56) ? t : -1).filter(t => t >= 0);
function pushBal(uid) { const s = online.get(uid); if (s) s.emit('balance', bal(uid)); }
io.use((s, next) => { try { const p = jwt.verify(s.handshake.auth.token, SECRET); s.uid = p.id; const row = db.prepare('select excluded_until e, tv from users where id=?').get(s.uid); if ((row.tv || 0) !== (p.tv || 0)) throw new Error('stale'); const ex = row.e; if (ex && ex > new Date().toISOString()) return next(new Error('excluded')); next(); } catch { next(new Error('auth')); } });
const lobby = () => [...rooms.values()].filter(r => r.listed && !r.started && r.players.length < r.size).map(r => ({ code: r.code, id: r.id, game: r.game, stake: r.stake, by: r.names[0], n: r.players.length, size: r.size }));
const view = r => ({ id: r.id, game: r.game, stake: r.stake, ck: r.ck, ckm: r.ck && !r.over ? ckMoves(r.ck, r.turn, r.mustFrom) : [], left: r.started && !r.over ? Math.max(0, r.deadline - Date.now()) : null, tid: r.tid, tnote: r.tnote, lm: r.lm, chk: !!(r.chess && r.chess.inCheck()), line: r.line, winner: r.winner, pay: r.pay, drawBy: r.drawBy, tc: r.tc, clk: r.clock && r.started && !r.over ? r.clock.map((v, i) => i === r.turn ? Math.max(0, r.deadline - Date.now()) : v) : null, code: r.code, started: r.started, ready: r.ready, size: r.size, out: r.out, names: r.names, players: r.players, over: r.over, result: r.result, turn: r.turn, fen: r.chess ? r.chess.fen() : null, board: r.board, ludo: r.ludo ? { msg: r.ludo.msg, seat: r.ludo.seat, pos: r.ludo.pos, die: r.ludo.die, last: r.ludo.last, movable: r.ludo.die ? lmov(r.ludo, r.turn) : [] } : null });
const TURN = { chess: 120000, checkers: 60000, ludo: 30000, tictactoe: 20000 };   // per-move time limits
const send = r => { if (r.started && !r.over) r.deadline = r.clock ? r.t0 + r.clock[r.turn] : Date.now() + TURN[r.game]; io.to('r' + r.id).emit('state', view(r)); };
function finish(r, winner, text) {   // winner = user id, or null for a draw (stakes refunded)
  if (r.over) return; r.over = true; r.result = text;
  const pot = r.stake * r.players.length, pay = Math.floor(pot * (1 - FEE)); r.winner = winner; r.pay = pay;
  if (r.stake) { winner == null ? r.players.forEach(p => add(p, r.stake, 'draw refund')) : add(winner, pay, 'winnings'); r.players.forEach(pushBal); if (winner != null) db.prepare('insert into house(amount) values(?)').run(pot - pay); }
  const pair = r.players.length === 2 ? r.players.slice().sort().join('-') : null;
  r.players.forEach(p => { const res = winner == null ? 'draw' : p === winner ? 'win' : 'loss';
    db.prepare('insert into plays(uid,game,stake,result,net,pair) values(?,?,?,?,?,?)').run(p, r.game, r.stake, res, res === 'win' ? pay - r.stake : res === 'loss' ? -r.stake : 0, pair); });
  if (winner != null) { const W = db.prepare('select rating from users where id=?').get(winner).rating; let gain = 0;
    r.players.forEach(p => { if (p === winner) return; const L = db.prepare('select rating from users where id=?').get(p).rating;
      const d = Math.round(24 / (1 + Math.pow(10, (W - L) / 400))); gain += d; db.prepare('update users set rating=max(100,rating-?) where id=?').run(d, p); });
    db.prepare('update users set rating=rating+? where id=?').run(gain, winner); }
  if (r.stake && pair) { const ips = r.players.map(p => db.prepare('select ip from users where id=?').get(p).ip); if (ips[0] && ips[0] === ips[1]) db.prepare('insert into flags(note) values(?)').run('Same IP: accounts ' + pair + ' played a staked game from one address'); }
  if (r.stake && pair) { const n = db.prepare("select count(*) c from plays where pair=? and stake>0 and created>datetime('now','-1 day')").get(pair).c / 2;
    if (n >= 5) db.prepare('insert into flags(note) values(?)').run('Possible collusion: accounts ' + pair + ' played ' + n + ' staked games in 24h'); }
  if (r.mid) tMatchDone(r, winner);
  send(r); setTimeout(() => rooms.delete(r.id), 60000);
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
  r.started = true; const n = r.players.length;
  if (r.game === 'chess') { r.chess = new Chess(); if (!r.clock) { r.clock = [6e5, 6e5]; r.inc = 0; } r.t0 = Date.now(); }
  else if (r.game === 'ludo') r.ludo = { pos: r.players.map(() => [-1, -1, -1, -1]), die: null, last: null, seat: n === 2 ? [0, 2] : [0, 1, 2, 3].slice(0, n) };
  else if (r.game === 'checkers') { r.ck = Array.from({ length: 64 }, (_, i) => ((i >> 3) + (i & 7)) & 1 ? ((i >> 3) < 3 ? 'b' : (i >> 3) > 4 ? 'w' : 0) : 0); r.mustFrom = null; }
  else r.board = Array(9).fill('');
}
function leave(s) {
  const r = rooms.get(s.rid); s.rid = null; if (!r) return;
  const i = r.players.indexOf(s.uid); if (i < 0) return;
  s.leave('r' + r.id);
  if (r.over) return;
  if (!r.started) {            // game not started: refund and remove the player
    if (r.stake) add(s.uid, r.stake, 'stake refund'); pushBal(s.uid);
    r.players.splice(i, 1); r.names.splice(i, 1); r.ready.splice(i, 1); r.ready = r.ready.map(() => false);
    if (!r.players.length) rooms.delete(r.id); else send(r);
    return io.emit('lobby', lobby());
  }
  forfeit(r, i);
}
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
  p.players.forEach(u => { add(u, -p.stake, 'stake'); const ps = online.get(u); ps.join('r' + r.id); ps.rid = r.id; ps.pid = null; ps.emit('queue', false); pushBal(u); });
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
  const r = { id: rid++, game: t.game, stake: 0, size: ps.length, out: [], code: mkCode(), listed: false, started: false, ready: ps.map(() => true), players: ps, names: ps.map(tn), turn: 0, over: false, tid: t.id, mid: m.id, seen: {}, born: Date.now(), ...(t.game === 'chess' && tcParse(t.tc)) };
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
    db.prepare("update tournaments set status='done', winner=? where id=?").run(winner, t.id);
    if (prize) add(winner, prize, 'tournament prize');
    if (pool - prize) db.prepare('insert into house(amount) values(?)').run(pool - prize);
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
  if (t.fee) add(uid, -t.fee, 'tournament entry');
  db.prepare('insert into t_players(tid,uid) values(?,?)').run(tid, uid); db.prepare('update tournaments set pool=pool+? where id=?').run(t.fee, tid); pushBal(uid);
  if (ps.length + 1 === t.size) startTournament(db.prepare('select * from tournaments where id=?').get(tid));
  tPush(tid); return null;
}
function leaveT(tid, uid) {
  const t = db.prepare('select * from tournaments where id=?').get(tid); if (!t || t.status !== 'open') return 'You can only leave before the tournament starts';
  if (!tPlayers(tid).includes(uid)) return 'You are not in this tournament';
  db.prepare('delete from t_players where tid=? and uid=?').run(tid, uid);
  if (t.fee) { add(uid, t.fee, 'tournament entry refund'); db.prepare('update tournaments set pool=pool-? where id=?').run(t.fee, tid); }
  pushBal(uid); tPush(tid); return null;
}
function cancelT(tid) {
  const t = db.prepare('select * from tournaments where id=?').get(tid); if (!t || t.status !== 'open') return 'Only a tournament that has not started can be cancelled';
  tPlayers(tid).forEach(u => { if (t.fee) { add(u, t.fee, 'tournament entry refund'); pushBal(u); } });
  db.prepare("update tournaments set status='cancelled', pool=0 where id=?").run(tid); tPush(tid); return null;
}
app.get('/api/tournaments', auth, (req, res) => {
  const rows = db.prepare("select t.*, u.name cname, w.name wname from tournaments t join users u on u.id=t.uid left join users w on w.id=t.winner where t.status in ('open','running') or (t.status='done' and t.started > datetime('now','-3 days')) order by case t.status when 'open' then 0 when 'running' then 1 else 2 end, t.id desc limit 40").all();
  res.json(rows.map(t => { const ps = tPlayers(t.id); return { id: t.id, name: t.name, game: t.game, fee: t.fee, g: t.g, size: t.size, n: ps.length, status: t.status, creator: t.cname, mine: t.uid === req.uid, joined: ps.includes(req.uid), prize: tPrize(t.fee * t.size), winner: t.wname, tc: t.tc }; }));
});
app.get('/api/tournaments/:id', auth, (req, res) => {
  const t = db.prepare('select t.*, u.name cname from tournaments t join users u on u.id=t.uid where t.id=?').get(+req.params.id); if (!t) return res.status(404).json({ error: 'Tournament not found' });
  const ps = tPlayers(t.id), ms = db.prepare('select * from t_matches where tid=? order by round, idx').all(t.id).map(m => { const pl = JSON.parse(m.players);
    return { id: m.id, round: m.round, idx: m.idx, status: m.status, winner: m.winner, players: pl.map(u => ({ id: u, name: tn(u) })), room: m.status === 'live' && pl.includes(req.uid) && rooms.has(m.room) ? m.room : null }; });
  res.json({ id: t.id, name: t.name, game: t.game, fee: t.fee, g: t.g, size: t.size, rounds: t.rounds, status: t.status, creator: t.cname, mine: t.uid === req.uid, joined: ps.includes(req.uid), players: ps.map(u => ({ id: u, name: tn(u) })), prize: tPrize(t.fee * t.size), feeRate: TFEE, winner: t.winner, wname: t.winner ? tn(t.winner) : null, tc: t.tc, matches: ms });
});
app.post('/api/tournaments', auth, (req, res) => {
  const b = req.body, game = b.game, name = String(b.name || '').trim().slice(0, 40), fee = Math.floor(+b.fee) || 0, size = Math.floor(+b.size);
  const g = game === 'ludo' ? Math.min(4, Math.max(2, Math.floor(+b.g) || 2)) : 2, bad = m => res.status(400).json({ error: m });
  if (!['chess', 'checkers', 'tictactoe', 'ludo'].includes(game)) return bad('Pick a game');
  if (name.length < 3) return bad('Give the tournament a name of at least 3 letters');
  if (!T_SIZES[g].includes(size)) return bad('For ' + g + ' players per match the size must be one of: ' + T_SIZES[g].join(', '));
  if (fee < 0 || (fee > 0 && fee < 10) || fee > 100000) return bad('The entry fee must be 0, or between KES 10 and KES 100,000');
  if (fee > 0 && !STAKES) return bad('Real-money play is not open yet. Create a free tournament.');
  if (excluded(req.uid)) return bad('Your account is on a self-exclusion break');
  if (db.prepare("select count(*) c from tournaments where uid=? and status='open'").get(req.uid).c >= 3) return bad('You already have 3 open tournaments');
  if (b.enter !== false && fee && bal(req.uid) < fee) return bad('Insufficient balance to enter your own tournament (KES ' + fee + ')');
  const rounds = Math.round(Math.log(size) / Math.log(g)), tc = game === 'chess' ? tcParse(b.tc).tc : null;
  const id = db.prepare('insert into tournaments(uid,name,game,fee,g,size,rounds,tc) values(?,?,?,?,?,?,?,?)').run(req.uid, name, game, fee, g, size, rounds, tc).lastInsertRowid;
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
setInterval(() => queue.forEach((_, k) => matchmake(k)), 2000);
io.on('connection', s => {
  const uid = s.uid; online.set(uid, s); io.emit('online', online.size);
  const me = db.prepare('select name from users where id=?').get(uid).name;
  s.emit('balance', bal(uid)); s.emit('lobby', lobby());
  const back = [...rooms.values()].find(r => r.started && !r.over && r.players.includes(uid));   // reconnect to a game in progress
  if (back) { s.join('r' + back.id); s.rid = back.id; if (back.away) delete back.away[uid]; if (back.seen) back.seen[uid] = true; send(back); }
  const busy = () => { const c = rooms.get(s.rid); return c && !c.over; };
  const find = code => [...rooms.values()].find(r => r.code === String(code || '').trim().toUpperCase() && !r.started && r.players.length < r.size);
  s.on('create', ({ game, stake, size, listed, tc }, cb) => {
    stake = Math.floor(+stake) || 0;
    if (!['chess', 'tictactoe', 'ludo', 'checkers'].includes(game) || stake < 0) return;
    if (busy()) return cb?.({ error: 'Finish your current game first' });
    if (stake && !STAKES) return cb?.({ error: 'Real-money play is not open yet. Play a free table.' });
    if (stake && bal(uid) < stake) return cb?.({ error: 'Insufficient balance' });
    add(uid, -stake, 'stake');   // host's stake is held in escrow
    const r = { id: rid++, game, stake, size: game === 'ludo' ? Math.min(4, Math.max(2, Math.floor(+size) || 4)) : 2, out: [], ...(game === 'chess' && tcParse(tc)), code: mkCode(), listed: !!listed, started: false, ready: [false], players: [uid], names: [me], turn: 0, over: false };
    const prev = rooms.get(s.rid); if (prev && prev.over) s.to('r' + prev.id).emit('rematch', { code: r.code, by: me, stake });
    rooms.set(r.id, r); s.join('r' + r.id); s.rid = r.id; pushBal(uid); cb?.({ code: r.code }); io.emit('lobby', lobby()); send(r);
  });
  s.on('peek', ({ code }, cb) => {   // show a table's rules before the player agrees to stake
    const r = find(code);
    cb?.(r ? { code: r.code, game: r.game, stake: r.stake, size: r.size, host: r.names[0], n: r.players.length } : { error: 'No open table with that code' });
  });
  s.on('join', ({ code }, cb) => {   // joining = agreeing to the rules and paying the stake
    const r = find(code); if (!r || r.players.includes(uid)) return cb?.({ error: 'No open table with that code' });
    if (busy()) return cb?.({ error: 'Finish your current game first' });
    if (r.stake && bal(uid) < r.stake) return cb?.({ error: 'Insufficient balance. This table needs KES ' + r.stake });
    add(uid, -r.stake, 'stake'); r.players.push(uid); r.names.push(me); r.ready = r.players.map(() => false);
    s.join('r' + r.id); s.rid = r.id; pushBal(uid); cb?.({ ok: true }); io.emit('lobby', lobby()); send(r);
  });
  s.on('ready', v => { const r = rooms.get(s.rid); if (!r || r.started) return; r.ready[r.players.indexOf(uid)] = !!v; send(r); });
  s.on('start', () => {
    const r = rooms.get(s.rid);
    if (!r || r.started || r.players[0] !== uid || r.players.length < 2 || !r.ready.every(Boolean)) return;
    begin(r); io.emit('lobby', lobby()); send(r);
  });
  s.on('move', m => {
    const r = rooms.get(s.rid); if (!r || r.over || !r.started || r.players[r.turn] !== uid) return;
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
      const b = r.ck, side = r.turn, from = m.from, to = m.to;
      const mv = ckMoves(b, side, r.mustFrom).find(x => x.from === from && x.to === to); if (!mv) return;
      const p = b[from]; b[to] = p; b[from] = 0; let king = false; r.lm = [from, to];
      if ((p === 'w' && (to >> 3) === 0) || (p === 'b' && (to >> 3) === 7)) { b[to] = p.toUpperCase(); king = true; }
      r.mustFrom = null;
      if (mv.cap != null) { b[mv.cap] = 0; if (!king && ckMoves(b, side, to).length) r.mustFrom = to; }
      if (r.mustFrom == null) { nextTurn(r); const o = r.turn;
        if (!b.some(x => x && ckSide(x) === o) || !ckMoves(b, o).length) return finish(r, uid, me + ' wins'); }
      return send(r);
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
  });
  s.on('roll', () => {   // dice are rolled on the server with a cryptographic RNG
    const r = rooms.get(s.rid);
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
  });
  s.on('find', ({ game, stake, size }, cb) => {
    stake = Math.floor(+stake) || 0; const n = game === 'ludo' ? Math.min(4, Math.max(2, Math.floor(+size) || 2)) : 2;
    if (!['chess', 'tictactoe', 'ludo', 'checkers'].includes(game) || stake < 0) return;
    if (busy() || s.pid) return cb?.({ error: 'Finish your current game first' });
    if (stake && !STAKES) return cb?.({ error: 'Real-money play is not open yet. Play a free game.' });
    if (stake && bal(uid) < stake) return cb?.({ error: 'Insufficient balance. You need KES ' + stake });
    unq(uid); enqueue(uid, qkey(game, stake, n)); cb?.({ ok: true });
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
  s.on('drawOffer', () => { const r = rooms.get(s.rid); if (!r || !r.started || r.over || r.game === 'ludo' || r.players.length !== 2 || r.drawBy) return; r.drawBy = uid; send(r); });
  s.on('drawAccept', () => { const r = rooms.get(s.rid); if (!r || !r.started || r.over || !r.drawBy || r.drawBy === uid) return; finish(r, null, 'Draw agreed. Stakes refunded'); });
  s.on('resign', () => leave(s));
  s.on('disconnect', () => {
    const cur = online.get(uid); if (cur === s) online.delete(uid); else if (cur) return;
    io.emit('online', online.size); unq(uid); [...proposals.values()].filter(p => p.players.includes(uid)).forEach(p => cancelProposal(p, uid));
    const r = rooms.get(s.rid);
    if (r && r.started && !r.over) { (r.away = r.away || {})[uid] = Date.now(); send(r); } else leave(s);   // 60s to reconnect mid-game
  });
});
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Something went wrong. Please try again.' }); });
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));
srv.listen(E.PORT || 3000, () => console.log('StakeArena running on port ' + (E.PORT || 3000) + (STAKES ? '' : ' (free play only)')));
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, () => { srv.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); }));
