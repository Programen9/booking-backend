// sms.js
const twilio = require('twilio');

function getClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!sid || !token) {
    throw new Error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
  }
  return twilio(sid, token);
}

async function sendSms({ to, body }) {
  const client = getClient();

  const from = process.env.TWILIO_FROM;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  if (!to || !String(to).startsWith('+')) {
    throw new Error(`Invalid "to" (must be E.164): ${to}`);
  }

  if (!messagingServiceSid && !from) {
    throw new Error('Set TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM');
  }

  const payload = {
    to,
    body,
    ...(messagingServiceSid ? { messagingServiceSid } : { from }),
  };

  const msg = await client.messages.create(payload);
  return { sid: msg.sid, status: msg.status };
}

module.exports = { sendSms };