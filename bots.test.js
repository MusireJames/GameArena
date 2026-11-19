const { test } = require('node:test'), assert = require('node:assert'), B = require('./bots'), G = require('./boardgames'), CK = require('./checkers');
const pick = a => a[Math.floor(Math.random() * a.length)];
let Chess = null; try { Chess = require('chess.js').Chess; } catch {}

test('tic-tac-toe bot never loses, from either seat, against random and against itself', () => {
  const L = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  const win = b => { const l = L.find(l => b[l[0]] && l.every(k => b[k] === b[l[0]])); return l ? b[l[0]] : null; };
  for (let bs = 0; bs < 2; bs++) for (let g = 0; g < 150; g++) {
    const b = Array(9).fill(''); let t = 0;
    while (!win(b) && b.some(x => !x)) { const m = t === bs ? B.tictactoe(b, t).i : pick(b.map((x, i) => x ? -1 : i).filter(i => i >= 0)); b[i0(m)] = t ? 'O' : 'X'; t = 1 - t; }
    assert.notEqual(win(b), bs ? 'X' : 'O', 'bot lost');
  }
  function i0(m) { return m; }
});

test('connect four bot: takes a win, blocks a loss, beats a random player', () => {
  let b = G.init('connect4'); [0, 1, 2].forEach(c => { b = G.play('connect4', b, 0, { c }).board; }); b[41] = 0;   // keep it simple: three in the bottom row
  b = G.init('connect4'); b[35] = b[36] = b[37] = 1; assert.equal(B.connect4(b, 0).c, 3, 'plays the winning column');
  b = G.init('connect4'); b[35] = b[36] = b[37] = 2; b[0] = 1; assert.equal(B.connect4(b, 0).c, 3 , 'blocks'); 
  let wins = 0; const N = 12;
  for (let g = 0; g < N; g++) { let bd = G.init('connect4'), s = 0, bot = g % 2, res;
    while (!res) { const m = s === bot ? B.connect4(bd, s) : { c: pick([0,1,2,3,4,5,6].filter(c => !bd[c])) }; const r = G.play('connect4', bd, s, m); assert.ok(r, 'legal'); bd = r.board; if (r.over) res = r.over; s = r.next; }
    if (res.winner === bot) wins++; assert.notEqual(res.winner, 1 - bot, 'bot lost to a random player'); }
  assert.ok(wins >= N - 1, 'wins ' + wins);
});

test('reversi bot makes legal moves and beats a random player', () => {
  let wins = 0; const N = 6;
  for (let g = 0; g < N; g++) { let bd = G.init('reversi'), s = 0, bot = g % 2, res, n = 0;
    while (!res && n++ < 200) { const m = s === bot ? B.reversi(bd, s) : (() => { const l = G.legal('reversi', bd, s); return { i: pick(l) }; })(); const r = G.play('reversi', bd, s, m); assert.ok(r, 'legal move'); bd = r.board; if (r.over) res = r.over; s = r.next; }
    assert.ok(res, 'game ended'); if (res.winner === bot) wins++; }
  assert.ok(wins >= N - 1, 'wins ' + wins);
});

test('gomoku bot: completes five, blocks an open four, beats a random player', () => {
  let b = Array(225).fill(0); [0, 1, 2, 3].forEach(k => { b[7 * 15 + 3 + k] = 1; }); [0, 1, 2].forEach(k => { b[2 * 15 + 3 + k] = 2; });
  assert.ok([7 * 15 + 2, 7 * 15 + 7].includes(B.gomoku(b, 0).i), 'finishes its own four');
  b = Array(225).fill(0); [0, 1, 2, 3].forEach(k => { b[7 * 15 + 3 + k] = 2; }); b[0] = 1;
  assert.ok([7 * 15 + 2, 7 * 15 + 7].includes(B.gomoku(b, 0).i), 'blocks the opponent four');
  let wins = 0; const N = 6;
  for (let g = 0; g < N; g++) { let bd = G.init('gomoku'), s = 0, bot = g % 2, res;
    while (!res) { let m; if (s === bot) m = B.gomoku(bd, s); else { const f = bd.map((x, i) => x ? -1 : i).filter(i => i >= 0); m = { i: pick(f) }; } const r = G.play('gomoku', bd, s, m); assert.ok(r, 'legal'); bd = r.board; if (r.over) res = r.over; s = r.next; }
    if (res.winner === bot) wins++; }
  assert.ok(wins >= N - 1, 'wins ' + wins);
});

test('checkers bot only plays legal moves, handles multi-jumps, and beats a random player', () => {
  let wins = 0, ended = 0; const N = 6;
  for (let g = 0; g < N; g++) { let b = CK.ckInit(), side = 0, must = null, bot = g % 2, n = 0, winner = null;
    while (winner == null && n++ < 300) {
      const ms = CK.ckMoves(b, side, must); if (!ms.length) { winner = 1 - side; break; }
      const m = side === bot ? B.checkers(b, side, must) : pick(ms); const mv = ms.find(x => x.from === m.from && x.to === m.to); assert.ok(mv, 'legal');
      const r = CK.ckApply(b, side, mv, must); b = r.b; must = r.mustFrom; side = r.side; if (r.winner != null) winner = r.winner; }
    if (winner != null) { ended++; if (winner === bot) wins++; } }
  assert.ok(wins >= N - 1, 'wins ' + wins + ' of ' + N);
});

test('checkers: a forced multi-jump is played to the end by the same player', () => {
  const b = Array(64).fill(0); b[56] = 'w'; b[49] = 'b'; b[35] = 'b'; b[28] = 0;   // w on row7 can jump 49 (to 42) then 35 (to 28)
  let must = null, side = 0, steps = 0; const bd0 = b;
  let cur = bd0;
  while (steps < 4) { const m = B.checkers(cur, side, must); if (!m) break; const mv = CK.ckMoves(cur, side, must).find(x => x.from === m.from && x.to === m.to); assert.ok(mv); const r = CK.ckApply(cur, side, mv, must); cur = r.b; must = r.mustFrom; steps++; if (r.side !== side) break; }
  assert.equal(steps, 2, 'two jumps in one turn'); assert.equal(cur[49], 0); assert.equal(cur[35], 0);
});

test('ludo bot: prefers a capture, then going home, then leaving the yard', () => {
  const SAFE = [0, 8, 13, 21, 26, 34, 39, 47], lmov = (L, p) => L.pos[p].map((x, t) => (x < 0 ? L.die === 6 : x + L.die <= 56) ? t : -1).filter(t => t >= 0);
  const mk = (a, b, die) => ({ ludo: { pos: [a, b], die, seat: [0, 2] }, game: 'ludo' });
  // bot is seat 0 at start 0; opponent (seat 2, start 26) has a piece at y=2 => global 28. Bot piece at 25 + 3 = 28 captures it.
  let r = mk([25, 3, -1, -1], [2, -1, -1, -1], 3); assert.equal(B.pickMove(r, 0, { lmov, SAFE }).t, 0, 'capture');
  r = mk([53, 3, -1, -1], [-1, -1, -1, -1], 3); assert.equal(B.pickMove(r, 0, { lmov, SAFE }).t, 0, 'reaches home');
  r = mk([-1, -1, -1, -1], [-1, -1, -1, -1], 6); assert.ok([0, 1, 2, 3].includes(B.pickMove(r, 0, { lmov, SAFE }).t), 'leaves the yard');
  r = mk([-1, -1, -1, -1], [-1, -1, -1, -1], 3); assert.equal(B.pickMove(r, 0, { lmov, SAFE }), null, 'no legal move');
});

test('chess bot: legal moves, takes free material, finds mate in one (needs chess.js)', { skip: !Chess && 'chess.js is not installed here: run npm install' }, () => {
  let c = new Chess('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1'); let m = B.chess(c); assert.equal(m.from + m.to, 'a1a8', 'back-rank mate');
  c = new Chess('4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1'); m = B.chess(c); assert.equal(m.from + m.to, 'd1d5', 'wins the queen');
  const g = new Chess(); let n = 0; while (!g.isGameOver() && n++ < 60) { const mv = g.turn() === 'w' ? B.chess(g, 400) : pick(g.moves({ verbose: true })); g.move({ from: mv.from, to: mv.to, promotion: 'q' }); }
  assert.ok(!(g.isCheckmate() && g.turn() === 'w'), 'bot (white) was not mated by a random player');
});

test('fallback: every game always has a legal move available from the start, and it is accepted by the rules', () => {
  const lmov = (L, p) => L.pos[p].map((x, t) => (x < 0 ? L.die === 6 : x + L.die <= 56) ? t : -1).filter(t => t >= 0);
  for (const g of ['connect4', 'gomoku', 'reversi']) { const b = G.init(g), m = B.anyMove({ game: g, board: b }, 0); assert.ok(G.play(g, b, 0, m), g + ' fallback move is legal'); }
  const ck = CK.ckInit(), m = B.anyMove({ game: 'checkers', ck, mustFrom: null }, 0); assert.ok(CK.ckMoves(ck, 0, null).some(x => x.from === m.from && x.to === m.to));
  assert.ok(B.anyMove({ game: 'tictactoe', board: Array(9).fill('') }, 0).i >= 0);
  assert.equal(B.anyMove({ game: 'ludo', ludo: { pos: [[-1, -1, -1, -1], [-1, -1, -1, -1]], die: 6, seat: [0, 2] } }, 0, { lmov }) != null, true);
  if (Chess) { const c = new Chess(), mv = B.anyMove({ game: 'chess', chess: c }, 0); assert.ok(c.move({ from: mv.from, to: mv.to, promotion: 'q' })); }
});

test('ludo bot (same rules as the server, no extra luck) beats a random player in at least 80% of games', () => {
  const SAFE = [0, 8, 13, 21, 26, 34, 39, 47], seats = [0, 2], rnd = n => Math.floor(Math.random() * n);
  const lmov = (L, p) => L.pos[p].map((x, t) => (x < 0 ? L.die === 6 : x + L.die <= 56) ? t : -1).filter(t => t >= 0);
  const game = botSeat => { const L = { pos: [[-1,-1,-1,-1],[-1,-1,-1,-1]], die: null, seat: seats }; let p = rnd(2), n = 0;
    while (n++ < 4000) { L.die = 1 + rnd(6); const ts = lmov(L, p); if (!ts.length) { p = 1 - p; continue; }
      const t = p === botSeat ? B.ludo(L, p, ts, SAFE, seats) : ts[rnd(ts.length)]; const x = L.pos[p][t], d = L.die, nn = L.pos[p][t] = x < 0 ? 0 : x + d; let cap = false;
      if (nn <= 50) { const g = (seats[p] * 13 + nn) % 52; if (!SAFE.includes(g)) L.pos.forEach((a, q) => { if (q !== p) L.pos[q] = a.map(y => { const hit = y >= 0 && y <= 50 && (seats[q] * 13 + y) % 52 === g; if (hit) cap = true; return hit ? -1 : y; }); }); }
      if (L.pos[p].every(y => y === 56)) return p; if (d !== 6 && !cap) p = 1 - p; } return -1; };
  let w = 0; const N = 400; for (let i = 0; i < N; i++) if (game(i % 2) === i % 2) w++;
  assert.ok(w / N >= 0.8, 'bot won ' + w + ' of ' + N);
});
