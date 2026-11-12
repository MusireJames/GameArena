// Sends one-time codes by SMS (Africa's Talking) or email (any SMTP server). Returns false when a channel is not configured.
const E = process.env; let mailer;
async function sendSMS(phone, text) {
  if (!E.AT_API_KEY) return false;
  const host = E.AT_ENV === 'production' ? 'api.africastalking.com' : 'api.sandbox.africastalking.com';
  const body = new URLSearchParams({ username: E.AT_USERNAME || 'sandbox', to: '+' + phone, message: text });
  if (E.AT_SENDER_ID) body.set('from', E.AT_SENDER_ID);
  const r = await fetch('https://' + host + '/version1/messaging', { method: 'POST', body,
    headers: { apiKey: E.AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' } });
  const j = await r.json().catch(() => ({})), rec = j.SMSMessageData?.Recipients?.[0];
  if (!r.ok || !rec || ![100, 101, 102].includes(rec.statusCode)) throw new Error('Could not send the SMS. Please try again.');
  return true;
}
async function sendEmail(to, subject, text) {
  if (!E.SMTP_HOST) return false;
  mailer ||= require('nodemailer').createTransport({ pool: true, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000, host: E.SMTP_HOST, port: +E.SMTP_PORT || 587, secure: E.SMTP_SECURE === '1',
    auth: E.SMTP_USER ? { user: E.SMTP_USER, pass: E.SMTP_PASS } : undefined,
    // LOCAL TESTING ONLY: lets an antivirus that scans encrypted mail work. Ignored when NODE_ENV=production.
    tls: E.SMTP_TLS_INSECURE === '1' && E.NODE_ENV !== 'production' ? { rejectUnauthorized: false } : undefined });
  await mailer.sendMail({ from: E.MAIL_FROM || E.SMTP_USER, to, subject, text });
  return true;
}
exports.send = (channel, dest, code) => {
  const text = `Your StakeArena code is ${code}. It expires in 10 minutes. Never share it with anyone.`;
  return channel === 'email' ? sendEmail(dest, 'Your StakeArena verification code', text) : sendSMS(dest, text);
};
