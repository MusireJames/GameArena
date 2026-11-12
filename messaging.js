
// StakeArena email and SMS verification
const E = process.env;

async function sendSMS(phone, text) {
  if (!E.AT_API_KEY) return false;

  const host = E.AT_ENV === 'production'
    ? 'api.africastalking.com'
    : 'api.sandbox.africastalking.com';

  const body = new URLSearchParams({
    username: E.AT_USERNAME || 'sandbox',
    to: '+' + phone,
    message: text
  });

  if (E.AT_SENDER_ID) body.set('from', E.AT_SENDER_ID);

  const r = await fetch('https://' + host + '/version1/messaging', {
    method: 'POST',
    body,
    headers: {
      apiKey: E.AT_API_KEY,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  const j = await r.json().catch(() => ({}));
  const rec = j.SMSMessageData?.Recipients?.[0];

  if (!r.ok || !rec || ![100, 101, 102].includes(rec.statusCode)) {
    throw new Error('Could not send the SMS. Please try again.');
  }

  return true;
}

async function sendEmail(to, subject, text) {
  if (!E.MAIL_RELAY_URL || !E.MAIL_RELAY_SECRET) {
    throw new Error('Email relay is not configured.');
  }

  const response = await fetch(E.MAIL_RELAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: E.MAIL_RELAY_SECRET,
      to,
      subject,
      text
    })
  });

  const responseText = await response.text();

  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error('Invalid response from email relay.');
  }

  if (!response.ok || !result.ok) {
    throw new Error('Email delivery failed: ' + (result.error || 'Unknown error'));
  }

  return true;
}

exports.send = (channel, dest, code) => {
  const text = `Your StakeArena code is ${code}. It expires in 10 minutes. Never share it with anyone.`;

  return channel === 'email'
    ? sendEmail(dest, 'Your StakeArena verification code', text)
    : sendSMS(dest, text);
};
