// Integration test: a staked tic-tac-toe game must pay the winner the pot minus the platform fee.
const { spawn } = require('child_process'), { test } = require('node:test'), assert = require('node:assert'), fs = require('fs');
const { io } = require('socket.io-client'), Database = require('better-sqlite3');
const PORT = 3999, DB = 'test.db', BASE = 'http://localhost:' + PORT, sleep = ms => new Promise(r => setTimeout(r, ms));
const up = async port => { for (let i = 0; i < 80; i++) { try { await fetch('http://localhost:' + port + '/healthz'); return; } catch { await sleep(250); } } throw new Error('server did not start on port ' + port); };   // wait until the server answers instead of guessing
const post = async (p, b, t) => (await fetch(BASE + '/api/' + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t && { Authorization: 'Bearer ' + t }) }, body: JSON.stringify(b) })).json();
const emit = (c, ev, d) => new Promise(r => c.emit(ev, d, r));
const http = require('http');
function mockPalPluss(port) {   // stands in for api.palpluss.com so the whole money flow can be tested offline
  const txs = new Map(); let seq = 0;
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const j = b ? JSON.parse(b) : {}, url = new URL(req.url, 'http://x'), send = d => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, data: d })); };
    if (req.headers.authorization !== 'Basic ' + Buffer.from('pk_test_abc123:').toString('base64')) { res.statusCode = 401; return res.end('{"success":false,"error":{"code":"INVALID_API_KEY"}}'); }
    const mk = (type, extra) => { const t = { transactionId: 'T' + ++seq, type, status: 'PENDING', currency: 'KES', amount: j.amount, ...extra }; txs.set(t.transactionId, t); return t; };
    if (req.method === 'POST' && url.pathname === '/payments/stk') return send(mk('STK', { accountReference: j.accountReference }));
    if (req.method === 'POST' && url.pathname === '/b2c/payouts') return send(mk('B2C', { reference: j.reference }));
    if (req.method === 'GET' && url.pathname.startsWith('/transactions/')) { const t = txs.get(decodeURIComponent(url.pathname.split('/').pop())); if (t) return send(t); res.statusCode = 404; return res.end('{"success":false,"error":{"code":"TRANSACTION_NOT_FOUND"}}'); }
    if (req.method === 'GET' && url.pathname === '/transactions') return send({ items: [...txs.values()].reverse(), nextCursor: null });
    if (req.method === 'GET' && url.pathname === '/wallets/service/balance') return send({ availableBalance: 100000 });
    res.statusCode = 404; res.end('{}'); }); });
  const find = ref => [...txs.values()].find(t => t.accountReference === ref || t.reference === ref);
  return new Promise(r => srv.listen(port, () => r({ srv, txs, find, payouts: () => [...txs.values()].filter(t => t.type === 'B2C') })));
}
const CBS = 'testcallbacksecret1234';
const hook = (id, secret = CBS) => fetch(`${BASE}/api/palpluss/webhook/${secret}/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
test('deposits, staked game payout, withdrawals, 18+ rule and ledger', async () => {
  fs.rmSync(DB, { force: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DB_FILE: DB, JWT_SECRET: 't', PLATFORM_FEE: '0.1', DEV_SHOW_CODES: '1', NODE_ENV: 'test', PALPLUSS_BASE: 'http://localhost:3990', PALPLUSS_API_KEY: 'pk_test_abc123', CALLBACK_SECRET: CBS, BASE_URL: 'http://localhost:3999', ANDROID_PACKAGE: 'com.gamearena.app', ANDROID_SHA256: 'AA:BB:CC', ADMIN_PHONES: '0711111111' }, stdio: 'inherit' });
  const socks = []; let db; const mock = await mockPalPluss(3990);
  try {
    await up(PORT);
    const reg = async (phone, name, dob) => { const s = await post('register/start', { phone, name, password: 'secret1', dob, email: name.toLowerCase() + phone + '@test.com' }); if (s.error) return s; return post('register/verify', { phone, code: s.devCode }); };
    const early = await post('register/start', { phone: '0744444444', name: 'D', password: 'secret1', dob: '1990-01-01', email: 'd@test.com' });
    assert.equal((await post('register/verify', { phone: '0744444444', code: '000000' })).error, 'Wrong code. Please try again.', 'a wrong code is rejected');
    assert.ok(early.devCode && !(await post('register/start', { phone: '0744444444', name: 'D', password: 'secret1', dob: '1990-01-01', email: 'd@test.com' })).ok, 'codes cannot be re-requested within a minute');
    assert.equal((await fetch(BASE + '/api/register', { method: 'POST' })).status, 404, 'old unverified sign-up route is gone');
    const A = await reg('0711111111', 'A', '1990-01-01'), B = await reg('0722222222', 'B', '1990-01-01');
    assert.ok(A.token && B.token, 'adults can sign up with a code');
    assert.ok((await reg('0733333333', 'C', '2015-01-01')).error, 'minors are rejected');
    assert.ok((await post('register/start', { phone: '0755555555', name: 'E', password: 'secret1', dob: '1990-01-01', channel: 'email', email: 'not-an-email' })).error, 'bad email is rejected');
    assert.ok((await post('login/start', { phone: '0711111111', password: 'wrong-pass' })).error, 'wrong password is rejected');
    const li = await post('login/start', { phone: '0711111111', password: 'secret1' }); assert.ok(li.otp && li.devCode, 'login sends a code');
    assert.ok((await post('login/verify', { phone: '0711111111', code: li.devCode })).token, 'login completes with the code');
    assert.ok((await post('login/verify', { phone: '0711111111', code: li.devCode })).error, 'a code works only once');
    // forgot password
    const R = await reg('0755550000', 'R', '1990-01-01'); assert.ok(R.token); const rid = 'r0755550000@test.com';
    assert.equal((await post('reset/start', { id: 'nobody@test.com' })).ok, true, 'an unknown account gets the same answer');
    const rs = await post('reset/start', { id: rid }); assert.ok(rs.ok && rs.devCode, 'a code is sent to the account email');
    assert.ok((await post('reset/verify', { id: rid, code: '000000', password: 'newpass1' })).error, 'a wrong code is rejected');
    assert.ok((await post('reset/verify', { id: rid, code: rs.devCode, password: '123' })).error, 'a short password is rejected');
    const rd = await post('reset/verify', { id: rid, code: rs.devCode, password: 'newpass1' }); assert.ok(rd.token, 'the new password logs the player in');
    assert.equal((await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + R.token } })).status, 401, 'the old login stops working after a reset');
    assert.equal((await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + rd.token } })).status, 200);
    assert.ok((await post('login/start', { phone: '0755550000', password: 'secret1' })).error, 'the old password no longer works');
    assert.ok((await post('login/start', { phone: '0755550000', password: 'newpass1' })).otp, 'the new password works');
    for (let i = 0; i < 8; i++) await post('login/start', { phone: '0755550000', password: 'bad' + i });
    assert.match((await post('login/start', { phone: '0755550000', password: 'newpass1' })).error, /Too many wrong passwords/, 'repeated wrong passwords lock the account for a while');
    const ghost = require('jsonwebtoken').sign({ id: 9999 }, 't');
    assert.equal((await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + ghost } })).status, 401, 'a login for a deleted or missing account is rejected, not a crash');
    db = new Database(DB); const bal = n => db.prepare('select balance from users where name=?').get(n).balance;
    // deposits through PalPluss: STK prompt -> (unsigned) webhook nudge -> server re-checks with PalPluss -> wallet
    const dep = async (tk, kes) => { const d = await post('deposit', { amount: kes }, tk); assert.ok(d.ref, 'a deposit starts an M-Pesa prompt'); assert.equal(mock.find('D' + d.ref).amount, kes + 3, 'the player is charged the amount plus the KES 3 fee'); return d.ref; };
    const pay = (ref, status = 'SUCCESS', amount) => { const t = mock.find('D' + ref); t.status = status; if (amount != null) t.amount = amount; return t; };
    const refA = await dep(A.token, 1000), refB = await dep(B.token, 1000);
    assert.equal((await hook(refA, 'wrong-secret-wrong')).status, 403, 'a webhook with the wrong secret is rejected'); assert.equal(bal('A'), 0);
    await hook(refA); await sleep(150); assert.equal(bal('A'), 0, 'a webhook alone does not credit: PalPluss says the payment is still pending');
    pay(refA); await hook(refA); await hook(refA); await sleep(300); assert.equal(bal('A'), 1000, 'the deposit reaches the wallet once, even if the webhook is repeated');
    pay(refB); let stB; for (let i = 0; i < 40 && stB !== 'done'; i++) { stB = (await (await fetch(BASE + '/api/pay/status/' + refB, { headers: { Authorization: 'Bearer ' + B.token } })).json()).status; if (stB !== 'done') await sleep(1000); }   // the page polls; checks with PalPluss are rate limited, so allow some seconds
    assert.equal(stB, 'done', 'a deposit is settled by status checks / the background check even if the webhook never arrives'); assert.equal(bal('B'), 1000);
    const refX = await dep(A.token, 50); pay(refX, 'SUCCESS', 1); await hook(refX); await sleep(300); assert.equal(bal('A'), 1000, 'a payment for the wrong amount is not credited'); assert.equal(db.prepare("select status from txs where id=?").get(refX).status, 'review');
    db.prepare('update users set balance=1000 where name=?').run('A');   // reset after the mismatch test (ledger is checked separately)
    const ca = io(BASE, { auth: { token: A.token } }), cb = io(BASE, { auth: { token: B.token } }); socks.push(ca, cb);
    let endS; ca.on('state', s => { if (s.over) endS = s; });
    await sleep(300);
    const made = await emit(ca, 'create', { game: 'tictactoe', stake: 100 }); assert.ok(made.code);
    assert.ok((await emit(cb, 'join', { code: made.code })).ok);
    ca.emit('ready', true); cb.emit('ready', true); await sleep(300);
    ca.emit('start'); await sleep(300);
    for (const [c, i] of [[ca, 0], [cb, 3], [ca, 1], [cb, 4], [ca, 2]]) { c.emit('move', { i }); await sleep(150); }
    await sleep(500);
    assert.equal(bal('A'), 1080, 'winner gets 2x stake minus 10% fee'); assert.equal(bal('B'), 900);
    assert.equal(db.prepare('select sum(amount) v from house').get().v, 20, 'fee recorded');
    assert.equal(endS.pay, 180); assert.ok(endS.winner); assert.deepEqual(endS.line, [0, 1, 2], 'results screen gets the payout and the winning line');
    assert.ok(db.prepare("select 1 from ledger where note='winnings'").get(), 'payout is in the ledger');
    assert.equal((await fetch(BASE + '/healthz')).status, 200, 'health check works');
    assert.equal((await (await fetch(BASE + '/.well-known/assetlinks.json')).json())[0].target.package_name, 'com.gamearena.app', 'Android asset links are served');
    assert.ok((await fetch(BASE + '/offline.html')).ok && (await fetch(BASE + '/icon-512.png')).ok, 'offline page and app icons are served'); assert.equal((await (await fetch(BASE + '/api/config')).json()).stakes, true);
    const r2 = await dep(A.token, 300); pay(r2); await hook(r2); await hook(r2); await sleep(300); assert.equal(bal('A'), 1380, 'a real deposit credits once and replays do not double-credit');
    // withdrawals through PalPluss B2C
    const lastWd = () => db.prepare("select id, ref, status from txs where type='withdraw' order by id desc limit 1").get();
    const w1 = await post('withdraw', { amount: 500 }, A.token); assert.ok(w1.ok, 'withdrawal is accepted'); assert.equal(bal('A'), 1380 - 518, 'KES 500 to the phone plus the KES 18 PalPluss fee leaves the wallet');
    await sleep(300); assert.equal(mock.payouts().length, 1); assert.equal(mock.payouts()[0].amount, 500); const wd1 = lastWd(); assert.equal(mock.payouts()[0].reference, wd1.ref);
    mock.payouts()[0].status = 'FAILED'; await hook(wd1.id); await hook(wd1.id); await sleep(300);
    assert.equal(bal('A'), 1380, 'a failed payout is refunded once, fee included');
    const w2 = await post('withdraw', { amount: 500 }, A.token); assert.ok(w2.ok); await sleep(300); const wd2 = lastWd();
    mock.find(wd2.ref).status = 'SUCCESS'; await hook(wd2.id); await sleep(300);
    assert.equal(bal('A'), 1380 - 518, 'a paid-out withdrawal stays deducted'); assert.equal(db.prepare('select status from txs where id=?').get(wd2.id).status, 'done');
    // public chat
    const gotA = [], gotB = []; ca.on('pubmsg', m => gotA.push(m)); cb.on('pubmsg', m => gotB.push(m));
    assert.ok((await emit(ca, 'pub', { text: 'Hello everyone' })).ok); await sleep(150);
    assert.equal(gotB[0].text, 'Hello everyone', 'everyone online sees a public message'); assert.equal(gotB[0].name, 'A');
    assert.ok((await emit(cb, 'pub', { text: 'visit www.scam.com' })).error, 'links are blocked'); assert.ok((await emit(cb, 'pub', { text: 'send to 0712 345 678' })).error, 'phone numbers are blocked');
    await sleep(1600); assert.ok((await emit(cb, 'pub', { text: 'Hi A!', reply: gotB[0].id })).ok); await sleep(150);
    assert.equal(gotA[1].rp.name, 'A'); assert.equal(gotA[1].rp.text, 'Hello everyone', 'a reply carries the message it answers');
    assert.equal((await emit(cb, 'pub', { text: 'too fast' })).error, 'Slow down a little', 'flooding is slowed down');
    const hist = await emit(cb, 'pubhist', {}); assert.ok(hist.length >= 2 && hist[hist.length - 1].rp.id === gotB[0].id, 'newcomers see recent messages');
    ca.emit('pubdel', { id: gotB[0].id }); await sleep(150); assert.ok(!(await emit(cb, 'pubhist', {})).find(m => m.id === gotB[0].id), 'an admin can delete a message');
    // tournaments: entry fees, knockout bracket, draws, payout of 90% to the champion
    const get = async (p, tk) => (await fetch(BASE + '/api/' + p, { headers: { Authorization: 'Bearer ' + tk } })).json(), uid = async tk => (await get('me', tk)).id;
    const C = await reg('0766660001', 'C', '1990-01-01'), D = await reg('0766660002', 'D', '1990-01-01');
    for (const tk of [C.token, D.token]) { const r = await dep(tk, 500); pay(r); await hook(r); } await sleep(400);
    const cc = io(BASE, { auth: { token: C.token } }), cd = io(BASE, { auth: { token: D.token } }); socks.push(cc, cd);
    for (const c of [ca, cb, cc, cd]) c.on('tmatch', m => c.emit('tjoin', { room: m.room }));   // players step into their matches
    const sockOf = { [await uid(A.token)]: ca, [await uid(B.token)]: cb, [await uid(C.token)]: cc, [await uid(D.token)]: cd }, bals = () => Object.fromEntries(Object.keys(sockOf).map(id => [id, db.prepare('select balance from users where id=?').get(id).balance]));
    assert.ok((await post('tournaments', { name: 'x', game: 'chess', g: 2, size: 4, fee: 100 }, A.token)).error, 'a short name is rejected');
    assert.ok((await post('tournaments', { name: 'Bad Size', game: 'chess', g: 2, size: 6, fee: 100 }, A.token)).error, 'the size must fit the bracket');
    assert.ok((await post('tournaments', { name: 'Cheap Fee', game: 'chess', g: 2, size: 4, fee: 5 }, A.token)).error, 'a fee between 1 and 9 is rejected');
    const b0 = bals(), T = await post('tournaments', { name: 'Test Cup', game: 'chess', g: 2, size: 4, fee: 100, tc: '5+0', enter: true }, A.token); assert.ok(T.id);
    assert.equal(bals()[await uid(A.token)], b0[await uid(A.token)] - 100, 'the creator paid the entry fee');
    assert.ok((await post(`tournaments/${T.id}/join`, {}, B.token)).ok); assert.ok((await post(`tournaments/${T.id}/leave`, {}, B.token)).ok, 'leaving before the start refunds the fee');
    assert.equal(bals()[await uid(B.token)], b0[await uid(B.token)]);
    for (const tk of [B.token, C.token, D.token]) assert.ok((await post(`tournaments/${T.id}/join`, {}, tk)).ok);
    await sleep(500); const entered = bals(), houseBefore = db.prepare('select coalesce(sum(amount),0) v from house').get().v;
    let d = await get('tournaments/' + T.id, A.token); assert.equal(d.status, 'running', 'it starts by itself when full'); assert.equal(d.matches.filter(m => m.round === 1 && m.status === 'live').length, 2); assert.equal(d.matches.length, 3);
    const m1 = d.matches.find(m => m.round === 1 && m.idx === 0), m2 = d.matches.find(m => m.round === 1 && m.idx === 1), [p0, p1] = m1.players.map(p => sockOf[p.id]);
    for (let i = 0; i < 3; i++) { p0.emit('drawOffer'); await sleep(250); p1.emit('drawAccept'); await sleep(2600); }   // three draws: replays, then a coin flip
    sockOf[m2.players[1].id].emit('resign'); await sleep(600);
    d = await get('tournaments/' + T.id, A.token); assert.ok(d.matches.find(m => m.id === m1.id).winner, 'three draws are settled by a coin flip'); assert.equal(d.matches.find(m => m.id === m2.id).winner, m2.players[0].id, 'the player who did not resign advances');
    const fin = d.matches.find(m => m.round === 2); assert.equal(fin.status, 'live', 'the final starts by itself when both semi-finals are decided'); assert.equal(fin.players.length, 2);
    sockOf[fin.players[1].id].emit('resign'); await sleep(700);
    d = await get('tournaments/' + T.id, A.token); assert.equal(d.status, 'done'); assert.equal(d.winner, fin.players[0].id);
    const after = bals(); for (const id of Object.keys(sockOf)) assert.equal(after[id], entered[id] + (+id === d.winner ? 360 : 0), 'only the champion is paid, 90% of the KES 400 pool');
    assert.equal(db.prepare('select coalesce(sum(amount),0) v from house').get().v - houseBefore, 40, 'GameArena keeps 10% of the pool');
    // cancelling a tournament refunds everyone
    const b1 = bals(), T2 = await post('tournaments', { name: 'Cancel Cup', game: 'tictactoe', g: 2, size: 4, fee: 50, enter: true }, C.token); assert.ok((await post(`tournaments/${T2.id}/join`, {}, D.token)).ok);
    assert.equal(bals()[await uid(C.token)], b1[await uid(C.token)] - 50); assert.ok((await post(`tournaments/${T2.id}/cancel`, {}, D.token)).error, 'only the creator can cancel');
    assert.ok((await post(`tournaments/${T2.id}/cancel`, {}, C.token)).ok); assert.deepEqual(bals(), b1, 'a cancelled tournament refunds every entry fee');
  } finally { socks.forEach(c => c.close()); mock.srv.close(); srv.kill(); try { db && db.close(); } catch {} await sleep(500); for (const x of ['', '-wal', '-shm']) try { fs.rmSync(DB + x, { force: true }); } catch {} }   // never let cleanup hide the real failure (Windows keeps files locked briefly)
});

const { spawnSync } = require('child_process');
test('production mode refuses to start with unsafe settings', () => {
  const r = spawnSync('node', ['server.js'], { env: { ...process.env, NODE_ENV: 'production', PORT: 3998, DB_FILE: 'test2.db', JWT_SECRET: 'short' }, encoding: 'utf8' });
  fs.rmSync('test2.db', { force: true }); assert.equal(r.status, 1); assert.match(r.stderr, /Cannot start in production/); assert.match(r.stderr, /JWT_SECRET/);
});
test('STAKES_ENABLED=0 launches free play only', async () => {
  fs.rmSync('test3.db', { force: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: 3997, DB_FILE: 'test3.db', STAKES_ENABLED: '0', NODE_ENV: 'test' }, stdio: 'ignore' });
  try { await up(3997); assert.equal((await (await fetch('http://localhost:3997/api/config')).json()).stakes, false); }
  finally { srv.kill(); await sleep(300); fs.rmSync('test3.db', { force: true }); }
});

async function twoPlayers(port, dice, game, live) {
  const db = `t${port}.db`; fs.rmSync(db, { force: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: port, DB_FILE: db, JWT_SECRET: 't', DEV_SHOW_CODES: '1', NODE_ENV: 'test', TEST_DICE: dice }, stdio: 'ignore' });
  await up(port);
  const url = 'http://localhost:' + port, post = async (p, b) => (await fetch(url + '/api/' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
  const reg = async (phone, name) => { const s = await post('register/start', { phone, name, password: 'secret1', dob: '1990-01-01', email: name.toLowerCase() + phone + '@test.com' }); return (await post('register/verify', { phone, code: s.devCode })).token; };
  const ta = await reg('0711111111', 'A'), tb = await reg('0722222222', 'B');
  const ca = io(url, { auth: { token: ta } }), cb = io(url, { auth: { token: tb } }), last = {}; ca.on('state', s => last.a = s); cb.on('state', s => last.b = s);
  await sleep(300);
  const made = await emit(ca, 'create', { game, stake: 0, size: 2, live }); await emit(cb, 'join', { code: made.code });
  ca.emit('ready', true); cb.emit('ready', true); await sleep(200); ca.emit('start'); await sleep(300);
  return { ca, cb, last, url, reg, done: async () => { ca.close(); cb.close(); srv.kill(); await sleep(300); fs.rmSync(db, { force: true }); } };
}
const step = async (c, ev, d) => { c.emit(ev, d); await sleep(120); };
test('Ludo: capturing a piece gives another roll', async () => {
  const g = await twoPlayers(3996, '6,1,6,2,6,6,6,6,3', 'ludo');
  try {
    await step(g.ca, 'roll'); await step(g.ca, 'move', { t: 0 }); await step(g.ca, 'roll'); await step(g.ca, 'move', { t: 0 });   // A rolls 6 (piece out), then 1
    await step(g.cb, 'roll'); await step(g.cb, 'move', { t: 0 }); await step(g.cb, 'roll'); await step(g.cb, 'move', { t: 0 });   // B rolls 6, then 2 (sits on square 28)
    for (let i = 0; i < 4; i++) { await step(g.ca, 'roll'); await step(g.ca, 'move', { t: 0 }); }                                  // A rolls 6 four times
    await step(g.ca, 'roll'); await step(g.ca, 'move', { t: 0 });                                                                   // A rolls 3 and lands on B's piece
    const s = g.last.a; assert.equal(s.ludo.pos[1][0], -1, 'captured piece goes back to the yard'); assert.equal(s.turn, 0, 'the capturer rolls again'); assert.equal(s.ludo.die, null); assert.match(s.ludo.msg, /captured/);
  } finally { await g.done(); }
});
test('Ludo: a player stuck in the yard gets a six within 2 rolls once an opponent is out', async () => {
  const g = await twoPlayers(3995, '6,3,1,2,4', 'ludo');
  try {
    await step(g.ca, 'roll'); await step(g.ca, 'move', { t: 0 }); await step(g.ca, 'roll'); await step(g.ca, 'move', { t: 0 });   // A gets out, moves on
    await step(g.cb, 'roll');                                                                                                          // B rolls 1: no six, turn passes
    await step(g.ca, 'roll'); await step(g.ca, 'move', { t: 0 });                                                                      // A rolls 2
    await step(g.cb, 'roll');                                                                                                          // B rolls 4 but the catch-up rule makes it a 6
    assert.equal(g.last.b.ludo.last, 6); assert.deepEqual(g.last.b.ludo.movable, [0, 1, 2, 3]);
  } finally { await g.done(); }
});
test('chess: legal move hints and the last move are sent to both players', async () => {
  const g = await twoPlayers(3994, '', 'chess');
  try { assert.deepEqual((await emit(g.ca, 'legal', { sq: 'e2' })).sort(), ['e3', 'e4']); await step(g.ca, 'move', { from: 'e2', to: 'e4' });
    assert.deepEqual(g.last.b.lm, ['e2', 'e4']); assert.equal(g.last.b.chk, false); }
  finally { await g.done(); }
});

test('live games: anyone can watch a live game but cannot play in it, and private games cannot be watched', async () => {
  const g = await twoPlayers(3980, '', 'connect4', true);
  try {
    const cc = io(g.url, { auth: { token: await g.reg('0733333333', 'C') } }); let list = [], st; cc.on('live', l => list = l); cc.on('state', x => st = x); await sleep(600);
    assert.equal(list.length, 1, 'the live game is listed'); assert.deepEqual(list[0].names, ['A', 'B']);
    assert.ok((await emit(cc, 'spectate', { id: list[0].id })).ok); await sleep(200); assert.equal(st.live, true); assert.equal(st.board.length, 42);
    cc.emit('move', { c: 3 }); await sleep(200); assert.ok(g.last.a.board.every(x => x === 0), 'a spectator cannot move');
    await step(g.ca, 'move', { c: 3 }); await sleep(100); assert.equal(st.board[38], 1, 'the spectator sees the players\' move'); assert.equal(g.last.a.w, 1, 'the players see how many are watching');
    cc.emit('unspectate'); await sleep(600); assert.equal(list[0].w, 0); cc.close();
  } finally { await g.done(); }
});
test('a game that was not made live cannot be watched', async () => {
  const g = await twoPlayers(3979, '', 'connect4', false);
  try {
    const cc = io(g.url, { auth: { token: await g.reg('0733333333', 'C') } }); let list = [1]; cc.on('live', l => list = l); await sleep(600);
    assert.equal(list.length, 0, 'it is not listed'); const id = g.last.a.id; assert.match((await emit(cc, 'spectate', { id })).error, /not live/); cc.close();
  } finally { await g.done(); }
});
test('tournaments: the creator chooses live or not live, and everyone can see it before joining', async () => {
  const g = await twoPlayers(3978, '', 'chess');
  try {
    const tk = await g.reg('0744444444', 'D'), call = async (m, p, b) => (await fetch(g.url + '/api/' + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: b && JSON.stringify(b) })).json();
    await call('POST', 'tournaments', { name: 'Live cup', game: 'connect4', size: 4, fee: 0, live: true, enter: false });
    await call('POST', 'tournaments', { name: 'Quiet cup', game: 'reversi', size: 4, fee: 0, enter: false });
    const l = await call('GET', 'tournaments'), a = l.find(t => t.name === 'Live cup'), b = l.find(t => t.name === 'Quiet cup');
    assert.ok(a && b, 'new games are allowed in tournaments'); assert.equal(a.live, true); assert.equal(b.live, false, 'not live unless the creator ticks it');
    assert.equal((await call('GET', 'tournaments/' + a.id)).live, true); assert.equal((await call('GET', 'tournaments/' + b.id)).live, false);
  } finally { await g.done(); }
});
test('Google sign-in: new players add phone and age, returning players go straight in', async () => {
  const gm = http.createServer((req, res) => { const tk = decodeURIComponent(req.url.split('id_token=')[1] || ''); res.setHeader('Content-Type', 'application/json');
    if (tk === 'good') return res.end(JSON.stringify({ aud: 'cid', email: 'g@test.com', email_verified: 'true', name: 'Gina' }));
    if (tk === 'other') return res.end(JSON.stringify({ aud: 'someone-else', email: 'g@test.com', email_verified: 'true' }));
    res.statusCode = 400; res.end('{"error":"invalid_token"}'); });
  await new Promise(r => gm.listen(3991, r)); fs.rmSync('t3992.db', { force: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: 3992, DB_FILE: 't3992.db', JWT_SECRET: 't', NODE_ENV: 'test', GOOGLE_CLIENT_ID: 'cid', GOOGLE_TOKENINFO_URL: 'http://localhost:3991/tokeninfo' }, stdio: 'ignore' });
  const u = 'http://localhost:3992/api/', p = async (x, b) => (await fetch(u + x, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
  try { await up(3992);
    assert.equal((await (await fetch(u + 'config')).json()).google, 'cid');
    assert.ok((await p('google/start', { credential: 'bad' })).error); assert.ok((await p('google/start', { credential: 'other' })).error, 'a Google token meant for another app is rejected');
    const s = await p('google/start', { credential: 'good' }); assert.ok(s.needProfile && s.gt && !s.token);
    assert.ok((await p('google/complete', { token: s.gt, phone: '0788888888', dob: '2015-01-01' })).error, 'under 18 is rejected');
    const c = await p('google/complete', { token: s.gt, phone: '0788888888', dob: '1990-01-01' }); assert.ok(c.token);
    assert.ok((await p('google/start', { credential: 'good' })).token, 'a returning player signs straight in');
    assert.equal((await (await fetch(u + 'me', { headers: { Authorization: 'Bearer ' + c.token } })).json()).name, 'Gina');
    assert.equal((await fetch(u + 'me', { headers: { Authorization: 'Bearer ' + s.gt } })).status, 401, 'the sign-up token cannot be used as a login');
  } finally { srv.kill(); gm.close(); await sleep(300); fs.rmSync('t3992.db', { force: true }); }
});

test('Ludo tournament: 3 players per match, 9 entrants, winners of each round meet in the final', async () => {
  const port = 3989, dbf = 't3989.db'; fs.rmSync(dbf, { force: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: port, DB_FILE: dbf, JWT_SECRET: 't', DEV_SHOW_CODES: '1', NODE_ENV: 'test' }, stdio: 'ignore' });
  const url = 'http://localhost:' + port, post = async (p, b, tk) => (await fetch(url + '/api/' + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk && { Authorization: 'Bearer ' + tk }) }, body: JSON.stringify(b) })).json();
  const get = async (p, tk) => (await fetch(url + '/api/' + p, { headers: { Authorization: 'Bearer ' + tk } })).json(), socks = [];
  try {
    await up(port); const users = [];
    for (let i = 1; i <= 9; i++) { const phone = '07800000' + String(i).padStart(2, '0'), s = await post('register/start', { phone, name: 'P' + i, password: 'secret1', dob: '1990-01-01', email: `p${i}@test.com` });
      const v = await post('register/verify', { phone, code: s.devCode }); const sock = io(url, { auth: { token: v.token } }); socks.push(sock); sock.on('tmatch', m => sock.emit('tjoin', { room: m.room }));
      users.push({ tk: v.token, id: (await get('me', v.token)).id, sock }); }
    const T = await post('tournaments', { name: 'Ludo Cup', game: 'ludo', g: 3, size: 9, fee: 0, enter: true }, users[0].tk); assert.ok(T.id);
    assert.ok((await post('tournaments', { name: 'Bad Ludo', game: 'ludo', g: 3, size: 16, fee: 0 }, users[0].tk)).error, 'nine or 27 players fit 3 per match, 16 does not');
    for (const u of users.slice(1)) assert.ok((await post(`tournaments/${T.id}/join`, {}, u.tk)).ok); await sleep(600);
    const by = id => users.find(u => u.id === id); let d = await get('tournaments/' + T.id, users[0].tk);
    assert.equal(d.status, 'running'); assert.equal(d.matches.filter(m => m.round === 1 && m.status === 'live').length, 3); assert.ok(d.matches.every(m => m.round !== 1 || m.players.length === 3));
    const winners = [];
    for (const m of d.matches.filter(x => x.round === 1)) {
      by(m.players[1].id).sock.emit('resign'); await sleep(150); by(m.players[2].id).sock.emit('resign'); await sleep(500); winners.push(m.players[0].id);
      const fin = (await get('tournaments/' + T.id, users[0].tk)).matches.find(x => x.round === 2);
      assert.equal(fin.status, winners.length < 3 ? 'pending' : 'live', 'the final waits until all three round-1 matches are decided');
    }
    d = await get('tournaments/' + T.id, users[0].tk); const fin = d.matches.find(m => m.round === 2);
    assert.deepEqual(fin.players.map(p => p.id), winners, 'the three winners meet in the final');
    by(fin.players[1].id).sock.emit('resign'); await sleep(150); by(fin.players[2].id).sock.emit('resign'); await sleep(600);
    d = await get('tournaments/' + T.id, users[0].tk); assert.equal(d.status, 'done'); assert.equal(d.winner, fin.players[0].id);
  } finally { socks.forEach(c => c.close()); srv.kill(); await sleep(300); fs.rmSync(dbf, { force: true }); }
});
