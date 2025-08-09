// mailer.js
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendConfirmationEmail(booking) {
  const { name, email, date, hours, phone } = booking;

  const subject = `Potvrzení rezervace – ${date}`;
  const html = `
    <h2>Potvrzení rezervace</h2>
    <p>Děkujeme za rezervaci ve zkušebně Banger!</p>
    <ul>
      <li><strong>Datum:</strong> ${date}</li>
      <li><strong>Hodiny:</strong> ${Array.isArray(hours) ? hours.join(', ') : String(hours)}</li>
      <li><strong>Jméno:</strong> ${name}</li>
      <li><strong>Email:</strong> ${email}</li>
      <li><strong>Telefon:</strong> ${phone ?? '-'}</li>
    </ul>
  `;

  // 1) Customer
  try {
    console.log('📬 [Resend] sending to customer:', email);
    const r1 = await resend.emails.send({
      from: 'TopZkušebny <onboarding@resend.dev>',
      to: email,
      subject,
      html,
      reply_to: 'info@topzkusebny.cz',
    });
    console.log('✅ [Resend] customer sent:', r1);
  } catch (err) {
    console.error('❌ [Resend] customer send failed:', err?.message || err);
  }

  // 2) Internal copy
  try {
    console.log('📬 [Resend] sending to internal: info@topzkusebny.cz');
    const r2 = await resend.emails.send({
      from: 'TopZkušebny <onboarding@resend.dev>',
      to: 'info@topzkusebny.cz',
      subject: `Kopie potvrzení: ${subject}`,
      html,
      reply_to: 'info@topzkusebny.cz',
    });
    console.log('✅ [Resend] internal sent:', r2);
  } catch (err) {
    console.error('❌ [Resend] internal send failed:', err?.message || err);
  }
}

module.exports = sendConfirmationEmail;