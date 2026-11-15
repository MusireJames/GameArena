const { test } = require('node:test'), assert = require('node:assert'), F = require('./fees');
test('deposit fee: KES 3 for every charge of KES 10 or more', () => { for (const a of [10, 11, 50, 500, 150000]) assert.equal(F.depositFee(a), 3, 'deposit ' + a); assert.equal(F.depositFee(5), 0 + (5 + 3 >= 10 ? 3 : 0)); });
test('payout fee follows every band of the price list, including the edges', () => {
  const want = { 1: 6, 49: 6, 50: 12, 499: 12, 500: 18, 999: 18, 1000: 23, 1499: 23, 1500: 30, 2499: 30, 2500: 33, 3499: 33, 3500: 40, 4999: 40, 5000: 50, 7499: 50, 7500: 55, 9999: 55 };
  for (const [a, f] of Object.entries(want)) assert.equal(F.b2cFee(+a), f, 'payout ' + a);
});
test('amounts outside the price list have no fee, so the server must refuse them', () => { assert.equal(F.b2cFee(10000), null); assert.equal(F.b2cFee(0), null); assert.equal(F.MAX_PAYOUT, 9999); });
