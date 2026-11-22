// GameArena email and SMS verification codes, plus alerts to the site owner.
// Email goes through your mail relay (MAIL_RELAY_URL + MAIL_RELAY_SECRET). If no relay is set, SMTP (SMTP_HOST) is used as a fallback.
// Each function returns false when its channel is not configured, and throws when sending fails.
const E = process.env; let mailer;

async function sendSMS(phone, text) {
  if (!E.AT_API_KEY) return false;
  const host = E.AT_ENV === 'production' ? 'api.africastalking.com' : 'api.sandbox.africastalking.com';
  const body = new URLSearchParams({ username: E.AT_USERNAME || 'sandbox', to: '+' + phone, message: text });
  if (E.AT_SENDER_ID) body.set('from', E.AT_SENDER_ID);
  const r = await fetch('https://' + host + '/version1/messaging', {
    method: 'POST', body, signal: AbortSignal.timeout(20000),
    headers: { apiKey: E.AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  const j = await r.json().catch(() => ({})), rec = j.SMSMessageData?.Recipients?.[0];
  if (!r.ok || !rec || ![100, 101, 102].includes(rec.statusCode)) throw new Error('Could not send the SMS. Please try again.');
  return true;
}

async function viaRelay(to, subject, text) {
  const r = await fetch(E.MAIL_RELAY_URL, {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: E.MAIL_RELAY_SECRET, to, subject, text })
  });
  const raw = await r.text(); let j;
  try { j = JSON.parse(raw); } catch { throw new Error('Invalid response from email relay.'); }
  if (!r.ok || !j.ok) throw new Error('Email delivery failed: ' + (j.error || 'Unknown error'));
  return true;
}

async function viaSmtp(to, subject, text) {
  mailer ||= require('nodemailer').createTransport({
    pool: true, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    host: E.SMTP_HOST, port: +E.SMTP_PORT || 587, secure: E.SMTP_SECURE === '1',
    auth: E.SMTP_USER ? { user: E.SMTP_USER, pass: E.SMTP_PASS } : undefined,
    tls: E.SMTP_TLS_INSECURE === '1' && E.NODE_ENV !== 'production' ? { rejectUnauthorized: false } : undefined   // local testing only
  });
  await mailer.sendMail({ from: E.MAIL_FROM || E.SMTP_USER, to, subject, text });
  return true;
}

async function sendEmail(to, subject, text) {
  try {
    if (E.MAIL_RELAY_URL && E.MAIL_RELAY_SECRET) return await viaRelay(to, subject, text);
    if (E.SMTP_HOST) return await viaSmtp(to, subject, text);
    console.warn('EMAIL NOT SENT: no MAIL_RELAY_URL + MAIL_RELAY_SECRET (or SMTP_HOST) is set');
    return false;
  } catch (e) { console.error('EMAIL FAILED (' + subject + '):', e.message); throw e; }   // shows the real reason in the Render logs
}

exports.emailConfigured = () => !!((E.MAIL_RELAY_URL && E.MAIL_RELAY_SECRET) || E.SMTP_HOST);
exports.send = (channel, dest, code) => {
  const text = `Your GameArena code is ${code}. It expires in 10 minutes. Never share it with anyone.`;
  return channel === 'email' ? sendEmail(dest, 'Your GameArena verification code', text) : sendSMS(dest, text);
};
exports.notify = (to, subject, text) => sendEmail(to, subject, text);   // alerts to the site owner (low wallet, stuck payout...)
