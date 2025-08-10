// mailer.js
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Sends a confirmation email to the customer and an internal copy.
 * This is what your /book flow already uses.
 */
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

  // Customer
  try {
    console.log('📬 [Resend] confirmation → customer:', email);
    const r1 = await resend.emails.send({
      from: 'TopZkušebny <info@topzkusebny.cz>',
      to: email,
      subject,
      html,
      reply_to: 'info@topzkusebny.cz',
    });
    console.log('✅ [Resend] confirmation sent (customer):', r1?.id || r1);
  } catch (err) {
    console.error('❌ [Resend] confirmation failed (customer):', err?.message || err);
  }

  // Internal copy
  try {
    console.log('📬 [Resend] confirmation → internal: info@topzkusebny.cz');
    const r2 = await resend.emails.send({
      from: 'TopZkušebny <info@topzkusebny.cz>',
      to: 'info@topzkusebny.cz',
      subject: `Kopie potvrzení: ${subject}`,
      html,
      reply_to: 'info@topzkusebny.cz',
    });
    console.log('✅ [Resend] confirmation sent (internal):', r2?.id || r2);
  } catch (err) {
    console.error('❌ [Resend] confirmation failed (internal):', err?.message || err);
  }
}

/**
 * NEW: Sends a cancellation email to the customer and an internal copy.
 * We’ll wire this into the admin flow next.
 */
async function sendCancellationEmail(booking, message) {
  const { name, email, date, hours, phone } = booking;

  const subject = `Zrušení rezervace – ${date}`;
  const html = `
    <h2>Zrušení rezervace</h2>
    <p>Omlouváme se, ale vaše rezervace ve zkušebně Banger byla zrušena.</p>
    <ul>
      <li><strong>Datum:</strong> ${date}</li>
      <li><strong>Hodiny:</strong> ${Array.isArray(hours) ? hours.join(', ') : String(hours)}</li>
      <li><strong>Jméno:</strong> ${name}</li>
      <li><strong>Email:</strong> ${email}</li>
      <li><strong>Telefon:</strong> ${phone ?? '-'}</li>
    </ul>
    ${message ? `<p><strong>Doplňující zpráva od provozovatele:</strong><br>${message}</p>` : ''}
    <p>V případě dotazů napište na <a href="mailto:info@topzkusebny.cz">info@topzkusebny.cz</a>.</p>
  `;

  // Customer
  try {
    console.log('📬 [Resend] cancellation → customer:', email);
    const r1 = await resend.emails.send({
      from: 'TopZkušebny <info@topzkusebny.cz>',
      to: email,
      subject,
      html,
      reply_to: 'info@topzkusebny.cz',
    });
    console.log('✅ [Resend] cancellation sent (customer):', r1?.id || r1);
  } catch (err) {
    console.error('❌ [Resend] cancellation failed (customer):', err?.message || err);
  }

  // Internal copy
  try {
    console.log('📬 [Resend] cancellation → internal: info@topzkusebny.cz');
    const r2 = await resend.emails.send({
      from: 'TopZkušebny <info@topzkusebny.cz>',
      to: 'info@topzkusebny.cz',
      subject: `Kopie zrušení: ${subject}`,
      html,
      reply_to: 'info@topzkusebny.cz',
    });
    console.log('✅ [Resend] cancellation sent (internal):', r2?.id || r2);
  } catch (err) {
    console.error('❌ [Resend] cancellation failed (internal):', err?.message || err);
  }
}

/**
 * IMPORTANT (backward‑compatible):
 * Your backend currently does:  const sendConfirmationEmail = require('./mailer');
 * So we must keep the default export as the confirmation function.
 * We also attach the new function as a property.
 */
module.exports = sendConfirmationEmail;
module.exports.sendCancellationEmail = sendCancellationEmail;