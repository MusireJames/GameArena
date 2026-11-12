const crypto = require('crypto'), fs = require('fs'), E = process.env, CBS = E.CALLBACK_SECRET || 'dev-callback-secret';
const base = () => E.DARAJA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
async function token() {
  const r = await fetch(base() + '/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: 'Basic ' + Buffer.from(E.DARAJA_CONSUMER_KEY + ':' + E.DARAJA_CONSUMER_SECRET).toString('base64') } });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error('Daraja auth failed: check DARAJA_CONSUMER_KEY / SECRET in .env');
  return j.access_token;
}
async function call(path, body) {
  const r = await fetch(base() + path, { method: 'POST',
    headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.errorMessage || (j.ResponseCode && j.ResponseCode !== '0')) throw new Error(j.errorMessage || j.ResponseDescription || 'Daraja error');
  return j;
}
exports.stk = (phone, amount) => {
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return call('/mpesa/stkpush/v1/processrequest', {
    BusinessShortCode: E.DARAJA_SHORTCODE,
    Password: Buffer.from(E.DARAJA_SHORTCODE + E.DARAJA_PASSKEY + ts).toString('base64'),
    Timestamp: ts, TransactionType: 'CustomerPayBillOnline', Amount: amount,
    PartyA: phone, PartyB: E.DARAJA_SHORTCODE, PhoneNumber: phone,
    CallBackURL: E.BASE_URL + '/api/daraja/stk-callback/' + CBS,   // <-- registered automatically from BASE_URL
    AccountReference: 'StakeArena', TransactionDesc: 'Wallet deposit' });
};
exports.b2c = (phone, amount, id) => {
  const cred = crypto.publicEncrypt({ key: fs.readFileSync(E.DARAJA_CERT_PATH), padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(E.DARAJA_INITIATOR_PASSWORD)).toString('base64');
  return call('/mpesa/b2c/v1/paymentrequest', {
    InitiatorName: E.DARAJA_INITIATOR_NAME, SecurityCredential: cred, CommandID: 'BusinessPayment',
    Amount: amount, PartyA: E.DARAJA_SHORTCODE, PartyB: phone, Remarks: 'Withdrawal ' + id, Occasion: 'Withdrawal',
    QueueTimeOutURL: E.BASE_URL + '/api/daraja/b2c-timeout/' + CBS,
    ResultURL: E.BASE_URL + '/api/daraja/b2c-result/' + CBS });
};
