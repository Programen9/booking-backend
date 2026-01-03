// sms.js
async function sendSmsDemo({ to, body }) {
  const DEMO_URL = process.env.TWILIO_DEMO_WEBHOOK_URL || 'https://demo.twilio.com/welcome/sms/reply/';

  // Twilio obvykle posílá form-urlencoded, tak uděláme totéž
  const form = new URLSearchParams({
    To: to,
    From: 'TopZkusebnyDemo',
    Body: body,
  });

  const r = await fetch(DEMO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

  const text = await r.text().catch(() => '');
  if (!r.ok) {
    throw new Error(`Twilio demo webhook returned ${r.status}: ${text}`);
  }

  // V demo režimu nemáme SID, tak vracíme fake
  return { sid: 'demo', raw: text };
}

module.exports = { sendSmsDemo };