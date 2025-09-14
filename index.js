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

/* ------------------ GoPay helpers (sandbox) ------------------ */
const GOPAY_MODE = process.env.GOPAY_MODE || 'sandbox';
const GOPAY_BASE = GOPAY_MODE === 'production'
  ? 'https://gw.gopay.com/api'
  : 'https://gw.sandbox.gopay.com/api';

const GOPAY_GOID = process.env.GOPAY_GOID || '8229333805';
const GOPAY_CLIENT_ID = process.env.GOPAY_CLIENT_ID || '1785219876';
const GOPAY_CLIENT_SECRET = process.env.GOPAY_CLIENT_SECRET || 'xZrM8MK6';

// price per hour in CZK
const PRICE_PER_HOUR_CZK = Number(process.env.PRICE_PER_HOUR_CZK || 200);

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
  return r.json(); // { access_token, token_type, expires_in, ... }
}

// Create payment
async function gopayCreatePayment({ amount_czk, order_number, name, email, returnUrl, notifyUrl }) {
  const { access_token } = await gopayToken();

  const payload = {
    target: { goid: Number(GOPAY_GOID), type: 'ACCOUNT' },
    amount: amount_czk * 100, // GoPay wants minor units
    currency: 'CZK',
    order_number,
    lang: 'cs',
    callback: {
      return_url: returnUrl,
      notification_url: notifyUrl
    },
    payer: {
      default_payment_instrument: 'PAYMENT_CARD',
      contact: {
        first_name: name || '',
        email: email || ''
      }
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

  // expect { id, gw_url, ... }
  return { id: data.id, gw_url: data.gw_url || data.gateway_url };
}

// Get payment status (used by webhook or manual check)
async function gopayGetPayment(id) {
  const { access_token } = await gopayToken();
  const r = await fetch(`${GOPAY_BASE}/payments/payment/${id}`, {
    headers: { 'Authorization': `Bearer ${access_token}` }
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GoPay status error: ${r.status} ${JSON.stringify(data)}`);
  return data; // { id, state: { ... } }
}

/* ------------------ Utilities ------------------ */
function safeParseHours(val) {
  if (typeof val === 'string') { try { return JSON.parse(val); } catch { return []; } }
  return Array.isArray(val) ? val : [];
}

/* =========================
   PUBLIC: create booking (now PENDING + GoPay link)
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
  const now = new Date(); now.setHours(0,0,0,0);
  if (bookingDate < now) return res.status(400).json({ message: 'Nelze rezervovat zpětně.' });

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

    // compute price
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
        const returnUrl = 'https://topzkusebny.cz'; // after payment (can be a dedicated thank-you)
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

            // respond to FE with link, in case you want to redirect there
            res.status(200).json({
              message: 'Rezervace vytvořena. Čeká se na platbu.',
              payment_url: gw_url,
              expires_at: expiresAt,
              booking_id: bookingId
            });
          }
        );
      } catch (payErr) {
        console.error('❌ GoPay create error:', payErr);
        // mark failed & free slot immediately
        db.query(`UPDATE bookings SET payment_status='failed', payment_error=? WHERE id=?`, [String(payErr), bookingId], () => {});
        res.status(502).json({ message: 'Chyba platební brány. Zkuste to prosím znovu.' });
      }
    });
  });
});

/* =========================
   PUBLIC: booked hours for a date (unchanged; limited)
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
   GOPAY: webhook (payment status)
   ========================= */
app.post('/gopay/webhook', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ message: 'Missing payment id' });

    // fetch payment status from GoPay
    const status = await gopayGetPayment(id);
    // status.state might look like: { id: "PAID" | "CREATED" | "CANCELED" | ... }
    const state = status?.state?.id || status?.state;

    db.query('SELECT * FROM bookings WHERE gopay_payment_id = ?', [id], (err, results) => {
      if (err) { console.error('❌ MySQL SELECT error:', err); return res.status(500).json({ message: 'DB error' }); }
      if (!results || results.length === 0) return res.status(404).json({ message: 'Booking not found' });

      const row = results[0];
      const hours = safeParseHours(row.hours);

      if (state === 'PAID') {
        db.query(
          `UPDATE bookings SET payment_status='paid', payment_paid_at=NOW() WHERE id=?`,
          [row.id],
          async (upErr) => {
            if (upErr) console.error('❌ MySQL UPDATE error:', upErr);
            // send confirmation with access code
            try {
              await sendConfirmationEmail({
                name: row.name,
                email: row.email,
                date: row.date,
                hours,
                phone: row.phone,
              });
            } catch (e) {
              console.error('❌ sendConfirmationEmail error:', e);
            }
            return res.status(200).json({ ok: true });
          }
        );
      } else if (state === 'CANCELED' || state === 'TIMEOUTED' || state === 'FAILED') {
        // optional: free immediately
        db.query('DELETE FROM bookings WHERE id=?', [row.id], async (delErr) => {
          if (delErr) console.error('❌ MySQL DELETE error:', delErr);
          try { await sendPaymentExpiredEmail({ email: row.email, date: row.date, hours }); } catch {}
          return res.status(200).json({ ok: true });
        });
      } else {
        return res.status(200).json({ ok: true, state });
      }
    });
  } catch (e) {
    console.error('❌ webhook error:', e);
    return res.status(500).json({ message: 'server error' });
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
        // send expiration email, then delete
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
}, 60 * 1000); // run every minute

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