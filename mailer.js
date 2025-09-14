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

// Helper: HH:MM (local)
function formatTimeHM(d) {
  try {
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

async function sendMail({ to, subject, html }) {
  const from = 'TopZkušebny <info@topzkusebny.cz>';
  // customer
  try {
    const r1 = await resend.emails.send({ from, to, subject, html, reply_to: 'info@topzkusebny.cz' });
    console.log('✅ [Resend] sent to customer:', r1?.id || r1);
  } catch (err) {
    console.error('❌ [Resend] send failed (customer):', err?.message || err);
  }
  // internal copy
  try {
    const r2 = await resend.emails.send({ from, to: 'info@topzkusebny.cz', subject: `Kopie: ${subject}`, html, reply_to: 'info@topzkusebny.cz' });
    console.log('✅ [Resend] sent internal copy:', r2?.id || r2);
  } catch (err) {
    console.error('❌ [Resend] send failed (internal):', err?.message || err);
  }
}

/** A) PAYMENT REQUEST (new) */
async function sendPaymentRequestEmail(booking) {
  const { name, email, date, hours, amount_czk, payment_url, expires_at } = booking;
  const dateLabel = formatYMD(date);
  const expiresLabel = formatTimeHM(expires_at);

  const subject = `Platba rezervace – ${dateLabel} (uhraďte do 15 minut)`;
  const html = `
    <h2>Zaplaťte prosím rezervaci</h2>
    <p>Vaše rezervace je dočasně držena po dobu 15 minut. Po uplynutí doby rezervace bude termín uvolněn.</p>
    <ul>
      <li><strong>Datum:</strong> ${dateLabel}</li>
      <li><strong>Hodiny:</strong> ${Array.isArray(hours) ? hours.join(', ') : String(hours)}</li>
      <li><strong>Částka k úhradě:</strong> ${amount_czk} Kč</li>
      <li><strong>Platnost rezervace do:</strong> ${expiresLabel}</li>
    </ul>
    <p><a href="${payment_url}" target="_blank" style="display:inline-block;padding:10px 14px;background:#306d29;color:#fff;border-radius:6px;text-decoration:none">Zaplatit přes GoPay</a></p>
    <p>V případě dotazů napište na <a href="mailto:info@topzkusebny.cz">info@topzkusebny.cz</a>.</p>
  `;
  await sendMail({ to: email, subject, html });
}

/** B) CONFIRMATION (already used; unchanged body, but reused for 'paid') */
async function sendConfirmationEmail(booking) {
  const { name, email, date, hours, phone } = booking;
  const dateLabel = formatYMD(date);
  const accessCode = process.env.ACCESS_CODE || '***KÓD NENASTAVEN***';

  const subject = `Potvrzení rezervace – ${dateLabel}`;
  const html = `
    <h2>Potvrzení rezervace</h2>
    <p>Děkujeme za platbu. Vaše rezervace je potvrzená.</p>
    <ul>
      <li><strong>Datum:</strong> ${dateLabel}</li>
      <li><strong>Hodiny:</strong> ${Array.isArray(hours) ? hours.join(', ') : String(hours)}</li>
      <li><strong>Jméno:</strong> ${name}</li>
      <li><strong>Email:</strong> ${email}</li>
      <li><strong>Telefon:</strong> ${phone ?? '-'}</li>
    </ul>
    <p><strong>Přístupový kód do zkušebny:</strong> ${accessCode}</p>
  `;
  await sendMail({ to: email, subject, html });
}

/** C) CANCELLATION (already used) */
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
    ${message ? `<p><strong>Doplňující zpráva:</strong><br>${message}</p>` : ''}
    <p>V případě dotazů napište na <a href="mailto:info@topzkusebny.cz">info@topzkusebny.cz</a>.</p>
  `;
  await sendMail({ to: email, subject, html });
}

/** D) PAYMENT EXPIRED (new) */
async function sendPaymentExpiredEmail(booking) {
  const { email, date, hours } = booking;
  const dateLabel = formatYMD(date);
  const subject = `Rezervace vypršela – ${dateLabel}`;
  const html = `
    <h2>Rezervace vypršela</h2>
    <p>Platba nebyla dokončena do 15 minut, proto byla vaše rezervace zrušena a termín byl uvolněn.</p>
    <ul>
      <li><strong>Datum:</strong> ${dateLabel}</li>
      <li><strong>Hodiny:</strong> ${Array.isArray(hours) ? hours.join(', ') : String(hours)}</li>
    </ul>
    <p>Můžete si zvolit jiný termín na <a href="https://topzkusebny.cz">topzkusebny.cz</a>.</p>
  `;
  await sendMail({ to: email, subject, html });
}

// Default export kept for backward compatibility (confirmation):
module.exports = sendConfirmationEmail;
// Named exports:
module.exports.sendPaymentRequestEmail = sendPaymentRequestEmail;
module.exports.sendCancellationEmail = sendCancellationEmail;
module.exports.sendPaymentExpiredEmail = sendPaymentExpiredEmail;