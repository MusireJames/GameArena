// Pure rules for the extra two-player board games. No I/O, so every rule is unit tested (boardgames.test.js).
// Boards are flat arrays: 0 = empty, 1 = first player's piece, 2 = second player's piece. `side` is 0 or 1 (index in room.players).
const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const SPEC = { connect4: { w: 7, h: 6, turn: 30000 }, gomoku: { w: 15, h: 15, turn: 45000 }, reversi: { w: 8, h: 8, turn: 45000 } };
const names = Object.keys(SPEC), is = g => names.includes(g), turnMs = g => SPEC[g].turn;

function init(g) {
  const b = Array(SPEC[g].w * SPEC[g].h).fill(0);
  if (g === 'reversi') { b[27] = 2; b[28] = 1; b[35] = 1; b[36] = 2; }
  return b;
}
function run(b, w, h, i, p, need) {   // the line of `need`+ pieces through cell i for player p, or null
  const r0 = Math.floor(i / w), c0 = i % w;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const line = [i];
    for (const s of [1, -1]) for (let k = 1; ; k++) { const r = r0 + dr * k * s, c = c0 + dc * k * s; if (r < 0 || r >= h || c < 0 || c >= w || b[r * w + c] !== p) break; s > 0 ? line.push(r * w + c) : line.unshift(r * w + c); }
    if (line.length >= need) return line;
  }
  return null;
}
function flips(b, i, p) {   // reversi: the cells a piece placed at i would turn over
  if (b[i]) return []; const out = [], r0 = i >> 3, c0 = i & 7;
  for (const [dr, dc] of DIRS) { const seen = []; let r = r0 + dr, c = c0 + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8 && b[r * 8 + c] === 3 - p) { seen.push(r * 8 + c); r += dr; c += dc; }
    if (seen.length && r >= 0 && r < 8 && c >= 0 && c < 8 && b[r * 8 + c] === p) out.push(...seen); }
  return out;
}
const reversiMoves = (b, side) => { const p = side + 1, m = []; for (let i = 0; i < 64; i++) if (flips(b, i, p).length) m.push(i); return m; };
const legal = (g, b, side) => g === 'reversi' ? reversiMoves(b, side) : [];

/** Try a move. Returns null if illegal, else { board, next, lm, over: null | { winner: 0|1|null, line?, text }, note? } */
function play(g, board, side, m) {
  const b = board.slice(), p = side + 1, { w, h } = SPEC[g];
  if (g === 'connect4') {
    const c = m && m.c; if (!Number.isInteger(c) || c < 0 || c >= w) return null;
    let r = h - 1; while (r >= 0 && b[r * w + c]) r--; if (r < 0) return null;
    const i = r * w + c; b[i] = p; const line = run(b, w, h, i, p, 4);
    if (line) return { board: b, next: side, lm: i, over: { winner: side, line: line.slice(0, 4), text: 'four in a row' } };
    if (b.every(x => x)) return { board: b, next: side, lm: i, over: { winner: null, text: 'Draw. Stakes refunded' } };
    return { board: b, next: 1 - side, lm: i, over: null };
  }
  if (g === 'gomoku') {
    const i = m && m.i; if (!Number.isInteger(i) || i < 0 || i >= w * h || b[i]) return null;
    b[i] = p; const line = run(b, w, h, i, p, 5);
    if (line) return { board: b, next: side, lm: i, over: { winner: side, line, text: 'five in a row' } };
    if (b.every(x => x)) return { board: b, next: side, lm: i, over: { winner: null, text: 'Draw. Stakes refunded' } };
    return { board: b, next: 1 - side, lm: i, over: null };
  }
  if (g === 'reversi') {
    const i = m && m.i; if (!Number.isInteger(i) || i < 0 || i >= 64) return null;
    const f = flips(b, i, p); if (!f.length) return null; b[i] = p; f.forEach(k => b[k] = p);
    let next = 1 - side, note = null;
    if (!reversiMoves(b, next).length) { if (reversiMoves(b, side).length) { next = side; note = 'passes (no legal move)'; } else {
      const a = b.filter(x => x === 1).length, z = b.filter(x => x === 2).length;
      return { board: b, next: side, lm: i, over: a === z ? { winner: null, text: `Draw ${a}-${z}. Stakes refunded` } : { winner: a > z ? 0 : 1, text: `${Math.max(a, z)}-${Math.min(a, z)}` } }; } }
    return { board: b, next, lm: i, over: null, note };
  }
  return null;
}
module.exports = { is, names, init, play, legal, turnMs, SPEC };
