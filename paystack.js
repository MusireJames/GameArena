// Paystack: M-Pesa deposits through the Charge API, M-Pesa payouts through Transfers.
const E = process.env;
async function call(method, path, body) {
  if (!E.PAYSTACK_SECRET_KEY) throw new Error('Payments are not set up yet');
  const r = await fetch((E.PAYSTACK_BASE || 'https://api.paystack.co') + path, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: 'Bearer ' + E.PAYSTACK_SECRET_KEY, 'Content-Type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status === false) throw new Error(j.message || 'Payment provider error');
  return j.data;
}
const intl = p => E.PAYSTACK_PHONE_FORMAT === 'local' ? '0' + p.slice(3) : '+' + p;   // p looks like 2547XXXXXXXX
exports.chargeMpesa = (email, phone, kes, reference) => call('POST', '/charge', { email, amount: kes * 100, currency: 'KES', reference, mobile_money: { phone: intl(phone), provider: 'mpesa' } });
exports.verify = ref => call('GET', '/transaction/verify/' + encodeURIComponent(ref));
exports.recipient = (name, phone) => call('POST', '/transferrecipient', { type: 'mobile_money', name, account_number: '0' + phone.slice(3), bank_code: 'MPESA', currency: 'KES' });
exports.transfer = (recipient, kes, reference) => call('POST', '/transfer', { source: 'balance', amount: kes * 100, recipient, reference, reason: 'StakeArena withdrawal' });
