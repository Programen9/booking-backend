// index.js
require('./db');

const authMiddleware = require('./authMiddleware');
const sendConfirmationEmail = require('./mailer'); // default export
const {
  sendPaymentRequestEmail,
  sendCancellationEmail,
  sendPaymentExpiredEmail,
} = require('./mailer');

const express = require('express');
const app = express();
app.set('trust proxy', 1);
const PORT = 3001;

const cors = require('cors');
const sanitizeHtml = require('sanitize-html');
const rateLimit = require('express-rate-limit');

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests from this IP. Please try again later.' },
});

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const allowed = [
      'http://localhost:5173',
      'https://topzkusebny-booking-frontend.netlify.app'
    ];
    if (allowed.includes(origin)) return cb(null, true);
    return cb(new Error('CORS not allowed from this origin'), false);
  },
  credentials: true
}));

app.use(express.json());

const db = require('./db');

/* ------------------ Settings helpers ------------------ */
async function getSetting(key, fallback) {
  return new Promise((resolve) => {
    db.query('SELECT value FROM settings WHERE `key`=?', [key], (err, rows) => {
      if (err || !rows || rows.length === 0) return resolve(fallback);
      resolve(rows[0].value);
    });
  });
}

async function getPriceCZK() {
  const envDefault = Number(process.env.PRICE_PER_HOUR_CZK || 200);
  const val = await getSetting('price_per_hour_czk', String(envDefault));
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : envDefault;
}

async function getAccessCode() {
  const envDefault = process.env.ACCESS_CODE || '***KÓD NENASTAVEN***';
  const val = await getSetting('access_code', envDefault);
  return val || envDefault;
}

// ------------------ GoPay configuration (production only) ------------------
const GOPAY_BASE = 'https://gate.gopay.cz/api';
const GOPAY_GOID = process.env.GOPAY_GOID;
const GOPAY_CLIENT_ID = process.env.GOPAY_CLIENT_ID;
const GOPAY_CLIENT_SECRET = process.env.GOPAY_CLIENT_SECRET;

// OAuth2 token
async function gopayToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'payment-create payment-all'
  });

  const auth = Buffer.from(`${GOPAY_CLIENT_ID}:${GOPAY_CLIENT_SECRET}`).toString('base64');

  const r = await fetch(`${GOPAY_BASE}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`GoPay token error: ${r.status} ${t}`);
  }
  return r.json();
}

// Create payment
async function gopayCreatePayment({ amount_czk, order_number, name, email, returnUrl, notifyUrl }) {
  const { access_token } = await gopayToken();

  const payload = {
    target: { goid: Number(GOPAY_GOID), type: 'ACCOUNT' },
    amount: amount_czk * 100, // minor units
    currency: 'CZK',
    order_number,
    lang: 'cs',
    callback: { return_url: returnUrl, notification_url: notifyUrl },
    payer: {
      default_payment_instrument: 'PAYMENT_CARD',
      contact: { first_name: name || '', email: email || '' }
    }
  };

  const r = await fetch(`${GOPAY_BASE}/payments/payment`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GoPay create error: ${r.status} ${JSON.stringify(data)}`);

  return { id: data.id, gw_url: data.gw_url || data.gateway_url };
}

// Get payment status
async function gopayGetPayment(id) {
  const { access_token } = await gopayToken();
  const r = await fetch(`${GOPAY_BASE}/payments/payment/${id}`, {
    headers: { 'Authorization': `Bearer ${access_token}` }
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GoPay status error: ${r.status} ${JSON.stringify(data)}`);
  return data; // { id, state: { id: 'PAID' | ... } }
}

/* ------------------ Utilities ------------------ */
function safeParseHours(val) {
  if (typeof val === 'string') { try { return JSON.parse(val); } catch { return []; } }
  return Array.isArray(val) ? val : [];
}

/* =========================
   PUBLIC: create booking (PENDING + GoPay link)
   ========================= */
app.post('/book', publicLimiter, async (req, res) => {
  const newBooking = req.body;

  // sanitize
  newBooking.name  = sanitizeHtml(newBooking.name,  { allowedTags: [], allowedAttributes: {} });
  newBooking.email = sanitizeHtml(newBooking.email, { allowedTags: [], allowedAttributes: {} });
  newBooking.phone = sanitizeHtml(newBooking.phone, { allowedTags: [], allowedAttributes: {} });

  // reCAPTCHA
  const token = newBooking.token;
  if (!token) return res.status(400).json({ message: 'Chybí reCAPTCHA token' });
  try {
    const rc = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: process.env.RECAPTCHA_SECRET_KEY,
        response: token,
      }),
    });
    const rcData = await rc.json();
    if (!rcData.success || rcData.score < 0.5) {
      console.warn('❌ reCAPTCHA selhalo:', rcData);
      return res.status(403).json({ message: 'Ověření reCAPTCHA selhalo.' });
    }
  } catch (e) {
    console.error('❌ Chyba při ověřování reCAPTCHA:', e);
    return res.status(500).json({ message: 'Chyba při ověřování reCAPTCHA.' });
  }

  // no past bookings
  const bookingDate = new Date(newBooking.date);
  const today = new Date(); today.setHours(0,0,0,0);
  if (bookingDate < today) return res.status(400).json({ message: 'Nelze rezervovat zpětně.' });

  // conflict check
  const checkQuery = `
    SELECT * FROM bookings 
    WHERE date = ? 
    AND (${newBooking.hours.map(() => `JSON_CONTAINS(hours, ?, '$')`).join(' OR ')})
  `;
  const params = [newBooking.date, ...newBooking.hours.map(h => JSON.stringify(h))];
  db.query(checkQuery, params, async (err, results) => {
    if (err) { console.error('❌ MySQL SELECT error:', err); return res.status(500).json({ message: 'Chyba serveru' }); }
    if (results.length > 0) return res.status(409).json({ message: 'Termín je již rezervovaný.' });

    // compute price from settings (fallback to env)
    const PRICE_PER_HOUR_CZK = await getPriceCZK();
    const amount_czk = (Array.isArray(newBooking.hours) ? newBooking.hours.length : 0) * PRICE_PER_HOUR_CZK;
    const orderNo = `TZ-${Date.now()}`;

    // insert as pending, with 15-minute expiry
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const insertQuery = `
      INSERT INTO bookings (date, hours, name, email, phone, amount_czk, currency, payment_status, gopay_order_number, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'CZK', 'pending', ?, ?)
    `;
    db.query(insertQuery, [
      newBooking.date,
      JSON.stringify(newBooking.hours),
      newBooking.name,
      newBooking.email,
      newBooking.phone,
      amount_czk,
      orderNo,
      expiresAt
    ], async (insErr, result) => {
      if (insErr) { console.error('❌ MySQL INSERT error:', insErr); return res.status(500).json({ message: 'Chyba při ukládání' }); }

      const bookingId = result.insertId;
      try {
        // Create GoPay payment
        const returnUrl = 'https://topzkusebny.cz'; // after payment
        const notifyUrl = `${process.env.PUBLIC_API_BASE || 'https://booking-backend-production-ef0d.up.railway.app'}/gopay/webhook`;

        const { id: gopayId, gw_url } = await gopayCreatePayment({
          amount_czk,
          order_number: orderNo,
          name: newBooking.name,
          email: newBooking.email,
          returnUrl,
          notifyUrl
        });

        // store payment info
        db.query(
          `UPDATE bookings SET gopay_payment_id=?, payment_url=?, payment_created_at=NOW() WHERE id=?`,
          [gopayId, gw_url, bookingId],
          async (upErr) => {
            if (upErr) console.error('❌ MySQL UPDATE payment info error:', upErr);

            // send payment email
            try {
              await sendPaymentRequestEmail({
                ...newBooking,
                amount_czk,
                payment_url: gw_url,
                expires_at: expiresAt
              });
            } catch (emErr) {
              console.error('❌ Failed to send payment request email:', emErr);
            }

            // respond to FE (so it can show a "Zaplatit teď" button)
            res.status(200).json({
              message: 'Rezervace vytvořena. Čeká se na platbu.',
              payment_url: gw_url,
              expires_at: expiresAt,
              booking_id: bookingId,
              amount_czk
            });
          }
        );
      } catch (payErr) {
        console.error('❌ GoPay create error:', payErr);
        db.query(
          `UPDATE bookings SET payment_status='failed', payment_error=? WHERE id=?`,
          [String(payErr), bookingId],
          () => {}
        );
        res.status(502).json({ message: 'Chyba platební brány. Zkuste to prosím znovu.' });
      }
    });
  });
});

/* =========================
   PUBLIC: booked hours for a date (limited)
   ========================= */
app.get('/bookings/:date', publicLimiter, (req, res) => {
  const date = req.params.date;
  db.query('SELECT date, hours FROM bookings', [], (err, results) => {
    if (err) { console.error('❌ MySQL query error:', err); return res.status(500).json({ message: 'Server error' }); }
    const matching = results.filter(row => new Date(row.date).toISOString().split('T')[0] === date);
    const allHours = matching.flatMap((row) => {
      if (typeof row.hours === 'string') { try { return JSON.parse(row.hours); } catch { return []; } }
      if (Array.isArray(row.hours)) return row.hours;
      return [];
    });
    res.json({ hours: allHours });
  });
});

/* =========================
   ADMIN: list, cancel (no rate limit)
   ========================= */
app.get('/all-bookings', authMiddleware, (req, res) => {
  db.query('SELECT * FROM bookings', (err, results) => {
    if (err) { console.error('❌ MySQL query error:', err); return res.status(500).json({ message: 'Server error' }); }
    const bookings = results.map((row) => ({
      id: row.id,
      date: row.date,
      hours: safeParseHours(row.hours),
      name: row.name,
      email: row.email,
      phone: row.phone,
      payment_status: row.payment_status,
      amount_czk: row.amount_czk,
      expires_at: row.expires_at
    }));
    res.json(bookings);
  });
});

app.post('/bookings/:id/cancel', authMiddleware, (req, res) => {
  const bookingId = req.params.id;
  const { message } = req.body || {};
  db.query('SELECT * FROM bookings WHERE id = ?', [bookingId], async (selErr, results) => {
    if (selErr) { console.error('❌ MySQL SELECT error:', selErr); return res.status(500).json({ message: 'Chyba serveru' }); }
    if (!results || results.length === 0) return res.status(404).json({ message: 'Rezervace nenalezena' });

    const row = results[0];
    const booking = {
      id: row.id,
      date: row.date,
      hours: safeParseHours(row.hours),
      name: row.name,
      email: row.email,
      phone: row.phone
    };

    try { await sendCancellationEmail(booking, message); } catch (e) { console.error('❌ Failed to send cancellation email:', e); }
    db.query('DELETE FROM bookings WHERE id = ?', [bookingId], (delErr) => {
      if (delErr) { console.error('❌ MySQL DELETE error:', delErr); return res.status(500).json({ message: 'Chyba serveru při mazání' }); }
      res.status(200).json({ message: 'Rezervace zrušena a email odeslán (pokud bylo možné).' });
    });
  });
});

/* =========================
   ADMIN: settings (get/update)
   ========================= */
app.get('/admin/settings', authMiddleware, async (req, res) => {
  db.query('SELECT `key`, `value` FROM settings', [], (err, rows) => {
    if (err) return res.status(500).json({ message: 'DB error' });
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    res.json({
      price_per_hour_czk: map.price_per_hour_czk || String(process.env.PRICE_PER_HOUR_CZK || 200),
      access_code: map.access_code || process.env.ACCESS_CODE || '***KÓD NENASTAVEN***'
    });
  });
});

app.put('/admin/settings', authMiddleware, async (req, res) => {
  const { price_per_hour_czk, access_code } = req.body || {};
  const entries = [];
  if (price_per_hour_czk !== undefined) entries.push(['price_per_hour_czk', String(price_per_hour_czk)]);
  if (access_code !== undefined)        entries.push(['access_code', String(access_code)]);
  if (entries.length === 0) return res.json({ ok: true });

  const promises = entries.map(([k, v]) =>
    new Promise(resolve => {
      db.query(
        `INSERT INTO settings (\`key\`, \`value\`) VALUES (?, ?) ON DUPLICATE KEY UPDATE \`value\`=VALUES(\`value\`)`,
        [k, v], () => resolve()
      );
    })
  );
  await Promise.all(promises);
  res.json({ ok: true });
});

/* =========================
   GOPAY: webhook (no auto-cancel on non-PAID)
   ========================= */
app.all('/gopay/webhook', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const id =
      (req.query && (req.query.id || req.query.parent_id)) ||
      (req.body && (req.body.id || req.body.parent_id));

    if (!id) {
      console.warn('GoPay webhook hit without id', { method: req.method, query: req.query, body: req.body });
      return res.status(200).json({ ok: true, note: 'missing id' });
    }

    const status = await gopayGetPayment(id);
    const state = status?.state?.id || status?.state;

    db.query('SELECT * FROM bookings WHERE gopay_payment_id = ?', [id], async (err, results) => {
      if (err) return res.status(200).json({ ok: true, note: 'db error' });
      if (!results || results.length === 0) return res.status(200).json({ ok: true, note: 'booking not found' });

      const row = results[0];
      const hours = safeParseHours(row.hours);

      if (state === 'PAID') {
        db.query(
          `UPDATE bookings SET payment_status='paid', payment_paid_at=NOW(), payment_error=NULL WHERE id=?`,
          [row.id],
          async (upErr) => {
            if (upErr) console.error('❌ MySQL UPDATE error:', upErr);
            try {
              const accessCode = await getAccessCode();
              await sendConfirmationEmail({
                name: row.name, email: row.email, date: row.date, hours, phone: row.phone,
                accessCode
              });
            } catch (e) { console.error('❌ sendConfirmationEmail error:', e); }
            return res.status(200).json({ ok: true, state: 'PAID' });
          }
        );
      } else {
        // Note only; let 15-min expiry handle cancellations.
        db.query(
          `UPDATE bookings SET payment_error=? WHERE id=?`,
          [JSON.stringify({ state }), row.id],
          () => res.status(200).json({ ok: true, state })
        );
      }
    });
  } catch (e) {
    console.error('❌ webhook error:', e);
    return res.status(200).json({ ok: true });
  }
});

/* =========================
   HOUSEKEEPING: expire unpaid after 15 minutes
   ========================= */
setInterval(() => {
  const now = new Date();
  db.query(
    `SELECT * FROM bookings WHERE payment_status='pending' AND expires_at IS NOT NULL AND expires_at < ?`,
    [now],
    (err, rows) => {
      if (err) return console.error('❌ expire SELECT error:', err);
      rows.forEach(row => {
        const hours = safeParseHours(row.hours);
        sendPaymentExpiredEmail({ email: row.email, date: row.date, hours })
          .catch(e => console.error('❌ expire email error:', e))
          .finally(() => {
            db.query('DELETE FROM bookings WHERE id=?', [row.id], (delErr) => {
              if (delErr) console.error('❌ expire DELETE error:', delErr);
              else console.log(`🗑️ expired & deleted booking id=${row.id}`);
            });
          });
      });
    }
  );
}, 60 * 1000);

/* =========================
   POLLING: confirm paid bookings every 30s (no cancelling)
   ========================= */
setInterval(() => {
  db.query(
    `SELECT id, gopay_payment_id, date, hours, name, email, phone
     FROM bookings
     WHERE payment_status='pending'
       AND gopay_payment_id IS NOT NULL
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 20`,
    async (err, rows) => {
      if (err) return console.error('❌ polling SELECT error:', err);
      for (const row of rows) {
        const payId = row.gopay_payment_id;
        try {
          const status = await gopayGetPayment(payId);
          const state = status?.state?.id || status?.state;
          if (state === 'PAID') {
            await new Promise((resolve) => {
              db.query(
                `UPDATE bookings SET payment_status='paid', payment_paid_at=NOW(), payment_error=NULL WHERE id=?`,
                [row.id],
                (upErr) => { if (upErr) console.error('❌ polling UPDATE error:', upErr); resolve(); }
              );
            });
            try {
              const hours = safeParseHours(row.hours);
              const accessCode = await getAccessCode();
              await sendConfirmationEmail({
                name: row.name, email: row.email, date: row.date, hours, phone: row.phone,
                accessCode
              });
              console.log('✅ Polling: confirmed paid & emailed for booking id', row.id);
            } catch (e) {
              console.error('❌ Polling sendConfirmationEmail error:', e);
            }
          } else {
            db.query(
              `UPDATE bookings SET payment_error=? WHERE id=?`,
              [JSON.stringify({ state }), row.id],
              () => {}
            );
          }
        } catch (e) {
          console.error('❌ Polling gopayGetPayment error for', payId, e?.message || e);
        }
      }
    }
  );
}, 30 * 1000);

/* =========================
   Keepalive (24/7)
   ========================= */
setInterval(() => {
  db.query('SELECT 1', (err) => {
    if (err) console.error('🔄 DB keepalive error:', err.message || err);
    else console.log('🔄 DB keepalive OK');
  });
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});