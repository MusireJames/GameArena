// PalPluss M-Pesa client. API docs: https://docs.palpluss.com
//   deposits   = STK Push   POST /payments/stk     (money lands in your default channel, i.e. your till)
//   withdrawals = B2C payout POST /b2c/payouts      (paid from your PalPluss B2C wallet)
// Every failure is turned into a PalPlussError whose `kind` tells the caller what is safe to do next:
//   fatal   the request was rejected and nothing happened: refund the player
//   hold    rejected because of OUR account (wallet empty, KYC...): nothing happened, retry later and alert the admin
//   wait    rate limited: nothing happened, retry after `retryAfter` seconds
//   notsent we never reached PalPluss (DNS, connection refused): nothing happened, retry
//   unsure  timeout / 5xx / connection dropped: the request MAY have been processed, so look it up before retrying
const E = process.env;
const base = () => (E.PALPLUSS_BASE || 'https://api.palpluss.com/v1').replace(/\/+$/, '');
const TIMEOUT = () => +E.PALPLUSS_TIMEOUT_MS || 15000;

class PalPlussError extends Error {
  constructor(message, o = {}) { super(message); this.name = 'PalPlussError'; Object.assign(this, { kind: 'unsure', code: '', status: 0, retryAfter: 0, requestId: '', alert: false, userMessage: '' }, o); }
}

const authHeader = () => 'Basic ' + Buffer.from((E.PALPLUSS_API_KEY || '') + ':').toString('base64');   // key as username, empty password

const USER_MSG = {
  INVALID_PHONE: 'Your M-Pesa number was not accepted. Please contact support.',
  STK_RATE_LIMITED: 'Please wait a minute before asking for another M-Pesa prompt.',
  STK_TEMP_BANNED: 'M-Pesa deposits are paused for a while. Please try again later.',
  TRANSACTION_HEALTH_BLOCKED: 'M-Pesa deposits are paused for a while. Please try again later.',
  B2C_PAYOUT_COOLDOWN: 'Please wait a minute between withdrawals.',
};
const CONFIG_CODES = new Set(['INVALID_API_KEY', 'TENANT_INACTIVE', 'KYC_NOT_VERIFIED', 'ACCOUNT_INACTIVE', 'NO_PAYMENT_CHANNELS', 'NO_DEFAULT_CHANNEL', 'CHANNEL_NOT_FOUND', 'CREDENTIAL_NOT_FOUND', 'CREDENTIAL_INACTIVE', 'UNSUPPORTED_CURRENCY']);

function classify(status, code, retryAfter) {
  if (status === 429) return 'wait';
  if (status === 402 || status === 409) return 'hold';   // service wallet / B2C wallet problems on our side
  if (status >= 500) return 'unsure';
  return 'fatal';                                         // 400 401 403 404 422 ...
}

async function request(method, path, { body, headers, timeout } = {}) {
  if (!E.PALPLUSS_API_KEY) throw new PalPlussError('PALPLUSS_API_KEY is not set', { kind: 'hold', code: 'NO_API_KEY', alert: true });
  let res;
  try {
    res = await fetch(base() + path, { method, signal: AbortSignal.timeout(timeout || TIMEOUT()),
      headers: { Authorization: authHeader(), Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }), ...headers }, body: body && JSON.stringify(body) });
  } catch (e) {
    const c = e.cause?.code || e.code || '';
    const never = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_INVALID_URL'].includes(c);   // the request never left this machine
    throw new PalPlussError('PalPluss could not be reached (' + (c || e.name) + ')', { kind: never ? 'notsent' : 'unsure', code: c || e.name });
  }
  const text = await res.text().catch(() => ''); let j = {}; try { j = text ? JSON.parse(text) : {}; } catch {}
  if (res.ok && j.success !== false) return j;
  const err = j.error || {}, code = err.code || 'HTTP_' + res.status, status = res.status;
  const retryAfter = Math.ceil(+(err.details?.retryAfterSeconds) || +res.headers.get('retry-after') || (status === 429 ? 60 : 0));
  const kind = classify(status, code, retryAfter);
  throw new PalPlussError(err.message || 'PalPluss error ' + status, { kind, code, status, retryAfter, requestId: j.requestId || '',
    alert: CONFIG_CODES.has(code) || status === 401 || status === 402 || status === 403 || status === 409,
    userMessage: USER_MSG[code] || (retryAfter && kind === 'wait' ? `Please wait ${retryAfter} seconds and try again.` : 'Payments are temporarily unavailable. Please try again shortly.') });
}

// PalPluss answers are inconsistent between camelCase and snake_case in its own docs, so accept both.
function norm(raw) {
  const x = raw && raw.data !== undefined && raw.success !== undefined ? raw.data : (raw?.transaction || raw?.data || raw) || {};
  return { id: x.transactionId || x.transaction_id || x.id || null, type: x.type || null, status: String(x.status || '').toUpperCase(), amount: x.amount == null ? NaN : Number(x.amount),
    phone: x.phone || x.phone_number || null, ref: x.accountReference || x.reference || x.external_reference || x.externalReference || null,
    receipt: x.mpesa_receipt || x.mpesaReceipt || null, desc: x.resultDescription || x.resultDesc || x.result_desc || '', createdAt: Date.parse(x.createdAt || x.created_at) || 0 };
}

exports.PalPlussError = PalPlussError;
exports.norm = norm;
exports.configured = () => !!E.PALPLUSS_API_KEY;

/** Deposit: sends an M-Pesa PIN prompt to the player's phone. accountReference max 12 chars, transactionDesc max 13. */
exports.stkPush = async ({ amount, phone, accountReference, transactionDesc, callbackUrl, channelId }) =>
  norm(await request('POST', '/payments/stk', { body: { amount, phone, accountReference, transactionDesc, callbackUrl, ...((channelId || E.PALPLUSS_CHANNEL_ID) && { channelId: channelId || E.PALPLUSS_CHANNEL_ID }) } }));

/** Withdrawal: pays the player's M-Pesa number. The Idempotency-Key makes a repeated request safe. */
exports.b2c = async ({ amount, phone, reference, description, callbackUrl, idempotencyKey }) =>
  norm(await request('POST', '/b2c/payouts', { headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}, body: { amount, currency: 'KES', phone, reference, description, callbackUrl } }));

/** The authoritative status of one transaction. Webhooks are only a nudge: money is only moved after this call confirms it. */
exports.getTransaction = async id => norm(await request('GET', '/transactions/' + encodeURIComponent(id)));

/** Finds a transaction by the reference we sent (used when a request timed out and we do not know if it went through). Returns null if it is not there. */
exports.findByReference = async (type, ref, sinceMs = 0) => {
  let cursor = '';
  for (let page = 0; page < 3; page++) {
    const j = await request('GET', `/transactions?limit=100&type=${type}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`), items = j.data?.items || [];
    for (const it of items) { const n = norm(it); if (n.ref === ref) return n; }
    const last = items.length ? norm(items[items.length - 1]) : null;
    cursor = j.data?.nextCursor; if (!cursor || !last || (sinceMs && last.createdAt && last.createdAt < sinceMs - 600000)) break;   // went back past the time we sent it
  }
  return null;
};

/** Service wallet (pays PalPluss fees). When it hits zero every deposit and withdrawal is refused with 402. */
exports.serviceBalance = async () => { const j = await request('GET', '/wallets/service/balance'); return Number(j.data?.availableBalance); };
