// mailer.js
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// Helper: normalize any input (string/Date) to YYYY-MM-DD
function formatYMD(d) {
  try {
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return String(d ?? '');
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  } catch {
    return String(d ?? '');
  }
}

/**
 * Sends a confirmation email to the customer and an internal copy.
 */
async function sendConfirmationEmail(booking) {
  const { name, email, date, hours, phone } = booking;
  const dateLabel = formatYMD(date);

  const subject = `Potvrzení rezervace – ${dateLabel}`;
  const html = `
    <h2>Potvrzení rezervace</h2>
    <p>Děkujeme za rezervaci ve zkušebně Banger!</p>
    <ul>
      <li><strong>Datum:</strong> ${dateLabel}</li>
      <li><strong>Hodiny:</strong> ${Array.isArray(hours) ? hours.join(', ') : String(hours)}</li>
      <li><strong>Jméno:</strong> ${name}</li>
      <li><strong>Email:</strong> ${email}</li>
      <li><strong>Telefon:</strong> ${phone ?? '-'}</li>
    </ul>
  `;

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
 * Sends a cancellation email to the customer and an internal copy.
 */
async function sendCancellationEmail(booking, message) {
  const { name, email, date, hours, phone } = booking;
  const dateLabel = formatYMD(date);

  const subject = `Zrušení rezervace – ${dateLabel}`;
  const html = `
    <h2>Zrušení rezervace</h2>
    <p>Omlouváme se, ale vaše rezervace ve zkušebně Banger byla zrušena.</p>
    <ul>
      <li><strong>Datum:</strong> ${dateLabel}</li>
      <li><strong>Hodiny:</strong> ${Array.isArray(hours) ? hours.join(', ') : String(hours)}</li>
      <li><strong>Jméno:</strong> ${name}</li>
      <li><strong>Email:</strong> ${email}</li>
      <li><strong>Telefon:</strong> ${phone ?? '-'}</li>
    </ul>
    ${message ? `<p><strong>Doplňující zpráva od provozovatele:</strong><br>${message}</p>` : ''}
    <p>V případě dotazů napište na <a href="mailto:info@topzkusebny.cz">info@topzkusebny.cz</a>.</p>
  `;

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

// Keep default export for confirmation; add cancellation as a property
module.exports = sendConfirmationEmail;
module.exports.sendCancellationEmail = sendCancellationEmail;