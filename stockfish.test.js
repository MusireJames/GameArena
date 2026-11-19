const { test } = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path'), os = require('os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-')), fake = path.join(dir, 'fake.js');
// a fake engine that speaks just enough UCI: answers every "go" with e2e4 (or never answers if the position says so)
fs.writeFileSync(fake, `require('readline').createInterface({input:process.stdin}).on('line',l=>{ if(l.startsWith('position fen 8/8')) return; if(l.startsWith('go')) console.log('bestmove e2e4 ponder e7e5'); });`);
process.env.STOCKFISH_PATH = fake; process.env.STOCKFISH_MS = '50';
const SF = require('./stockfish');
test('stockfish wrapper: sends UCI, returns the best move, answers queued requests in order', async () => {
  assert.ok(SF.available());
  const r = await Promise.all([SF.best('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 50), SF.best('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1', 50)]);
  assert.deepEqual(r, ['e2e4', 'e2e4']);
});
test('stockfish wrapper: a missing engine returns null instead of throwing', async () => {
  SF.stop(); process.env.STOCKFISH_PATH = path.join(dir, 'nope.js');
  assert.equal(await SF.best('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 50), null);
  SF.stop();
});
