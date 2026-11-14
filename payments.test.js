// Money-flow tests for deposits and withdrawals against a mock PalPluss server.
// Run: node --test payments.test.js     (uses Node's built-in SQLite, so it needs no packages)
const { test, before, after, beforeEach } = require('node:test'), assert = require('node:assert'), http = require('http');
const { DatabaseSync } = require('node:sqlite');
const KEY = 'pk_test_abc123';
process.env.PALPLUSS_API_KEY = KEY;
const pp = require('./palpluss'), createPayments = require('./payments');
const sleep = ms => new Promise(r => setTimeout(r, ms)), until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(15); } throw new Error('timed out waiting: ' + f); };

// ---------- a fake PalPluss ----------
function mock() {
  const st = { txs: new Map(), calls: [], seq: 0, honorIdem: true, idem: new Map(), stk: null, b2c: null, getFail: null, balance: 5000 };
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const j = b ? JSON.parse(b) : {}, url = new URL(req.url, 'http://x'), send = (code, body, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(body)); };
    const err = (code, c, m = c, details = {}, h = {}) => send(code, { success: false, error: { code: c, message: m, details }, requestId: 'req' }, h);
    st.calls.push({ method: req.method, path: url.pathname, body: j, auth: req.headers.authorization, idem: req.headers['idempotency-key'] });
    if (req.headers.authorization !== 'Basic ' + Buffer.from(KEY + ':').toString('base64')) return err(401, 'INVALID_API_KEY');
    const mk = (type, extra) => { const t = { transactionId: 'T' + ++st.seq, type, status: 'PENDING', currency: 'KES', createdAt: new Date().toISOString(), amount: j.amount, phone: '254' + String(j.phone).replace(/^0|^254/, ''), ...extra }; st.txs.set(t.transactionId, t); return t; };
    if (req.method === 'POST' && url.pathname === '/payments/stk') {
      const m = st.stk; if (m === 'drop') { mk('STK', { accountReference: j.accountReference }); return req.socket.destroy(); }
      if (m) return err(m.status, m.code, m.code, m.details || {}, m.headers || {});
      return send(200, { success: true, data: mk('STK', { accountReference: j.accountReference }), requestId: 'r' });
    }
    if (req.method === 'POST' && url.pathname === '/b2c/payouts') {
      const k = req.headers['idempotency-key']; if (st.honorIdem && k && st.idem.has(k)) return send(200, { success: true, data: st.idem.get(k), requestId: 'r' });
      const m = st.b2c;
      if (m === 'drop') { const t = mk('B2C', { reference: j.reference }); if (k) st.idem.set(k, t); return req.socket.destroy(); }   // paid, but the answer is lost
      if (m === 'lost-before') return req.socket.destroy();                                                                    // never processed
      if (m) return err(m.status, m.code, m.code, m.details || {}, m.headers || {});
      const t = mk('B2C', { reference: j.reference }); if (k) st.idem.set(k, t); return send(200, { success: true, data: t, requestId: 'r' });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/transactions/')) {
      if (st.getFail) return err(st.getFail, 'BOOM'); const t = st.txs.get(decodeURIComponent(url.pathname.split('/').pop())); return t ? send(200, { success: true, data: t, requestId: 'r' }) : err(404, 'TRANSACTION_NOT_FOUND');
    }
    if (req.method === 'GET' && url.pathname === '/transactions') { const items = [...st.txs.values()].filter(t => !url.searchParams.get('type') || t.type === url.searchParams.get('type')).reverse(); return send(200, { success: true, data: { items, nextCursor: null }, requestId: 'r' }); }
    if (req.method === 'GET' && url.pathname === '/wallets/service/balance') return send(200, { success: true, data: { availableBalance: st.balance }, requestId: 'r' });
    err(404, 'NOT_FOUND');
  }); });
  st.set = (id, status, extra = {}) => Object.assign(st.txs.get(id), { status }, extra);
  st.byRef = ref => [...st.txs.values()].find(t => t.accountReference === ref || t.reference === ref);
  st.count = (method, path) => st.calls.filter(c => c.method === method && c.path === path).length;
  return new Promise(r => srv.listen(0, '127.0.0.1', () => { st.srv = srv; st.url = 'http://127.0.0.1:' + srv.address().port; r(st); }));
}

let M, db, P, now, alerts, pushes;
const clock = () => now;
const balance = uid => db.prepare('select balance from users where id=?').get(uid).balance;
const tx = id => db.prepare('select * from txs where id=?').get(id);
const flags = () => db.prepare('select note from flags').all().map(f => f.note);
const checkLedger = () => { const bad = db.prepare('select u.id from users u where u.balance != (select coalesce(sum(amount),0) from ledger where uid=u.id)').all(); assert.deepEqual(bad, [], 'every wallet equals the sum of its ledger'); };
before(async () => { M = await mock(); process.env.PALPLUSS_BASE = M.url; });
after(() => M.srv.close());
beforeEach(() => {
  M.calls.length = 0; M.txs.clear(); M.idem.clear(); M.stk = M.b2c = M.getFail = null; M.honorIdem = true; M.balance = 5000;
  db = new DatabaseSync(':memory:'); now = Date.now(); alerts = []; pushes = [];
  db.exec(`create table users(id integer primary key, phone text, name text, balance integer default 0);
    create table txs(id integer primary key, uid integer, type text, amount integer, ref text, status text default 'pending', created text default current_timestamp);
    create table ledger(id integer primary key, uid integer, amount integer, note text, created text default current_timestamp);
    create table flags(id integer primary key, note text, created text default current_timestamp)`);
  db.exec("insert into users(id,phone,name) values(1,'254711111111','A'),(2,'254722222222','B')");
  const add = (id, n, note) => { db.prepare('update users set balance=balance+? where id=?').run(n, id); db.prepare('insert into ledger(uid,amount,note) values(?,?,?)').run(id, n, note); };
  add(1, 1000, 'opening'); add(2, 1000, 'opening');
  P = createPayments({ db, add, pushBal: u => pushes.push(u), pp, clock, baseUrl: 'https://game.example', secret: 'sekret', alert: t => alerts.push(t), env: { WITHDRAW_REVIEW_OVER: '5000', CALLBACK_SECRET: 'sekret' } });
});

// ---------------- DEPOSITS ----------------
test('deposit: STK request is built correctly and the wallet is credited once, only after PalPluss confirms', async () => {
  const r = await P.startDeposit(1, 300); assert.ok(r.ok && r.id);
  const c = M.calls.find(x => x.path === '/payments/stk');
  assert.equal(c.auth, 'Basic ' + Buffer.from(KEY + ':').toString('base64'), 'API key is sent as Basic auth with an empty password');
  assert.equal(c.body.amount, 300); assert.equal(c.body.phone, '254711111111'); assert.equal(c.body.accountReference, 'D' + r.id); assert.ok(c.body.accountReference.length <= 12); assert.ok(c.body.transactionDesc.length <= 13);
  assert.equal(c.body.callbackUrl, `https://game.example/api/palpluss/webhook/sekret/${r.id}`);
  assert.equal(tx(r.id).status, 'pending'); assert.equal(balance(1), 1000);
  const pid = M.byRef('D' + r.id).transactionId;
  assert.equal(await P.webhook(r.id, { event: 'transaction.updated', transaction: { id: pid, status: 'SUCCESS' } }), 'pending', 'a webhook that says SUCCESS is not believed while PalPluss says PENDING');
  assert.equal(balance(1), 1000);
  M.set(pid, 'SUCCESS');
  assert.equal(await P.webhook(r.id, { transaction: { id: pid } }), 'done'); assert.equal(balance(1), 1300);
  await P.webhook(r.id, { transaction: { id: pid } }); await P.webhook(r.id, {}); await P.tick(); assert.equal(balance(1), 1300, 'repeated webhooks never credit twice');
  assert.ok(pushes.includes(1)); checkLedger();
});
test('deposit: a forged webhook (wrong transaction id) cannot credit anyone', async () => {
  const a = await P.startDeposit(1, 300), b = await P.startDeposit(2, 50);
  const pidB = M.byRef('D' + b.id).transactionId; M.set(pidB, 'SUCCESS');
  await P.webhook(a.id, { transaction: { id: pidB } });   // tries to point user A's deposit at B's successful transaction
  assert.equal(balance(1), 1000, 'nothing is credited'); assert.ok(flags().some(f => /different PalPluss transaction/.test(f)), 'flagged: we already know which PalPluss transaction is ours');
  // harder case: our own transaction id is not known yet (the STK answer was lost), so the forged id is looked up, and its reference gives it away
  db.prepare('update txs set pid=null where id=?').run(a.id); await P.webhook(a.id, { transaction: { id: pidB } });
  assert.equal(balance(1), 1000, 'still nothing credited'); assert.equal(balance(2), 1000); assert.ok(flags().some(f => /does not match deposit/.test(f)), 'flagged: the reference belongs to a different deposit');
});
test('deposit: wrong amount goes to review and is not credited', async () => {
  const r = await P.startDeposit(1, 500), pid = M.byRef('D' + r.id).transactionId; M.set(pid, 'SUCCESS', { amount: 5 });
  await P.webhook(r.id, { transaction: { id: pid } }); assert.equal(balance(1), 1000); assert.equal(tx(r.id).status, 'review'); assert.ok(flags().some(f => /amount mismatch/.test(f)));
});
test('deposit: a missed webhook is recovered by the background check', async () => {
  const r = await P.startDeposit(1, 200), pid = M.byRef('D' + r.id).transactionId;
  await P.tick(); assert.equal(M.count('GET', '/transactions/' + pid), 0, 'a fresh deposit is not polled yet (webhook gets a head start)');
  M.set(pid, 'SUCCESS'); now += 25000; await P.tick(); assert.equal(tx(r.id).status, 'done'); assert.equal(balance(1), 1200); checkLedger();
});
test('deposit: the page status check settles it too, without hammering PalPluss', async () => {
  const r = await P.startDeposit(1, 200), pid = M.byRef('D' + r.id).transactionId; M.set(pid, 'SUCCESS');
  assert.equal(await P.depositStatus(2, r.id), null, 'players cannot look at someone else\'s deposit');
  now += 9000; assert.equal(await P.depositStatus(1, r.id), 'done'); assert.equal(balance(1), 1200);
});
test('deposit: cancelled by the customer is marked failed, nothing credited', async () => {
  const r = await P.startDeposit(1, 200), pid = M.byRef('D' + r.id).transactionId; M.set(pid, 'CANCELLED'); await P.webhook(r.id, { transaction: { id: pid } });
  assert.equal(tx(r.id).status, 'failed'); assert.equal(balance(1), 1000);
});
test('deposit: an unanswered prompt expires, but a late confirmation is still credited', async () => {
  const r = await P.startDeposit(1, 200), pid = M.byRef('D' + r.id).transactionId;
  now += 301000; await P.tick(); assert.equal(tx(r.id).status, 'failed'); assert.equal(tx(r.id).note, 'timeout'); assert.equal(balance(1), 1000);
  M.set(pid, 'SUCCESS'); now += 601000; await P.tick(); assert.equal(tx(r.id).status, 'done'); assert.equal(balance(1), 1200, 'late payment is not lost'); checkLedger();
});
test('deposit: if the STK response is lost, the webhook (found by our reference) still credits the player', async () => {
  M.stk = 'drop'; const r = await P.startDeposit(1, 150); assert.ok(r.ok, 'the player is told the request was sent'); assert.equal(tx(r.id).status, 'pending'); assert.equal(tx(r.id).pid, null);
  M.stk = null; const pid = M.byRef('D' + r.id).transactionId; M.set(pid, 'SUCCESS');
  assert.equal(await P.webhook(r.id, {}), 'done'); assert.equal(balance(1), 1150); assert.equal(tx(r.id).pid, pid); checkLedger();
});
test('deposit: a double click does not send a second prompt', async () => {
  const a = await P.startDeposit(1, 100), b = await P.startDeposit(1, 100); assert.equal(b.id, a.id); assert.equal(M.count('POST', '/payments/stk'), 1);
});
test('deposit: PalPluss refusing the request fails it at once with a clear message, and alerts the admin when it is our account', async () => {
  M.stk = { status: 400, code: 'INVALID_PHONE' }; let r = await P.startDeposit(1, 100); assert.match(r.error, /M-Pesa number/); assert.equal(tx(r.id).status, 'failed');
  M.stk = { status: 402, code: 'INSUFFICIENT_SERVICE_BALANCE' }; r = await P.startDeposit(2, 100); assert.match(r.error, /temporarily unavailable/); assert.ok(alerts.some(a => /INSUFFICIENT_SERVICE_BALANCE/.test(a)), 'admin is told the service wallet is empty');
  M.stk = { status: 429, code: 'STK_RATE_LIMITED', details: { retryAfterSeconds: 40 } }; r = await P.startDeposit(1, 100); assert.match(r.error, /40 seconds|minute/);
});

// ---------------- WITHDRAWALS ----------------
test('withdrawal: debited at once, paid straight away with an idempotency key, done when PalPluss says SUCCESS', async () => {
  const w = P.createWithdrawal(1, 400); assert.equal(balance(1), 600, 'wallet is debited immediately'); assert.equal(tx(w.id).status, 'queued');
  await until(() => tx(w.id).status === 'pending');
  const c = M.calls.find(x => x.path === '/b2c/payouts');
  assert.equal(c.body.reference, 'WD-' + w.id); assert.equal(c.body.phone, '0711111111'); assert.equal(c.body.amount, 400); assert.equal(c.body.currency, 'KES'); assert.equal(c.idem, 'gamearena-wd-' + w.id);
  const pid = M.byRef('WD-' + w.id).transactionId; M.set(pid, 'SUCCESS'); await P.webhook(w.id, { transaction: { id: pid } });
  assert.equal(tx(w.id).status, 'done'); assert.equal(balance(1), 600); checkLedger();
});
test('withdrawal: a failed payout is refunded exactly once, even if told many times', async () => {
  const w = P.createWithdrawal(1, 400); await until(() => tx(w.id).status === 'pending'); const pid = M.byRef('WD-' + w.id).transactionId;
  M.set(pid, 'FAILED'); await P.webhook(w.id, { transaction: { id: pid } }); await P.webhook(w.id, { transaction: { id: pid } }); M.set(pid, 'REVERSED'); await P.webhook(w.id, {}); now += 20000; await P.tick();
  assert.equal(tx(w.id).status, 'failed'); assert.equal(balance(1), 1000, 'refunded once'); checkLedger();
});
test('withdrawal: more than the balance is refused, and two at once cannot overdraw', async () => {
  assert.throws(() => P.createWithdrawal(1, 1001), /Insufficient/);
  P.createWithdrawal(1, 600); assert.throws(() => P.createWithdrawal(1, 600), /Insufficient/); assert.equal(balance(1), 400); checkLedger();
});
test('withdrawal: a missed webhook is recovered by the background check', async () => {
  const w = P.createWithdrawal(1, 400); await until(() => tx(w.id).status === 'pending'); const pid = M.byRef('WD-' + w.id).transactionId;
  M.set(pid, 'SUCCESS'); now += 20000; await P.tick(); assert.equal(tx(w.id).status, 'done');
});
test('withdrawal: an empty PalPluss wallet keeps it queued, retries, and pays when funded', async () => {
  M.b2c = { status: 409, code: 'INSUFFICIENT_FUNDS' }; const w = P.createWithdrawal(1, 400);
  await until(() => /hold/.test(tx(w.id).note || '')); assert.equal(tx(w.id).status, 'queued'); assert.equal(balance(1), 600); assert.ok(alerts.some(a => /B2C wallet/.test(a)), 'admin is told to top up');
  M.b2c = null; now += 61000; await P.tick(); assert.equal(tx(w.id).status, 'pending', 'sent once the wallet is funded'); assert.equal(M.count('POST', '/b2c/payouts'), 2);
});
test('withdrawal: still unfunded after 15 minutes refunds the player automatically', async () => {
  M.b2c = { status: 409, code: 'INSUFFICIENT_FUNDS' }; const w = P.createWithdrawal(1, 400); await until(() => /hold/.test(tx(w.id).note || ''));
  now += 16 * 60000; await P.tick(); assert.equal(tx(w.id).status, 'failed'); assert.equal(balance(1), 1000); assert.ok(flags().some(f => /refunded after waiting/.test(f))); checkLedger();
});
test('withdrawal: a payout PalPluss rejects for good (bad phone) is refunded immediately', async () => {
  M.b2c = { status: 400, code: 'INVALID_PHONE' }; const w = P.createWithdrawal(1, 400); await until(() => tx(w.id).status === 'failed'); assert.equal(balance(1), 1000); checkLedger();
});
test('withdrawal: PalPluss account problems (KYC) refund the player and alert the admin', async () => {
  M.b2c = { status: 403, code: 'KYC_NOT_VERIFIED' }; const w = P.createWithdrawal(1, 400); await until(() => tx(w.id).status === 'failed'); assert.equal(balance(1), 1000); assert.ok(alerts.some(a => /KYC_NOT_VERIFIED/.test(a)));
});
test('withdrawal: rate limit (same phone twice in a minute) waits and retries', async () => {
  M.b2c = { status: 429, code: 'B2C_PAYOUT_COOLDOWN', details: { retryAfterSeconds: 30 }, headers: { 'Retry-After': '30' } }; const w = P.createWithdrawal(1, 400); await until(() => /wait/.test(tx(w.id).note || ''));
  assert.equal(balance(1), 600); M.b2c = null; now += 40000; await P.tick(); assert.equal(tx(w.id).status, 'pending');
});
test('withdrawal: response lost but money WAS sent: it is found by reference and not paid twice (even if PalPluss ignores idempotency keys)', async () => {
  M.honorIdem = false; M.b2c = 'drop'; const w = P.createWithdrawal(1, 400);
  await until(() => /unsure/.test(tx(w.id).note || '')); assert.equal(tx(w.id).status, 'queued'); assert.equal(balance(1), 600, 'not refunded: it may have been paid');
  M.b2c = null; now += 31000; await P.tick();
  assert.equal([...M.txs.values()].filter(t => t.type === 'B2C').length, 1, 'only ONE payout exists at PalPluss'); assert.equal(tx(w.id).status, 'pending'); assert.ok(tx(w.id).pid);
  M.set(tx(w.id).pid, 'SUCCESS'); now += 20000; await P.tick(); assert.equal(tx(w.id).status, 'done'); assert.equal(balance(1), 600); checkLedger();
});
test('withdrawal: request never arrived (connection lost before): it is sent again, once', async () => {
  M.b2c = 'lost-before'; const w = P.createWithdrawal(1, 400); await until(() => /unsure/.test(tx(w.id).note || ''));
  M.b2c = null; now += 31000; await P.tick(); assert.equal([...M.txs.values()].filter(t => t.type === 'B2C').length, 1); assert.equal(tx(w.id).status, 'pending');
});
test('withdrawal: still unconfirmed after 3 tries goes to a person, never auto-refunded', async () => {
  M.b2c = 'lost-before'; const w = P.createWithdrawal(1, 400);
  for (let i = 0; i < 5 && tx(w.id).status === 'queued'; i++) { await sleep(60); now += 6 * 60000; await P.tick(); }
  assert.equal(tx(w.id).status, 'review'); assert.equal(balance(1), 600); assert.ok(flags().some(f => /could not be confirmed/.test(f)));
});
test('withdrawal: large amounts wait for approval; approve pays, reject refunds', async () => {
  db.prepare('update users set balance=balance+12000 where id=1').run(); db.prepare("insert into ledger(uid,amount,note) values(1,12000,'topup')").run();
  const a = P.createWithdrawal(1, 6000), b = P.createWithdrawal(1, 5000); await sleep(50);
  assert.equal(tx(a.id).status, 'review'); assert.equal(M.count('POST', '/b2c/payouts'), 0, 'nothing is sent before approval');
  assert.equal(await P.adminApprove(a.id), true); assert.equal(tx(a.id).status, 'pending'); assert.equal(await P.adminApprove(a.id), false, 'cannot approve twice');
  assert.equal(P.adminReject(b.id), true); assert.equal(P.adminReject(b.id), false, 'cannot reject twice'); assert.equal(tx(b.id).status, 'rejected'); assert.equal(balance(1), 1000 + 12000 - 6000); checkLedger();
});
test('withdrawal: PalPluss paid it after we refunded it: flagged for a human', async () => {
  const w = P.createWithdrawal(1, 400); await until(() => tx(w.id).status === 'pending'); const pid = M.byRef('WD-' + w.id).transactionId;
  M.set(pid, 'FAILED'); await P.webhook(w.id, {}); assert.equal(balance(1), 1000); M.set(pid, 'SUCCESS'); await P.webhook(w.id, {}); assert.ok(flags().some(f => /already refunded/.test(f)));
});
test('webhook: unknown transaction ids and PalPluss outages are handled quietly', async () => {
  assert.equal(await P.webhook(9999, {}), 'unknown'); const r = await P.startDeposit(1, 100); M.getFail = 500;
  assert.equal(await P.webhook(r.id, { transaction: { id: M.byRef('D' + r.id).transactionId } }), 'later'); assert.equal(balance(1), 1000);
});
test('database upgrade: works on the original txs table and can be applied twice', () => {
  assert.doesNotThrow(() => createPayments({ db, add() {}, pp }));
  const cols = db.prepare('pragma table_info(txs)').all().map(c => c.name); for (const c of ['pid', 'note', 'idem', 'upd', 'tries', 'nexts', 'at']) assert.ok(cols.includes(c), c);
});
