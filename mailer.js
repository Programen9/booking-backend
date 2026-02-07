// mailer.js
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// Helper: normalize YYYY-MM-DD
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
// Helper: format D.M.YYYY (Europe/Prague), bez mezer
function formatDMY(d) {
  try {
    let dt;

    if (d instanceof Date) {
      dt = d;
    } else {
      const s = String(d ?? '');
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);

      // Bezpečný parse pro "date-only" (YYYY-MM-DD)
      if (m) {
        const y = Number(m[1]);
        const mo = Number(m[2]) - 1; // 0-11
        const day = Number(m[3]);
        dt = new Date(y, mo, day);
      } else {
        // Fallback pro jiné formáty (např. ISO s časem)
        dt = new Date(s);
      }
    }

    if (Number.isNaN(dt.getTime())) return String(d ?? '');

    const out = dt.toLocaleDateString('cs-CZ', {
      timeZone: 'Europe/Prague',
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
    });

    return out.replace(/\s/g, '');
  } catch {
    return String(d ?? '');
  }
}
function formatTimeHM(d) {
  try {
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toLocaleTimeString('cs-CZ', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}
function normalizeHoursToRange(hours) {
  if (!Array.isArray(hours) || hours.length === 0) return '';

  const slots = hours
    .map(h => String(h).replace(/–/g, '-'))
    .map(h => {
      const [from, to] = h.split('-').map(s => s.trim());
      return { from, to };
    })
    .sort((a, b) => a.from.localeCompare(b.from));

  if (slots.length === 0) return '';

  const start = slots[0].from;
  const end = slots[slots.length - 1].to;

  return `${start}-${end}`;
}

async function sendMail({ to, subject, html }) {
  const from = 'TopZkušebny <info@topzkusebny.cz>';
  try {
    const r1 = await resend.emails.send({ from, to, subject, html, reply_to: 'info@topzkusebny.cz' });
    console.log('✅ [Resend] sent to customer:', r1?.id || r1);
  } catch (err) {
    console.error('❌ [Resend] send failed (customer):', err?.message || err);
  }
  try {
    const r2 = await resend.emails.send({ from, to: 'info@topzkusebny.cz', subject: `Kopie: ${subject}`, html, reply_to: 'info@topzkusebny.cz' });
    console.log('✅ [Resend] sent internal copy:', r2?.id || r2);
  } catch (err) {
    console.error('❌ [Resend] send failed (internal):', err?.message || err);
  }
}

/** A) PAYMENT REQUEST */
async function sendPaymentRequestEmail(booking) {
  const { name, email, date, hours, amount_czk, payment_url, expires_at } = booking;
  const dateLabel = formatDMY(date);
  const expiresLabel = formatTimeHM(expires_at);
  const subject = `Pokyny k platbě - rezervace z ${dateLabel} (uhraďte do 15 minut)`;
  const html = `
    <img src="https://topzkusebny.cz/wp-content/uploads/2026/01/5-text-horizontal.jpg">
    <h2>Zaplaťte prosím rezervaci</h2>
    <p>Vaše rezervace je dočasně držena po dobu 15 minut. Po uplynutí doby rezervace bude termín uvolněn.</p>
    <ul>
      <li><strong>Datum:</strong> ${dateLabel}</li>
      <li><strong>Hodiny:</strong> ${normalizeHoursToRange(hours)}</li>
      <li><strong>Částka k úhradě:</strong> ${amount_czk} Kč</li>
      <li><strong>Platnost rezervace do:</strong> ${expiresLabel}</li>
    </ul>
    <p><a href="${payment_url}" target="_blank" style="display:inline-block;padding:10px 14px;background:#306d29;color:#fff;border-radius:6px;text-decoration:none">Zaplatit přes GoPay</a></p>
    <p>V případě dotazů napište na <a href="mailto:info@topzkusebny.cz">info@topzkusebny.cz</a>.</p>
  `;
  await sendMail({ to: email, subject, html });
}

/** B) CONFIRMATION (uses booking.accessCode if provided) */
async function sendConfirmationEmail(booking) {
  const { name, email, date, hours, phone, accessCode: overrideCode } = booking;
  const dateLabel = formatDMY(date);
  const accessCode = overrideCode || process.env.ACCESS_CODE || '***KÓD NENASTAVEN***';

  const subject = `Potvrzení zaplacené rezervace z ${dateLabel}`;
  const html = `
    <img src="https://topzkusebny.cz/wp-content/uploads/2026/01/5-text-horizontal.jpg">
    <h2>Potvrzení zaplacené rezervace</h2>
    <p>Děkujeme za platbu. Vaše rezervace je potvrzená.</p>
    <ul>
      <li><strong>Datum:</strong> ${dateLabel}</li>
      <li><strong>Hodiny:</strong> ${normalizeHoursToRange(hours)}</li>
      <li><strong>Jméno:</strong> ${name}</li>
      <li><strong>Email:</strong> ${email}</li>
      <li><strong>Telefon:</strong> ${phone ?? '-'}</li>
    </ul>
    <p><strong>Přístupový kód do zkušebny:</strong> ${accessCode}</p>
    <p>Adresu a návod, jak se do zkušebny dostat, najdete na <a href="https://topzkusebny.cz/#kudy-kam" target="_blank">TopZkusebny.cz/#kudy-kam</a>.</p>
    <p>PS: Za každou zarezervovanou hodinu si můžete z lednice vzít <strong>jeden nápoj zdarma ;)</strong></p>
  `;
  await sendMail({ to: email, subject, html });
}

/** C) CANCELLATION */
async function sendCancellationEmail(booking, message) {
  const { name, email, date, hours, phone } = booking;
  const dateLabel = formatDMY(date);
  const subject = `Zrušení rezervace z ${dateLabel}`;
  const html = `
    <img src="https://topzkusebny.cz/wp-content/uploads/2026/01/5-text-horizontal.jpg">
    <h2>Zrušení rezervace</h2>
    <p>Omlouváme se, ale vaše rezervace ve zkušebně Banger byla zrušena.</p>
    <ul>
      <li><strong>Datum:</strong> ${dateLabel}</li>
      <li><strong>Hodiny:</strong> ${normalizeHoursToRange(hours)}</li>
      <li><strong>Jméno:</strong> ${name}</li>
      <li><strong>Email:</strong> ${email}</li>
      <li><strong>Telefon:</strong> ${phone ?? '-'}</li>
    </ul>
    ${message ? `<p><strong>Vysvětlení:</strong><br>${message}</p>` : ''}
    <p>V případě dotazů napište na <a href="mailto:info@topzkusebny.cz">info@topzkusebny.cz</a>.</p>
  `;
  await sendMail({ to: email, subject, html });
}

/** D) PAYMENT EXPIRED */
async function sendPaymentExpiredEmail(booking) {
  const { email, date, hours } = booking;
  const dateLabel = formatDMY(date);
  const subject = `Rezervace z ${dateLabel} vypršela`;
  const html = `
    <img src="https://topzkusebny.cz/wp-content/uploads/2026/01/5-text-horizontal.jpg">
    <h2>Rezervace vypršela</h2>
    <p>Platba nebyla dokončena do 15 minut, proto byla vaše rezervace zrušena a termín byl uvolněn.</p>
    <ul>
      <li><strong>Datum:</strong> ${dateLabel}</li>
      <li><strong>Hodiny:</strong> ${normalizeHoursToRange(hours)}</li>
    </ul>
    <p>Můžete si zvolit jiný termín na <a href="https://topzkusebny.cz" target="_blank">TopZkusebny.cz</a>.</p>
  `;
  await sendMail({ to: email, subject, html });
}

module.exports = sendConfirmationEmail;
module.exports.sendPaymentRequestEmail = sendPaymentRequestEmail;
module.exports.sendCancellationEmail = sendCancellationEmail;
module.exports.sendPaymentExpiredEmail = sendPaymentExpiredEmail;