'use strict';
// Checkers rules (American: forced captures, multi-jumps, kings). Shared by the server and the bot. Board = 64 cells; w/W = player 1, b/B = player 2.
const ckSide = p => p.toLowerCase() === 'w' ? 0 : 1;
const ckDirs = p => p === 'w' ? [[-1, -1], [-1, 1]] : p === 'b' ? [[1, -1], [1, 1]] : [[-1, -1], [-1, 1], [1, -1], [1, 1]];
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
const ckInit = () => Array.from({ length: 64 }, (_, i) => ((i >> 3) + (i & 7)) & 1 ? ((i >> 3) < 3 ? 'b' : (i >> 3) > 4 ? 'w' : 0) : 0);
/** Plays one (legal) step on a COPY of the board. Returns { b, mustFrom, side (who moves next), winner: null | side } */
function ckApply(board, side, mv, mustFrom) {
  const b = board.slice(), p = b[mv.from]; b[mv.to] = p; b[mv.from] = 0; let king = false;
  if ((p === 'w' && (mv.to >> 3) === 0) || (p === 'b' && (mv.to >> 3) === 7)) { b[mv.to] = p.toUpperCase(); king = true; }
  let must = null;
  if (mv.cap != null) { b[mv.cap] = 0; if (!king && ckMoves(b, side, mv.to).length) must = mv.to; }
  if (must != null) return { b, mustFrom: must, side, winner: null };
  const o = 1 - side;
  const lost = !b.some(x => x && ckSide(x) === o) || !ckMoves(b, o).length;
  return { b, mustFrom: null, side: o, winner: lost ? side : null };
}
module.exports = { ckSide, ckDirs, ckMoves, ckInit, ckApply };
