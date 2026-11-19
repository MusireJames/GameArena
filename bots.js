'use strict';
// Computer opponents. Pure game logic: no database, no sockets. server.js decides WHEN a bot plays; this file only decides WHAT it plays.
//   tictactoe  perfect play (minimax): it can never lose
//   connect4   alpha-beta search, 6 moves deep
//   reversi    alpha-beta search, 4 moves deep (exact in the last 9 moves) with corner/edge weights and mobility
//   gomoku     pattern scoring of every cell (attack + defence), picks wins and blocks first
//   checkers   alpha-beta search, 7 moves deep, forced captures and multi-jumps included
//   chess      alpha-beta search, up to 3 plies within a time budget (needs chess.js; the room's Chess object is used and left unchanged)
//   ludo       rule-based: capture > reach home > leave the yard > escape danger > use safe squares > advance
// A bot is strong, not unbeatable (except Tic-Tac-Toe). A strong human can still win, so server.js also caps how much a bot may lose per day.
const BG = require('./boardgames');
const CK = require('./checkers');
const rnd = n => Math.floor(Math.random() * n);
const best = (items, score) => { let m = -Infinity, out = []; for (const it of items) { const s = score(it); if (s > m + 1e-9) { m = s; out = [it]; } else if (Math.abs(s - m) <= 1e-9) out.push(it); } return out[rnd(out.length)]; };

// ---- Tic-Tac-Toe: board of 'X' / 'O' / '' ; X is side 0 ----
const TL = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const tWin = b => { const l = TL.find(l => b[l[0]] && l.every(k => b[k] === b[l[0]])); return l ? b[l[0]] : null; };
function tScore(b, turn, me, depth) {   // +10-depth if `me` wins, -(10-depth) if the opponent wins, 0 draw
  const w = tWin(b); if (w) return w === me ? 10 - depth : depth - 10;
  const free = []; b.forEach((x, i) => { if (!x) free.push(i); }); if (!free.length) return 0;
  const other = turn === 'X' ? 'O' : 'X'; let best_ = turn === me ? -Infinity : Infinity;
  for (const i of free) { b[i] = turn; const s = tScore(b, other, me, depth + 1); b[i] = '';
    best_ = turn === me ? Math.max(best_, s) : Math.min(best_, s); }
  return best_;
}
function tictactoe(board, side) {
  const me = side ? 'O' : 'X', other = side ? 'X' : 'O', b = board.slice(), free = [];
  b.forEach((x, i) => { if (!x) free.push(i); }); if (!free.length) return null;
  return { i: best(free, i => { b[i] = me; const s = tScore(b, other, me, 1); b[i] = ''; return s; }) };
}

// ---- Connect Four (7 x 6, cells 0 / 1 / 2) ----
const C4W = 7, C4H = 6, C4ORDER = [3, 2, 4, 1, 5, 0, 6], C4WIN = [];
for (let r = 0; r < C4H; r++) for (let c = 0; c < C4W; c++) for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
  const cells = []; for (let k = 0; k < 4; k++) { const rr = r + dr * k, cc = c + dc * k; if (rr < 0 || rr >= C4H || cc < 0 || cc >= C4W) break; cells.push(rr * C4W + cc); }
  if (cells.length === 4) C4WIN.push(cells);
}
function c4eval(b, p) {   // from p's point of view
  const q = 3 - p; let s = 0;
  for (let r = 0; r < C4H; r++) { const v = b[r * C4W + 3]; if (v === p) s += 3; else if (v === q) s -= 3; }
  for (const w of C4WIN) { let a = 0, o = 0; for (const i of w) { if (b[i] === p) a++; else if (b[i] === q) o++; }
    if (a && o) continue; if (a === 3) s += 6; else if (a === 2) s += 2; else if (o === 3) s -= 7; else if (o === 2) s -= 2; }
  return s;
}
const c4drop = (b, c, p) => { let r = C4H - 1; while (r >= 0 && b[r * C4W + c]) r--; if (r < 0) return -1; b[r * C4W + c] = p; return r * C4W + c; };
function c4search(b, p, depth, alpha, beta) {   // negamax: score for p, who is to move
  let any = false;
  for (const c of C4ORDER) {
    const i = c4drop(b, c, p); if (i < 0) continue; any = true;
    let s;
    if (BG.run(b, C4W, C4H, i, p, 4)) s = 100000 + depth;
    else if (depth <= 1) s = -c4eval(b, 3 - p);
    else s = -c4search(b, 3 - p, depth - 1, -beta, -alpha);
    b[i] = 0;
    if (s > alpha) alpha = s; if (alpha >= beta) return alpha;
  }
  return any ? alpha : 0;
}
function connect4(board, side) {
  const p = side + 1, b = board.slice(), cols = C4ORDER.filter(c => !b[c]); if (!cols.length) return null;
  const scored = cols.map(c => { const i = c4drop(b, c, p); let s;
    if (BG.run(b, C4W, C4H, i, p, 4)) s = 1e6; else s = -c4search(b, 3 - p, 5, -1e7, 1e7); b[i] = 0; return { c, s }; });
  const top = Math.max(...scored.map(x => x.s)); const pool = scored.filter(x => x.s >= top - 0.5);
  return { c: pool[rnd(pool.length)].c };
}

// ---- Reversi (8 x 8) ----
const RW = [120,-20,20,5,5,20,-20,120, -20,-40,-5,-5,-5,-5,-40,-20, 20,-5,15,3,3,15,-5,20, 5,-5,3,3,3,3,-5,5,
            5,-5,3,3,3,3,-5,5, 20,-5,15,3,3,15,-5,20, -20,-40,-5,-5,-5,-5,-40,-20, 120,-20,20,5,5,20,-20,120];
const rvMoves = (b, p) => { const m = []; for (let i = 0; i < 64; i++) if (!b[i]) { const f = BG.flips(b, i, p); if (f.length) m.push([i, f]); } return m; };
function rvEval(b, p) {
  let s = 0, a = 0, z = 0; for (let i = 0; i < 64; i++) { if (b[i] === p) { s += RW[i]; a++; } else if (b[i]) { s -= RW[i]; z++; } }
  const mob = rvMoves(b, p).length - rvMoves(b, 3 - p).length; return s + 6 * mob + (a + z > 54 ? 10 * (a - z) : 0);
}
function rvSearch(b, p, depth, alpha, beta, passed) {
  const ms = rvMoves(b, p);
  if (!ms.length) { if (passed) { let a = 0, z = 0; b.forEach(x => { if (x === p) a++; else if (x) z++; }); return (a - z) * 1000; }
    return -rvSearch(b, 3 - p, depth, -beta, -alpha, true); }
  if (depth === 0) return rvEval(b, p);
  ms.sort((x, y) => RW[y[0]] - RW[x[0]]);
  for (const [i, f] of ms) {
    b[i] = p; f.forEach(k => b[k] = p);
    const s = -rvSearch(b, 3 - p, depth - 1, -beta, -alpha, false);
    b[i] = 0; f.forEach(k => b[k] = 3 - p);
    if (s > alpha) alpha = s; if (alpha >= beta) break;
  }
  return alpha;
}
function reversi(board, side) {
  const p = side + 1, b = board.slice(), ms = rvMoves(b, p); if (!ms.length) return null;
  const empties = b.filter(x => !x).length, depth = empties <= 9 ? empties : 4;
  const scored = ms.map(([i, f]) => { b[i] = p; f.forEach(k => b[k] = p);
    const s = -rvSearch(b, 3 - p, depth - 1, -1e9, 1e9, false); b[i] = 0; f.forEach(k => b[k] = 3 - p); return { i, s }; });
  const top = Math.max(...scored.map(x => x.s)); const pool = scored.filter(x => x.s >= top - (empties <= 9 ? 0 : 2));
  return { i: pool[rnd(pool.length)].i };
}

// ---- Gomoku (15 x 15, five in a row) ----
const GW = 15, GN = [[0, 1], [1, 0], [1, 1], [1, -1]];
const GPAT = (n, open) => n >= 5 ? 100000 : n === 4 ? (open === 2 ? 10000 : open === 1 ? 1500 : 0) : n === 3 ? (open === 2 ? 1500 : open === 1 ? 120 : 0) : n === 2 ? (open === 2 ? 120 : open === 1 ? 10 : 0) : (open === 2 ? 8 : 1);
function gCell(b, i, p) {   // how valuable would a piece of p at empty cell i be
  const r0 = Math.floor(i / GW), c0 = i % GW; let s = 0, threes = 0;
  for (const [dr, dc] of GN) { let n = 1, open = 0;
    for (const sg of [1, -1]) { let r = r0 + dr * sg, c = c0 + dc * sg;
      while (r >= 0 && r < GW && c >= 0 && c < GW && b[r * GW + c] === p) { n++; r += dr * sg; c += dc * sg; }
      if (r >= 0 && r < GW && c >= 0 && c < GW && !b[r * GW + c]) open++; }
    const v = GPAT(n, open); s += v; if (v >= 1500 && v < 10000) threes++; }
  return s + (threes >= 2 ? 6000 : 0);   // two threats at once usually wins
}
function gomoku(board, side) {
  const p = side + 1, q = 3 - p, b = board, n = b.filter(Boolean).length;
  if (!n) return { i: 7 * GW + 7 };
  const cand = new Set();
  b.forEach((x, i) => { if (!x) return; const r = Math.floor(i / GW), c = i % GW;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) { const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < GW && cc >= 0 && cc < GW && !b[rr * GW + cc]) cand.add(rr * GW + cc); } });
  if (!cand.size) return null;
  const centre = i => 7 - Math.max(Math.abs(Math.floor(i / GW) - 7), Math.abs(i % GW - 7));
  return { i: best([...cand], i => gCell(b, i, p) * 1.05 + gCell(b, i, q) + centre(i) * 0.1) };
}

// ---- Checkers ----
function ckEval(b, me) {
  let s = 0;
  for (let i = 0; i < 64; i++) { const x = b[i]; if (!x) continue; const mine = CK.ckSide(x) === me, king = x === x.toUpperCase();
    const row = i >> 3, adv = x.toLowerCase() === 'w' ? 7 - row : row, centre = 3 - Math.abs(3.5 - (i & 7)) ;
    let v = king ? 175 : 100 + adv * 4; v += centre * 2; if (!king && adv === 0) v += 6;   // keep the back row home as long as possible
    s += mine ? v : -v; }
  return s;
}
function ckSearch(b, side, must, depth, alpha, beta, me) {
  const ms = CK.ckMoves(b, side, must); if (!ms.length) return side === me ? -10000 - depth : 10000 + depth;
  if (depth <= 0 && must == null) return ckEval(b, me);
  const max = side === me; let v = max ? -Infinity : Infinity;
  for (const mv of ms) {
    const r = CK.ckApply(b, side, mv, must); let s;
    if (r.winner != null) s = (r.winner === me ? 10000 : -10000) + (r.winner === me ? depth : -depth);
    else s = ckSearch(r.b, r.side, r.mustFrom, r.side === side ? depth : depth - 1, alpha, beta, me);   // a jump that continues keeps the same player and depth
    if (max) { if (s > v) v = s; if (v > alpha) alpha = v; } else { if (s < v) v = s; if (v < beta) beta = v; }
    if (alpha >= beta) break;
  }
  return v;
}
function checkers(board, side, must) {
  const ms = CK.ckMoves(board, side, must); if (!ms.length) return null;
  const scored = ms.map(mv => { const r = CK.ckApply(board, side, mv, must);
    const s = r.winner != null ? 1e5 : ckSearch(r.b, r.side, r.mustFrom, 6, -1e9, 1e9, side); return { mv, s }; });
  const top = Math.max(...scored.map(x => x.s)); const pool = scored.filter(x => x.s >= top - 1);
  const c = pool[rnd(pool.length)].mv; return { from: c.from, to: c.to };
}

// ---- Chess (uses the room's chess.js game; every move tried is undone) ----
const PV = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 0 };
function chEval(ch) {   // from the point of view of the side to move
  let s = 0; const bd = ch.board();
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { const x = bd[r][c]; if (!x) continue;
    let v = PV[x.type]; const cen = 3.5 - Math.max(Math.abs(3.5 - r), Math.abs(3.5 - c));   // centre bonus 0..3
    if (x.type === 'n' || x.type === 'b') v += cen * 8; else if (x.type === 'p') { v += cen * 3; v += (x.color === 'w' ? 6 - r : r - 1) * 4; } else if (x.type === 'k') v -= cen * 4;
    s += x.color === 'w' ? v : -v; }
  return ch.turn() === 'w' ? s : -s;
}
function chOrder(ms) { return ms.map(m => ({ m, k: (m.captured ? 10 + PV[m.captured] / 100 : 0) + (m.promotion ? 9 : 0) + (/[+#]/.test(m.san) ? 3 : 0) + Math.random() })).sort((a, b) => b.k - a.k).map(x => x.m); }
function chess(ch, ms_budget = 2500) {
  try { return chessSearch(ch, ms_budget); }
  catch (e) { const l = ch.moves({ verbose: true }); return l.length ? { from: l[0].from, to: l[0].to } : null; }   // never leave a game stuck
}
function chessSearch(ch, ms_budget) {
  const t0 = Date.now(); let stop = false, bestMove = null, nodes = 0;
  const timeUp = () => { if ((++nodes & 255) === 0 && Date.now() - t0 > ms_budget) stop = true; return stop; };
  const mvv = m => (m.captured ? 10 * PV[m.captured] - PV[m.piece] / 10 : 0) + (m.promotion ? 800 : 0);
  const qs = (alpha, beta, d) => {   // only captures are searched at the end, so a piece is never left hanging at the horizon
    if (timeUp()) return 0;
    const stand = chEval(ch); if (d <= 0 || stand >= beta) return stand; if (stand > alpha) alpha = stand;
    const caps = ch.moves({ verbose: true }).filter(m => m.captured || m.promotion).sort((x, y) => mvv(y) - mvv(x));
    for (const m of caps) { ch.move({ from: m.from, to: m.to, promotion: m.promotion }); const s = -qs(-beta, -alpha, d - 1); ch.undo(); if (stop) return 0; if (s >= beta) return s; if (s > alpha) alpha = s; }
    return alpha;
  };
  const search = (d, alpha, beta) => {
    if (timeUp()) return 0;
    if (ch.isCheckmate()) return -99000 - d; if (ch.isDraw()) return 0; if (d === 0) return qs(alpha, beta, 4);
    const ms = ch.moves({ verbose: true }).map(m => ({ m, k: mvv(m) + (/[+#]/.test(m.san) ? 50 : 0) + Math.random() })).sort((x, y) => y.k - x.k);
    for (const { m } of ms) {
      ch.move({ from: m.from, to: m.to, promotion: m.promotion }); const s = -search(d - 1, -beta, -alpha); ch.undo();
      if (stop) return 0; if (s > alpha) alpha = s; if (alpha >= beta) break;
    }
    return alpha;
  };
  const root = ch.moves({ verbose: true }); if (!root.length) return null;
  bestMove = root[rnd(root.length)]; let order = root.map(m => ({ m, k: mvv(m) + Math.random() })).sort((x, y) => y.k - x.k).map(x => x.m);
  for (let depth = 1; depth <= 5; depth++) {
    let alpha = -1e9; const scored = [];
    for (const m of order) {
      ch.move({ from: m.from, to: m.to, promotion: m.promotion }); const s = -search(depth - 1, -1e9, -alpha); ch.undo();
      if (stop) break; scored.push({ m, s }); if (s > alpha) alpha = s;
    }
    if (stop || scored.length < order.length) break;
    scored.sort((x, y) => y.s - x.s); bestMove = scored[0].m; order = scored.map(x => x.m);   // the best move of this depth is searched first next time
    if (scored[0].s > 90000) break;
  }
  return { from: bestMove.from, to: bestMove.to };
}

// ---- Ludo: returns the token index to move (the dice are rolled by the server for bots exactly as for people) ----
function ludo(L, p, legal, SAFE, seats) {
  const toks = legal; if (!toks.length) return null; const d = L.die, st = seats[p] * 13;
  const opp = []; L.pos.forEach((arr, q) => { if (q === p) return; arr.forEach(y => { if (y >= 0 && y <= 50) opp.push({ g: (seats[q] * 13 + y) % 52, y }); }); });
  const threat = g => opp.some(o => { const k = (g - o.g + 52) % 52; return k >= 1 && k <= 6; });
  const score = t => {
    const x = L.pos[p][t], n = x < 0 ? 0 : x + d; let s = n * 0.3;
    if (n === 56) s += 90; if (x < 0) s += 60; if (n >= 51 && n < 56) s += 40;
    if (n <= 50) { const g = (st + n) % 52, safe = SAFE.includes(g);
      const hit = opp.find(o => o.g === g); if (hit && !safe) s += 100 + hit.y * 0.5;
      if (safe) s += 25; else if (threat(g)) s -= 30; }
    if (x >= 0 && x <= 50) { const g0 = (st + x) % 52; if (!SAFE.includes(g0) && threat(g0)) s += 30; }
    return s; };
  return best(toks, score);
}

/** What should the bot (playing seat `side`) play now? Returns the same shape as the `move` event a person would send, or null. */
function pickMove(r, side, deps = {}) {
  switch (r.game) {
    case 'tictactoe': return tictactoe(r.board, side);
    case 'connect4': return connect4(r.board, side);
    case 'reversi': return reversi(r.board, side);
    case 'gomoku': return gomoku(r.board, side);
    case 'checkers': return checkers(r.ck, side, r.mustFrom);
    case 'chess': return chess(r.chess);
    case 'ludo': { const t = ludo(r.ludo, side, deps.lmov(r.ludo, side), deps.SAFE, r.ludo.seat); return t == null ? null : { t }; }
  }
  return null;
}
/** Any legal move at all: the safety net used when the real bot fails to move, so a game can never freeze. */
function anyMove(r, side, deps = {}) {
  const pick = a => a.length ? a[rnd(a.length)] : null;
  switch (r.game) {
    case 'tictactoe': { const f = r.board.map((x, i) => x ? -1 : i).filter(i => i >= 0); const i = pick(f); return i == null ? null : { i }; }
    case 'connect4': { const f = [0, 1, 2, 3, 4, 5, 6].filter(c => !r.board[c]); const c = pick(f); return c == null ? null : { c }; }
    case 'gomoku': { const f = r.board.map((x, i) => x ? -1 : i).filter(i => i >= 0); const i = pick(f); return i == null ? null : { i }; }
    case 'reversi': { const i = pick(BG.legal('reversi', r.board, side).map(m => Array.isArray(m) ? m[0] : m)); return i == null ? null : { i }; }
    case 'checkers': { const m = pick(CK.ckMoves(r.ck, side, r.mustFrom)); return m ? { from: m.from, to: m.to } : null; }
    case 'chess': { const m = pick(r.chess.moves({ verbose: true })); return m ? { from: m.from, to: m.to, promotion: 'q' } : null; }
    case 'ludo': { const t = pick(deps.lmov(r.ludo, side)); return t == null ? null : { t }; }
  }
  return null;
}
const NAMES = ['Amani', 'Zuri', 'Jabali', 'Tumaini', 'Neema', 'Baraka', 'Safari', 'Imani'];
module.exports = { anyMove, pickMove, NAMES, tictactoe, connect4, reversi, gomoku, checkers, chess, ludo };
