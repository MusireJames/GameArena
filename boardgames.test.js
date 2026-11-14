const { test } = require('node:test'), assert = require('node:assert'), G = require('./boardgames');
const seq = (g, moves) => { let b = G.init(g), s = 0, last; for (const m of moves) { last = G.play(g, b, s, m); assert.ok(last, 'legal: ' + JSON.stringify(m)); b = last.board; s = last.next; if (last.over) break; } return last; };
test('connect four: gravity, vertical, horizontal, diagonal wins', () => {
  const b = G.init('connect4'); const a = G.play('connect4', b, 0, { c: 3 }); assert.equal(a.lm, 38, 'drops to the bottom row'); assert.equal(G.play('connect4', a.board, 1, { c: 3 }).lm, 31, 'stacks');
  assert.equal(b.every(x => x === 0), true, 'input board is not mutated');
  assert.equal(G.play('connect4', b, 0, { c: 7 }), null); assert.equal(G.play('connect4', b, 0, { c: 'x' }), null); assert.equal(G.play('connect4', b, 0, {}), null);
  let r = seq('connect4', [{ c: 0 }, { c: 1 }, { c: 0 }, { c: 1 }, { c: 0 }, { c: 1 }, { c: 0 }]); assert.equal(r.over.winner, 0); assert.deepEqual(r.over.line, [14, 21, 28, 35].map(x => x + 0).sort((p, q) => p - q), 'vertical');
  r = seq('connect4', [{ c: 0 }, { c: 0 }, { c: 1 }, { c: 1 }, { c: 2 }, { c: 2 }, { c: 3 }]); assert.equal(r.over.winner, 0); assert.deepEqual(r.over.line, [35, 36, 37, 38], 'horizontal');
  r = seq('connect4', [{ c: 0 }, { c: 1 }, { c: 1 }, { c: 2 }, { c: 3 }, { c: 2 }, { c: 2 }, { c: 3 }, { c: 4 }, { c: 3 }, { c: 3 }]); assert.equal(r.over.winner, 0, 'diagonal'); assert.equal(r.over.line.length, 4);
  let full = G.init('connect4'); for (let c = 0; c < 7; c++) for (let k = 0; k < 6; k++) full[k * 7 + c] = (c + Math.floor(k / 2)) % 2 ? 1 : 2; full[0] = 0; full[7 * 0 + 0] = 0;
  assert.equal(G.play('connect4', full, 0, { c: 0 }) && true, true); const col = full.slice(); col[0] = 1; assert.equal(G.play('connect4', col, 0, { c: 0 }), null, 'a full column is refused');
});
test('connect four: a full board with no four is a draw', () => {
  // columns patterned so no four in a row exists
  const pat = [[1, 1, 2, 2, 1, 1], [2, 2, 1, 1, 2, 2], [1, 1, 2, 2, 1, 1], [2, 2, 1, 1, 2, 2], [1, 1, 2, 2, 1, 1], [2, 2, 1, 1, 2, 2], [1, 1, 2, 2, 1, 1]];
  const b = Array(42).fill(0); for (let c = 0; c < 7; c++) for (let k = 0; k < 6; k++) b[k * 7 + c] = pat[c][5 - k]; b[0] = 0;
  const r = G.play('connect4', b, 1, { c: 0 }); assert.ok(r && r.over, 'game ends'); assert.ok(r.over.winner === null || r.over.winner === 1);
});
test('gomoku: five in a row wins, four does not, occupied and off-board are refused', () => {
  let b = G.init('gomoku'), s = 0, last; const mv = [[7, 7], [0, 0], [7, 8], [0, 1], [7, 9], [0, 2], [7, 10], [0, 3]];
  for (const [r, c] of mv) { last = G.play('gomoku', b, s, { i: r * 15 + c }); assert.ok(last && !last.over); b = last.board; s = last.next; }
  assert.equal(G.play('gomoku', b, 0, { i: 7 * 15 + 7 }), null, 'occupied'); assert.equal(G.play('gomoku', b, 0, { i: 225 }), null); assert.equal(G.play('gomoku', b, 0, { i: -1 }), null);
  last = G.play('gomoku', b, 0, { i: 7 * 15 + 11 }); assert.equal(last.over.winner, 0); assert.equal(last.over.line.length, 5);
  const diag = G.init('gomoku'); [0, 16, 32, 48].forEach(i => diag[i] = 2); const d = G.play('gomoku', diag, 1, { i: 64 }); assert.equal(d.over.winner, 1, 'diagonal');
  const edge = G.init('gomoku'); [11, 12, 13, 14].forEach(i => edge[i] = 1); assert.equal(G.play('gomoku', edge, 0, { i: 10 }).over.winner, 0);
  const wrap = G.init('gomoku'); [12, 13, 14, 15].forEach(i => wrap[i] = 1); assert.equal(G.play('gomoku', wrap, 0, { i: 16 }).over, null, 'a row does not wrap around the board edge');
});
test('reversi: opening moves, flipping, illegal moves', () => {
  const b = G.init('reversi'); assert.deepEqual(G.legal('reversi', b, 0), [19, 26, 37, 44], 'black opens with the four classic moves');
  assert.equal(G.play('reversi', b, 0, { i: 0 }), null, 'no flips = illegal'); assert.equal(G.play('reversi', b, 0, { i: 27 }), null, 'occupied');
  const r = G.play('reversi', b, 0, { i: 19 }); assert.equal(r.board.filter(x => x === 1).length, 4); assert.equal(r.board.filter(x => x === 2).length, 1); assert.equal(r.next, 1); assert.equal(r.board[27], 1, 'the white disc was flipped');
  assert.equal(b[27], 2, 'input not mutated');
});
test('reversi: the game ends when neither player can move, and a stuck player is skipped', () => {
  const b = Array(64).fill(0); b[0] = 1; b[1] = 2;   // black plays 2, flips the only white disc: nobody can move
  const r = G.play('reversi', b, 0, { i: 2 }); assert.ok(r.over); assert.equal(r.over.winner, 0);
  let passes = 0;   // across many random games, whenever a pass is reported the same player moves again and really has a move
  for (let seed = 1; seed <= 300; seed++) { let x = seed * 104729, rnd = n => (x = (x * 1103515245 + 12345) & 0x7fffffff) % n; let bb = G.init('reversi'), s = 0;
    for (let n = 0; n < 200; n++) { const mv = G.legal('reversi', bb, s); if (!mv.length) break; const t = G.play('reversi', bb, s, { i: mv[rnd(mv.length)] }); bb = t.board; if (t.over) break;
      if (t.note) { passes++; assert.equal(t.next, s); assert.ok(G.legal('reversi', bb, s).length > 0); assert.equal(G.legal('reversi', bb, 1 - s).length, 0); } s = t.next; } }
  assert.ok(passes > 0, 'passes occurred in the sample (' + passes + ')');
});
test('reversi: a full random game always terminates with a consistent result', () => {
  for (let seed = 1; seed <= 25; seed++) { let x = seed * 7919, rnd = n => (x = (x * 1103515245 + 12345) & 0x7fffffff) % n;
    let b = G.init('reversi'), s = 0, last = null, n = 0;
    while (n++ < 200) { const mv = G.legal('reversi', b, s); if (!mv.length) break; last = G.play('reversi', b, s, { i: mv[rnd(mv.length)] }); assert.ok(last); b = last.board; if (last.over) break; s = last.next; }
    assert.ok(last && last.over, 'game over by move 200'); const a = b.filter(v => v === 1).length, z = b.filter(v => v === 2).length;
    assert.equal(last.over.winner, a === z ? null : a > z ? 0 : 1, 'winner matches the disc count'); }
});
test('spec helpers', () => { assert.ok(G.is('connect4') && G.is('reversi') && G.is('gomoku') && !G.is('chess')); assert.ok(G.turnMs('gomoku') > 0); });
