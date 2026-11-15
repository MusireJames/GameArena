'use strict';
// All deposit and withdrawal money logic. It has no Express or Socket.IO in it, so it is tested on its own (see payments.test.js).
//
// DEPOSIT (txs.type='deposit')   pending -> done | failed | review
//   1. A row is saved BEFORE PalPluss is called, so a fast webhook can always find it.
//   2. PalPluss sends the M-Pesa PIN prompt. The result comes back by webhook, and a background job also asks PalPluss
//      directly, so a missed webhook never loses a deposit.
//   3. Money is credited only after PalPluss itself confirms SUCCESS for the right amount (a webhook alone is never trusted).
//   4. The credit is one atomic step ("claim the row, then add to the wallet"), so a repeated webhook or poll cannot credit twice.
//   5. A prompt nobody answers is expired after DEPOSIT_EXPIRE_SECONDS. If M-Pesa confirms it late, it is still credited.
//
// WITHDRAWAL (txs.type='withdraw')   review -> queued -> pending -> done | failed | rejected
//   1. The wallet is debited and the row saved in one atomic step, so money is never taken without a record.
//   2. The payout is sent straight away (no waiting for an admin) unless the amount needs approval (WITHDRAW_REVIEW_OVER).
//   3. A payout PalPluss refused (wallet empty, rate limit...) is retried every minute, and refunded to the player after
//      WITHDRAW_QUEUE_MINUTES. A payout that timed out is NEVER blindly re-sent: PalPluss is asked first whether it already went out.
//   4. FAILED / REVERSED / CANCELLED refunds the player exactly once. SUCCESS marks it done.
const inTxnDepth = new WeakMap();

function createPayments({ db, add, pushBal = () => {}, pp, env = process.env, alert = () => {}, clock = Date.now, baseUrl = env.BASE_URL || '', secret = env.CALLBACK_SECRET || 'dev-callback-secret' }) {
  const E = env;
  const REVIEW = +E.WITHDRAW_REVIEW_OVER || 5000;
  const DEP_EXPIRE = (+E.DEPOSIT_EXPIRE_SECONDS || 300) * 1000;
  const LATE_WINDOW = 24 * 3600 * 1000;
  const QUEUE_MAX = (+E.WITHDRAW_QUEUE_MINUTES || 15) * 60000;
  const STUCK = 10 * 60000;
  const LOW_SERVICE = +E.PALPLUSS_MIN_SERVICE_BALANCE || 500;

  for (const c of ['pid text', "note text default ''", 'idem text', 'upd integer default 0', 'tries integer default 0', 'nexts integer default 0', 'at integer default 0', 'phone text', 'fee integer default 0']) try { db.exec('alter table txs add column ' + c); } catch {}
  db.exec('create unique index if not exists ux_txs_pid on txs(pid) where pid is not null; create index if not exists ix_txs_open on txs(type, status)');

  // ---- helpers ----
  function inTxn(fn) {   // all-or-nothing: if the process dies half way, nothing is saved
    if (inTxnDepth.get(db)) return fn();
    db.exec('BEGIN IMMEDIATE'); inTxnDepth.set(db, true);
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } finally { inTxnDepth.set(db, false); }
  }
  const get = id => db.prepare('select * from txs where id=?').get(id);
  const flag = note => { db.prepare('insert into flags(note) values(?)').run(String(note).slice(0, 500)); };
  const told = new Map();
  const alertOnce = (key, text, everyMs = 30 * 60000) => { if (clock() - (told.get(key) || 0) < everyMs) return; told.set(key, clock()); try { alert(text); } catch {} };
  const cbUrl = id => `${baseUrl.replace(/\/+$/, '')}/api/palpluss/webhook/${secret}/${id}`;
  const local = phone => '0' + String(phone).replace(/^254/, '');   // B2C docs show 07XXXXXXXX
  let holdUntil = 0;   // set when PalPluss rate-limits us, so we stop calling for a moment
  const apiOpen = () => clock() >= holdUntil;
  const onApiError = e => { if (e.kind === 'wait') holdUntil = clock() + Math.max(5, e.retryAfter || 30) * 1000; };
  let userCalls = [];   // limits how often players' own "check my deposit" clicks reach PalPluss (their limit is 60 requests a minute)
  const spend = () => { const now = clock(); userCalls = userCalls.filter(t => now - t < 60000); if (userCalls.length >= 20 || !apiOpen()) return false; userCalls.push(now); return true; };

  // ---------------- DEPOSITS ----------------
  async function startDeposit(uid, amt, phone, fee = 0) {   // the player pays amt + fee at M-Pesa; the wallet is credited amt
    const u = db.prepare('select phone from users where id=?').get(uid);
    const open = db.prepare("select id from txs where uid=? and type='deposit' and status='pending' and at>? order by id desc").get(uid, clock() - 90000);
    if (open) return { ok: true, id: open.id, reused: true, message: 'An M-Pesa prompt is already waiting on your phone. Enter your PIN, or wait a minute and try again.' };
    const id = Number(db.prepare("insert into txs(uid,type,amount,ref,status,at,phone,fee) values(?,?,?,?,?,?,?,?)").run(uid, 'deposit', amt, '', 'pending', clock(), phone || u.phone, fee).lastInsertRowid);
    const ref = 'D' + id; db.prepare('update txs set ref=? where id=?').run(ref, id);   // accountReference is limited to 12 characters
    try {
      const d = await pp.stkPush({ amount: amt + fee, phone: phone || u.phone, accountReference: ref, transactionDesc: 'GameArena', callbackUrl: cbUrl(id) });
      if (d.id) try { db.prepare('update txs set pid=?, upd=? where id=? and pid is null').run(d.id, clock(), id); } catch (e) { flag('Could not save PalPluss id for deposit ' + id + ': ' + e.message); }
      return { ok: true, id, message: 'Check your phone and enter your M-Pesa PIN' };
    } catch (e) {
      onApiError(e);
      if (e.kind === 'unsure') {   // we do not know whether the prompt went out: keep the row, the webhook or the background check will settle it
        db.prepare("update txs set note=? where id=?").run('unsure: ' + e.code, id);
        return { ok: true, id, message: 'Request sent. If no M-Pesa prompt appears within a minute, please try again.' };
      }
      db.prepare("update txs set status='failed', note=? where id=? and status='pending'").run(String(e.code || e.message).slice(0, 80), id);
      if (e.alert) alertOnce('dep:' + e.code, `Deposits are failing: PalPluss said ${e.code} (${e.message}). Fix this in your PalPluss console.`);
      return { error: e.userMessage || 'Payments are temporarily unavailable. Please try again shortly.', id };
    }
  }

  function creditDeposit(t, d) {
    try {
      if (Math.round(d.amount) !== t.amount + (t.fee || 0)) {
        inTxn(() => db.prepare("update txs set status='review', note=? where id=? and status in ('pending','failed')").run('amount mismatch', t.id));
        flag(`Deposit amount mismatch on tx ${t.id}: expected KES ${t.amount + (t.fee || 0)}, PalPluss says ${d.amount}. Not credited, check it in the PalPluss console.`); return 'review';
      }
      let credited = false;
      inTxn(() => {
        const c = db.prepare("update txs set status='done', pid=coalesce(pid,?), note=?, upd=? where id=? and status in ('pending','failed')").run(d.id, d.receipt ? 'receipt ' + d.receipt : '', clock(), t.id);
        if (c.changes) { add(t.uid, t.amount, 'M-Pesa deposit'); credited = true; }
      });
      if (credited) { pushBal(t.uid); if (t.status === 'failed' && !/^timeout/.test(t.note || '')) flag(`Deposit ${t.id} had failed but PalPluss later reported SUCCESS. It was credited; check it.`); }
    } catch (e) { flag(`Could not credit deposit ${t.id}: ${e.message}`); }
    return get(t.id).status;
  }

  function applyDeposit(t, d) {
    if (!d) return t.status;
    if ((d.ref && d.ref !== t.ref) || (d.type && d.type !== 'STK')) { flag(`PalPluss transaction ${d.id} (${d.type}, ref ${d.ref}) does not match deposit ${t.id} (ref ${t.ref}). Ignored.`); return get(t.id).status; }
    if (d.status === 'SUCCESS') return creditDeposit(t, d);
    if (d.status === 'FAILED' || d.status === 'CANCELLED') {
      const c = db.prepare("update txs set status='failed', note=?, pid=coalesce(pid,?), nexts=0 where id=? and status='pending'").run(d.status === 'CANCELLED' ? 'cancelled' : (d.desc || 'failed').slice(0, 80), d.id, t.id);
      if (c.changes) pushBal(t.uid);
    } else if (d.status === 'REVERSED' && t.status === 'done') flag(`Deposit ${t.id} was credited but PalPluss now says REVERSED. Check this account.`);
    else if (d.id && !t.pid) try { db.prepare('update txs set pid=? where id=? and pid is null').run(d.id, t.id); } catch {}
    return get(t.id).status;
  }

  async function depositStatus(uid, id) {   // the page polls this after a deposit
    const t = db.prepare("select * from txs where id=? and uid=? and type='deposit'").get(+id, uid); if (!t) return null;
    if (t.status === 'pending' && t.pid && clock() - (t.upd || 0) > 8000 && spend()) {
      db.prepare('update txs set upd=? where id=?').run(clock(), t.id);
      try { applyDeposit(t, await pp.getTransaction(t.pid)); } catch (e) { onApiError(e); }
    }
    return get(t.id).status;
  }

  // ---------------- WITHDRAWALS ----------------
  function refund(id, from, to, note) {   // returns the money to the player exactly once
    let done = false, uid;
    inTxn(() => {
      const t = get(id); if (!t) return;
      const c = db.prepare(`update txs set status=?, note=?, nexts=0 where id=? and status in (${from.map(() => '?').join(',')})`).run(to, String(note || '').slice(0, 120), id, ...from);
      if (c.changes) { add(t.uid, t.amount, to === 'rejected' ? 'withdrawal rejected' : 'withdrawal failed, refunded'); done = true; uid = t.uid; }
    });
    if (done) pushBal(uid);
    return done;
  }

  function createWithdrawal(uid, amt, phone, forceReview, fee = 0) {   // amt reaches the player's phone; the wallet is debited amt + fee   // wallet debit + record in one atomic step; the payout itself is sent right after
    let id, review = amt >= REVIEW || !!forceReview;
    inTxn(() => {
      const b = db.prepare('select balance from users where id=?').get(uid)?.balance || 0;
      if (b < amt + fee) throw Object.assign(new Error('Insufficient balance'), { user: true });
      add(uid, -(amt + fee), 'withdrawal');
      id = Number(db.prepare("insert into txs(uid,type,amount,ref,status,at,nexts,phone,fee) values(?,?,?,?,?,?,0,?,?)").run(uid, 'withdraw', amt + fee, '', review ? 'review' : 'queued', clock(), phone || null, fee).lastInsertRowid);
      db.prepare('update txs set ref=?, idem=? where id=?').run('WD-' + id, 'gamearena-wd-' + id, id);
    });
    pushBal(uid);
    if (review) alertOnce('review', `A withdrawal of KES ${amt} is waiting for your approval in the admin page.`, 10 * 60000);
    else setImmediate(() => sendPayout(id).catch(e => flag('Payout send crashed for ' + id + ': ' + e.message)));   // do not make the player wait
    return { id, review };
  }

  async function sendPayout(id) {
    const t0 = get(id); if (!t0 || t0.status !== 'queued') return;
    const now = clock();
    // lease: if two code paths try at once only one wins, and a crash mid-send does not cause an instant re-send
    const lease = db.prepare("update txs set nexts=?, tries=tries+1, upd=? where id=? and status='queued' and nexts<=?").run(now + 60000, now, id, now);
    if (!lease.changes) return;
    const t = get(id), u = db.prepare('select phone from users where id=?').get(t.uid);
    try {
      if (/^unsure/.test(t.note || '')) {   // an earlier attempt may have gone through: ask PalPluss before sending again
        const found = await pp.findByReference('B2C', t.ref, t.at);
        if (found) { db.prepare("update txs set status='pending', pid=coalesce(pid,?), note='', nexts=0 where id=? and status='queued'").run(found.id, id); return applyWithdraw(get(id), found); }
      }
      const d = await pp.b2c({ amount: t.amount - (t.fee || 0), phone: local(t.phone || u.phone), reference: t.ref, description: 'GameArena payout', callbackUrl: cbUrl(id), idempotencyKey: t.idem });
      db.prepare("update txs set status='pending', pid=?, note='', upd=?, nexts=? where id=? and status='queued'").run(d.id, clock(), clock() + 15000, id);
      if (d.status === 'SUCCESS' || d.status === 'FAILED') applyWithdraw(get(id), d);
    } catch (e) { onPayoutError(get(id), e); }
  }

  function onPayoutError(t, e) {
    onApiError(e); const now = clock();
    const sticky = /^unsure/.test(t.note || '') ? 'unsure ' : '';   // once a send was unconfirmed, always look it up before sending again
    const later = ms => db.prepare("update txs set nexts=?, note=? where id=? and status='queued'").run(now + ms, (sticky + e.kind + ': ' + e.code).slice(0, 80), t.id);
    if (e.kind === 'fatal') { refund(t.id, ['queued'], 'failed', e.code); if (e.alert) alertOnce('pay:' + e.code, `Withdrawals are being refused by PalPluss: ${e.code} (${e.message}). Fix this in your PalPluss console.`); }
    else if (e.kind === 'hold') { later(60000); alertOnce('hold:' + e.code, `Withdrawals are waiting: PalPluss says ${e.code} (${e.message}). Top up your PalPluss B2C wallet or service wallet. Players are refunded automatically after ${QUEUE_MAX / 60000} minutes.`, 15 * 60000); }
    else if (e.kind === 'wait') later(Math.max(5, e.retryAfter || 30) * 1000 + 1000);
    else if (e.kind === 'notsent') later(Math.min(5 * 60000, 20000 * t.tries));
    else {   // unsure: it may have been paid. Never refund or blindly re-send; look it up first, and after 3 tries hand it to a person.
      db.prepare("update txs set note=? where id=? and status='queued'").run('unsure: ' + e.code, t.id);
      if (t.tries >= 3) { db.prepare("update txs set status='review' where id=? and status='queued'").run(t.id); flag(`Withdrawal ${t.id} (${t.ref}) could not be confirmed with PalPluss. Search ${t.ref} in the PalPluss console: if it is there, mark it paid there; if not, approve it here to send again.`); alertOnce('unsure' + t.id, `Withdrawal ${t.ref} needs a manual check in the admin page.`); }
      else later(Math.min(5 * 60000, 30000 * t.tries));
    }
  }

  function applyWithdraw(t, d) {
    if (!d || !t) return t?.status;
    if ((d.ref && d.ref !== t.ref) || (d.type && d.type !== 'B2C')) { flag(`PalPluss transaction ${d.id} (${d.type}, ref ${d.ref}) does not match withdrawal ${t.id} (ref ${t.ref}). Ignored.`); return get(t.id).status; }
    if (d.id && !t.pid) try { db.prepare('update txs set pid=? where id=? and pid is null').run(d.id, t.id); } catch {}
    if (d.status === 'SUCCESS') {
      const c = db.prepare("update txs set status='done', note=?, nexts=0 where id=? and status in ('pending','queued','review')").run(d.receipt ? 'receipt ' + d.receipt : '', t.id);
      if (c.changes) pushBal(t.uid); else if (['failed', 'rejected'].includes(t.status)) flag(`PalPluss PAID withdrawal ${t.id} (${t.ref}) but it was already refunded to the wallet. Check this account.`);
    } else if (['FAILED', 'REVERSED', 'CANCELLED'].includes(d.status)) {
      if (!refund(t.id, ['pending', 'queued'], 'failed', d.status.toLowerCase() + (d.desc ? ': ' + d.desc : '')) && t.status === 'done' && d.status === 'REVERSED') flag(`Withdrawal ${t.id} was paid but PalPluss now says REVERSED. Check this account.`);
    }
    return get(t.id).status;
  }

  const adminApprove = async id => {   // a person approved a held withdrawal: send it now
    const c = db.prepare("update txs set status='queued', nexts=0 where id=? and type='withdraw' and status='review'").run(+id); if (!c.changes) return false;
    await sendPayout(+id); return true;
  };
  const adminReject = id => { const t = get(+id); return !!t && t.type === 'withdraw' && refund(t.id, ['review'], 'rejected', 'rejected by admin'); };

  // ---------------- WEBHOOK ----------------
  // PalPluss does not sign webhooks, so the body is treated as a hint only. We re-read the transaction from PalPluss with our API key.
  const bodyId = b => { const x = b?.transaction || b?.data || b || {}; return x.id || x.transactionId || x.transaction_id || null; };
  async function webhook(localId, body) {
    const t = get(+localId); if (!t || !['deposit', 'withdraw'].includes(t.type)) return 'unknown';
    const claimed = bodyId(body); if (t.pid && claimed && claimed !== t.pid) { flag(`Webhook for ${t.ref} named a different PalPluss transaction (${claimed}, expected ${t.pid}). Ignored.`); return 'mismatch'; }
    let d; try { d = (t.pid || claimed) ? await pp.getTransaction(t.pid || claimed) : await pp.findByReference(t.type === 'deposit' ? 'STK' : 'B2C', t.ref, t.at); } catch (e) { onApiError(e); return 'later'; }   // the background job will pick it up
    if (!d) return 'notfound';
    return t.type === 'deposit' ? applyDeposit(t, d) : applyWithdraw(t, d);
  }

  // ---------------- BACKGROUND JOB (every 10 seconds) ----------------
  const pollGap = age => age < 120000 ? 15000 : age < 600000 ? 30000 : 60000;
  let running = false, timer = null, svcAt = 0;
  async function tick() {
    if (running) return; running = true;
    try {
      const now = clock();
      // 1. payouts that are waiting to be (re)sent. Too old and still refused => refund the player, so nobody waits for ever.
      for (const t of db.prepare("select * from txs where type='withdraw' and status='queued' and nexts<=? order by id limit 10").all(now)) {
        if (now - t.at > QUEUE_MAX && !/^unsure/.test(t.note || '')) { if (refund(t.id, ['queued'], 'failed', 'payouts unavailable, refunded')) flag(`Withdrawal ${t.id} was refunded after waiting ${QUEUE_MAX / 60000} minutes (${t.note}).`); continue; }
        if (apiOpen()) await sendPayout(t.id);
      }
      // 2. sent payouts: ask PalPluss for the result in case the webhook never came
      let budget = 6;
      for (const t of db.prepare("select * from txs where type='withdraw' and status='pending' and nexts<=? order by id limit 6").all(now)) {
        if (!apiOpen() || budget-- <= 0) break; const age = now - t.at;
        db.prepare('update txs set nexts=? where id=?').run(now + pollGap(age), t.id);
        try { applyWithdraw(t, t.pid ? await pp.getTransaction(t.pid) : await pp.findByReference('B2C', t.ref, t.at)); } catch (e) { onApiError(e); }
        const f = get(t.id);
        if (f.status === 'pending' && age > STUCK && f.note !== 'stuck') { db.prepare("update txs set note='stuck' where id=?").run(t.id); flag(`Withdrawal ${t.id} (${t.ref}) has been pending for over 10 minutes. Check it in the PalPluss console.`); alertOnce('stuck' + t.id, `Withdrawal ${t.ref} (KES ${t.amount}) has been pending over 10 minutes.`); }
      }
      // 3. deposits waiting for M-Pesa, plus expired ones that might still be confirmed late
      for (const t of db.prepare("select * from txs where type='deposit' and nexts<=? and (status='pending' or (status='failed' and note like 'timeout%' and at>?)) order by id limit 6").all(now, now - LATE_WINDOW)) {
        const age = now - t.at, late = t.status === 'failed';
        if (!late && age < 20000) continue;   // give the webhook a head start
        if (!apiOpen() || budget-- <= 0) break;
        db.prepare('update txs set nexts=? where id=?').run(now + (late ? 600000 : pollGap(age)), t.id);
        let d = null; try { d = t.pid ? await pp.getTransaction(t.pid) : await pp.findByReference('STK', t.ref, t.at); } catch (e) { onApiError(e); continue; }
        const s = d ? applyDeposit(t, d) : t.status;
        if (s === 'pending' && age > DEP_EXPIRE) { const c = db.prepare("update txs set status='failed', note='timeout', nexts=? where id=? and status='pending'").run(clock() + 600000, t.id); if (c.changes) pushBal(t.uid); }
      }
      // 4. warnings: withdrawals waiting for approval, and a PalPluss service wallet that is running out (it makes every payment fail at zero)
      const waiting = db.prepare("select count(*) c from txs where type='withdraw' and status='review' and at<?").get(now - 15 * 60000).c;
      if (waiting) alertOnce('review-old', `${waiting} withdrawal(s) have been waiting for approval for over 15 minutes. Open the admin page.`, 30 * 60000);
      if (now - svcAt > 5 * 60000 && apiOpen() && pp.serviceBalance) { svcAt = now; try { const b = await pp.serviceBalance(); if (b < LOW_SERVICE) alertOnce('svc', `Your PalPluss service wallet is low (KES ${b}). When it reaches zero deposits and withdrawals stop. Top it up in the PalPluss console.`, 6 * 3600000); } catch (e) { onApiError(e); } }
    } catch (e) { console.error('payments tick failed:', e); } finally { running = false; }
  }
  const start = () => { if (timer) return; timer = setInterval(tick, +E.PAYMENTS_TICK_MS || 10000); timer.unref?.(); setTimeout(tick, 3000).unref?.(); };
  const stop = () => { clearInterval(timer); timer = null; };

  const overview = () => ({
    review: db.prepare("select t.id, t.ref, t.amount, t.created, t.note, u.name, u.phone from txs t join users u on u.id=t.uid where t.type='withdraw' and t.status='review' order by t.id").all(),
    queued: db.prepare("select t.id, t.ref, t.amount, t.created, t.note, u.phone from txs t join users u on u.id=t.uid where t.type='withdraw' and t.status='queued' order by t.id").all(),
    stuck: db.prepare("select t.id, t.ref, t.amount, t.created, u.phone from txs t join users u on u.id=t.uid where t.type='withdraw' and t.status='pending' and t.at < ? order by t.id").all(clock() - STUCK),
  });
  return { startDeposit, depositStatus, createWithdrawal, sendPayout, adminApprove, adminReject, webhook, tick, start, stop, overview, applyDeposit, applyWithdraw, _get: get };
}
module.exports = createPayments;
