// PalPluss charges per transaction (their Pricing page). Players pay these on top, so GameArena keeps its full game fee.
// If PalPluss changes its prices, edit the two tables below. Each row is [from KES, to KES, fee KES].
const STK = [[1, 9, 0], [10, 1e9, 3]];                                   // deposits (M-Pesa prompt)
const B2C = [[1, 49, 6], [50, 499, 12], [500, 999, 18], [1000, 1499, 23], [1500, 2499, 30], [2500, 3499, 33], [3500, 4999, 40], [5000, 7499, 50], [7500, 9999, 55]];   // payouts
const MAX_PAYOUT = B2C[B2C.length - 1][1];                              // the highest payout in the table above (raise it when you add more rows)
const find = (t, a) => { const r = t.find(([lo, hi]) => a >= lo && a <= hi); return r ? r[2] : null; };
/** Fee for a deposit that adds `amount` to the wallet. The player pays amount + fee at M-Pesa. */
const depositFee = amount => { const a = Math.floor(amount); return a + 3 >= 10 ? find(STK, a + 3) : find(STK, a); };
/** Fee for a payout that puts `amount` on the player's phone. The wallet is debited amount + fee. null = outside the price table. */
const b2cFee = amount => find(B2C, Math.floor(amount));
module.exports = { STK, B2C, MAX_PAYOUT, depositFee, b2cFee };
