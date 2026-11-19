'use strict';
// Stockfish (the strongest open-source chess engine) as the chess bot's brain. It runs in its own child process, so thinking never freezes the website,
// and requests are answered one at a time. If the engine is missing or fails, best() resolves null and the caller falls back to the built-in bot (bots.js).
// Settings: STOCKFISH_MS (thinking time per move, default 800), STOCKFISH_SKILL (0-20, default 15; 20 = full strength), STOCKFISH_PATH (override engine file).
const { spawn } = require('child_process');
const MS = () => +process.env.STOCKFISH_MS || 800, SKILL = () => process.env.STOCKFISH_SKILL === undefined ? 15 : Math.max(0, Math.min(20, +process.env.STOCKFISH_SKILL || 0));
let child = null, buf = '', cur = null, missing = false; const queue = [];
function enginePath() { if (process.env.STOCKFISH_PATH) return process.env.STOCKFISH_PATH; try { return require('stockfish').findEngine('lite-single'); } catch { return null; } }
const available = () => !missing && !!enginePath();
function send(line) { try { child.stdin.write(line + '\n'); } catch {} }
function spawnEngine() {
  const p = enginePath(); if (!p) { missing = true; return false; }
  child = spawn(process.execPath, [p], { stdio: ['pipe', 'pipe', 'ignore'] }); buf = '';
  child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); onLine(line); } });
  const dead = () => { if (!child) return; child = null; if (cur) { clearTimeout(cur.t); const c = cur; cur = null; c.done(null); } pump(); };
  child.on('exit', dead); child.on('error', () => { missing = true; dead(); });
  send('uci'); send('setoption name Hash value 16'); send('setoption name Skill Level value ' + SKILL()); send('isready');
  return true;
}
function onLine(line) {
  const m = /^bestmove (\S+)/.exec(line);
  if (m && cur) { clearTimeout(cur.t); const c = cur; cur = null; c.done(/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m[1]) ? m[1] : null); pump(); }
}
function pump() {
  if (cur || !queue.length) return;
  if (!child && !spawnEngine()) { while (queue.length) queue.shift().done(null); return; }
  cur = queue.shift(); const ms = cur.ms;
  cur.t = setTimeout(() => { const c = cur; cur = null; try { child.kill(); } catch {} child = null; c.done(null); pump(); }, ms + 4000);   // a stuck engine is killed and restarted
  send('position fen ' + cur.fen); send('go movetime ' + ms);
}
/** Best move for the position, as a UCI string like "e2e4" or "e7e8q", or null if the engine is not available. */
function best(fen, ms = MS()) { return new Promise(res => { queue.push({ fen, ms, done: res }); pump(); }); }
function stop() { try { child && child.kill(); } catch {} child = null; }
module.exports = { best, available, stop };
