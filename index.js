// index.js

if (typeof fetch !== 'function') {
  throw new Error('Global fetch is not available. Use Node 18+ or add node-fetch dependency.');
}

const { URLSearchParams } = require('url');

const authMiddleware = require('./authMiddleware');
const mailer = require('./mailer'); // default export + named exports

const sendConfirmationEmail = mailer;
const {
  sendPaymentRequestEmail,
  sendCancellationEmail,
  sendPaymentExpiredEmail,
} = mailer;

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

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);

    const allowed = [
      'http://localhost:5173',
      'https://topzkusebny-booking-frontend.netlify.app',
      'https://topzkusebny.cz',
      'https://www.topzkusebny.cz',
      // 'https://tvoje-admin-domena.netlify.app',
    ];

    if (allowed.includes(origin)) return cb(null, true);
    return cb(new Error('CORS not allowed from this origin'), false);
  },

  credentials: true,

  allowedHeaders: [
    'Content-Type',
    'X-Admin-Password',
    'x-admin-password',
    'Authorization'
  ],

  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

app.use(express.json());

const db = require('./db');

const { sendSms } = require('./sms');

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

if (!GOPAY_GOID || !GOPAY_CLIENT_ID || !GOPAY_CLIENT_SECRET) {
  console.warn('⚠️ GoPay env missing. Check GOPAY_GOID, GOPAY_CLIENT_ID, GOPAY_CLIENT_SECRET.');
}

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
    body: body.toString()
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
    amount: Math.round(Number(amount_czk) * 100), // minor units (integer)
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

function stripDiacritics(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')             // sjednotí mezery
    .trim();
}

function formatDateCZ(dateLike) {
  // DB může vracet Date nebo string; chceme Praha timezone
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return '';

  // cs-CZ dá "5. 1. 2026" (s mezerama) -> zbavíme se mezer
  const s = d.toLocaleDateString('cs-CZ', {
    timeZone: 'Europe/Prague',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  });

  return s.replace(/\s/g, ''); // "5.1.2026"
}

function todayPragueYYYYMMDD() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Prague',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const y = parts.find(p => p.type === 'year')?.value;
  const m = parts.find(p => p.type === 'month')?.value;
  const d = parts.find(p => p.type === 'day')?.value;

  return `${y}-${m}-${d}`; // YYYY-MM-DD
}

function parseTimeToMinutes(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function minutesToTime(min) {
  const hh = String(Math.floor(min / 60)).padStart(2, '0');
  const mm = String(min % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function normalizeHoursToRanges(hoursArr) {
  // očekáváme např. ["20:00–21:00","21:00–22:00"] nebo s "-"
  const slots = (Array.isArray(hoursArr) ? hoursArr : [])
    .map(s => String(s || '').trim().replace(/–/g, '-'))
    .map(s => {
      const [a, b] = s.split('-').map(x => x && x.trim());
      const start = parseTimeToMinutes(a);
      const end = parseTimeToMinutes(b);
      if (start == null || end == null) return null;
      return { start, end };
    })
    .filter(Boolean)
    .sort((x, y) => x.start - y.start);

  if (slots.length === 0) return '';

  // sloučíme sousedící sloty (end === next.start)
  const merged = [];
  for (const slot of slots) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({ ...slot });
      continue;
    }
    if (last.end === slot.start) {
      last.end = slot.end;
    } else {
      merged.push({ ...slot });
    }
  }

  // výstup: "20:00-22:00" nebo "10:00-11:00,13:00-14:00"
  return merged.map(r => `${minutesToTime(r.start)}-${minutesToTime(r.end)}`).join(', ');
}

function buildPaidSmsText({ name, date, hours, accessCode }) {
  const cleanName = stripDiacritics(name);
  const d = formatDateCZ(date);
  const timeRanges = normalizeHoursToRanges(hours);

  // držíme diacritics-safe text (bez háčků/čárek) a bez em dash
  return `TopZkusebny.cz | Rezervace zaplacena | ${cleanName} - ${d} - ${timeRanges} | Pristupovy kod do zkusebny: ${accessCode}`;
}

function buildReceptionSmsText({ name, date, hours }) {
  const cleanName = stripDiacritics(name);
  const d = formatDateCZ(date);
  const timeRanges = normalizeHoursToRanges(hours);

  // format: 5.1.2026 | 20:00-22:00 | Vaclav Rychtarik
  return `${d} | ${timeRanges} | ${cleanName}`;
}

const { parsePhoneNumberFromString } = require('libphonenumber-js');

function normalizeAndValidatePhoneE164(input) {
  const raw = String(input || '').trim();

  // rychlá kontrola formátu, ať sem nelítá bordel
  if (!raw.startsWith('+')) return null;

  const phone = parsePhoneNumberFromString(raw);
  if (!phone) return null;

  if (!phone.isValid()) return null;

  // vždy vrátí E.164: +420777123456
  return phone.number;
}

function reserveSmsSend(bookingId) {
  return new Promise((resolve) => {
    db.query(
      `UPDATE bookings
       SET sms_status='pending'
       WHERE id=?
         AND (sms_status IS NULL OR sms_status='failed')`,
      [bookingId],
      (err, result) => {
        if (err) return resolve({ ok: false, reason: 'db_error', err });
        // affectedRows 1 = rezervováno, 0 = už pending nebo sent, nic nedělej
        resolve({ ok: result.affectedRows === 1 });
      }
    );
  });
}

function safeParseHours(val) {
  let arr = [];

  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      arr = Array.isArray(parsed) ? parsed : [];
    } catch {
      arr = [];
    }
  } else if (Array.isArray(val)) {
    arr = val;
  } else {
    arr = [];
  }

  // IMPORTANT: vždy vrátit jen validní stringy
  return arr
    .filter((h) => typeof h === 'string')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

/* =========================
   PUBLIC: create booking (PENDING + GoPay link)
   ========================= */
app.post('/book', publicLimiter, async (req, res) => {
  const newBooking = req.body;

  if (!newBooking || typeof newBooking !== 'object') {
    return res.status(400).json({ message: 'Neplatný request.' });
  }

  // sanitize
  newBooking.name  = sanitizeHtml(String(newBooking.name || ''),  { allowedTags: [], allowedAttributes: {} });
  newBooking.email = sanitizeHtml(String(newBooking.email || ''), { allowedTags: [], allowedAttributes: {} });
  newBooking.phone = sanitizeHtml(String(newBooking.phone || ''), { allowedTags: [], allowedAttributes: {} });

  const phoneE164 = normalizeAndValidatePhoneE164(newBooking.phone);
  if (!phoneE164) {
    return res.status(400).json({ message: 'Neplatné telefonní číslo. Použijte mezinárodní formát, např. +420777123456' });
  }
  newBooking.phone = phoneE164;

  if (!newBooking.name) {
    return res.status(400).json({ message: 'Chybí jméno.' });
  }
  if (!newBooking.email) {
    return res.status(400).json({ message: 'Chybí email.' });
  }

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

  // no past bookings (compare in Prague local day)
  const dateStr = String(newBooking.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ message: 'Neplatné datum. Použij YYYY-MM-DD.' });
  }

  const todayPrg = todayPragueYYYYMMDD();
  if (dateStr < todayPrg) {
    return res.status(400).json({ message: 'Nelze rezervovat zpětně.' });
  }

  if (!Array.isArray(newBooking.hours) || newBooking.hours.length === 0) {
    return res.status(400).json({ message: 'Chybí hodiny rezervace.' });
  }

  // normalize hours to always store with "-"
  newBooking.hours = newBooking.hours.map(h => String(h || '').trim().replace(/–/g, '-'));

  // conflict check (handle both "-" and "–" stored in DB)
  const conds = newBooking.hours
    .map(() => `(JSON_CONTAINS(hours, ?, '$') OR JSON_CONTAINS(hours, ?, '$'))`)
    .join(' OR ');

  const checkQuery = `
    SELECT id FROM bookings
    WHERE date = ?
    AND (
      payment_status = 'paid'
      OR (payment_status = 'pending' AND (expires_at IS NULL OR expires_at >= NOW()))
    )
    AND (${conds})
    LIMIT 1
  `;

  const params = [dateStr];
  newBooking.hours.forEach(hHy => {
    const hEn = hHy.replace(/-/g, '–');
    params.push(JSON.stringify(hHy)); // "20:00-21:00"
    params.push(JSON.stringify(hEn)); // "20:00–21:00"
  });

  db.query(checkQuery, params, async (err, results) => {
    if (err) { console.error('❌ MySQL SELECT error:', err); return res.status(500).json({ message: 'Chyba serveru' }); }
    if (results.length > 0) return res.status(409).json({ message: 'Termín je již rezervovaný.' });

    // compute price from settings (fallback to env)
    const PRICE_PER_HOUR_CZK = await getPriceCZK();
    const amount_czk = (Array.isArray(newBooking.hours) ? newBooking.hours.length : 0) * PRICE_PER_HOUR_CZK;
    if (!Number.isFinite(amount_czk) || amount_czk <= 0) {
      return res.status(500).json({ message: 'Neplatná cena rezervace. Kontaktujte prosím podporu.' });
    }
    const orderNo = `TZ-${Date.now()}`;

    // insert as pending, with 15-minute expiry
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const insertQuery = `
      INSERT INTO bookings (date, hours, name, email, phone, amount_czk, currency, payment_status, gopay_order_number, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'CZK', 'pending', ?, ?)
    `;
    db.query(insertQuery, [
      dateStr,
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
  db.query(
    `SELECT date, hours FROM bookings
     WHERE date = ?
     AND (
       payment_status = 'paid'
       OR (payment_status = 'pending' AND (expires_at IS NULL OR expires_at >= NOW()))
     )`,
    [date],
    (err, results) => {
    if (err) { console.error('❌ MySQL query error:', err); return res.status(500).json({ message: 'Server error' }); }
    const allHours = results.flatMap((row) => {
      if (typeof row.hours === 'string') {
        try {
          const arr = JSON.parse(row.hours);
          return Array.isArray(arr) ? arr.map(h => String(h).replace(/–/g, '-')) : [];
        } catch {
          return [];
        }
      }
      if (Array.isArray(row.hours)) return row.hours.map(h => String(h).replace(/–/g, '-'));
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
   ADMIN: owner create booking (FREE, NO NOTIFICATIONS)
   ========================= */

// helper: build hourly slots from "HH:MM" to "HH:MM" (end exclusive)
function buildHourlySlots(startHHMM, endHHMM) {
  const parse = (t) => {
    const m = String(t || '').match(/^(\d{2}):(\d{2})$/);
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return hh * 60 + mm;
  };
  const fmt = (min) => {
    const hh = String(Math.floor(min / 60)).padStart(2, '0');
    const mm = String(min % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  };

  const start = parse(startHHMM);
  const end = parse(endHHMM);
  if (start == null || end == null) return null;
  if (end <= start) return null;
  if ((end - start) % 60 !== 0) return null;

  const out = [];
  for (let t = start; t < end; t += 60) {
    out.push(`${fmt(t)}-${fmt(t + 60)}`);
  }
  return out;
}

app.post('/admin/owner-booking', authMiddleware, async (req, res) => {
  try {
    const { date, startTime, endTime } = req.body || {};

    // Basic validation
    const dateStr = String(date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ message: 'Neplatné datum. Použij YYYY-MM-DD.' });
    }

    const hoursArr = buildHourlySlots(String(startTime || ''), String(endTime || ''));
    if (!hoursArr || hoursArr.length === 0) {
      return res.status(400).json({ message: 'Použij startTime/endTime (např. startTime=20:00, endTime=23:00).' });
    }

   // no past bookings (compare in Prague local day)
   const todayPrg = todayPragueYYYYMMDD();
   if (dateStr < todayPrg) {
     return res.status(400).json({ message: 'Nelze rezervovat zpětně.' });
   }

    // normalize hour strings for checks
    const hoursNorm = hoursArr.map(h => String(h).trim().replace(/–/g, '-'));

    // conflict check:
    // Some existing bookings might contain en-dash "–" instead of "-", so check both variants.
    const conds = hoursNorm.map(() => `(JSON_CONTAINS(hours, ?, '$') OR JSON_CONTAINS(hours, ?, '$'))`).join(' OR ');
    const checkQuery = `
      SELECT id FROM bookings
      WHERE date = ?
      AND (
        payment_status = 'paid'
        OR (payment_status = 'pending' AND (expires_at IS NULL OR expires_at >= NOW()))
      )
      AND (${conds})
      LIMIT 1
    `;

    const params = [dateStr];
    hoursNorm.forEach(hHy => {
      const hEn = hHy.replace(/-/g, '–');
      params.push(JSON.stringify(hHy));
      params.push(JSON.stringify(hEn));
    });

    db.query(checkQuery, params, (selErr, rows) => {
      if (selErr) {
        console.error('❌ owner-booking conflict SELECT error:', selErr);
        return res.status(500).json({ message: 'DB error' });
      }
      if (rows && rows.length > 0) {
        return res.status(409).json({ message: 'Termín je již rezervovaný.' });
      }

      // Insert "paid" owner booking, no notifications, no GoPay fields
      const insertQuery = `
        INSERT INTO bookings
          (date, hours, name, email, phone, amount_czk, currency, payment_status)
        VALUES
          (?, ?, ?, ?, ?, ?, 'CZK', 'paid')
      `;

      db.query(
        insertQuery,
        [
          dateStr,
          JSON.stringify(hoursNorm),
          'Owner',              // placeholder
          'owner@local',        // placeholder
          '+000000000000',      // placeholder (E.164-ish)
          0
        ],
        (insErr, result) => {
          if (insErr) {
            console.error('❌ owner-booking INSERT error:', insErr);
            return res.status(500).json({ message: 'Chyba při ukládání' });
          }
          return res.json({
            ok: true,
            booking_id: result.insertId,
            date: dateStr,
            hours: hoursNorm
          });
        }
      );
    });
  } catch (e) {
    console.error('❌ owner-booking error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
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

app.post('/admin/sms/preview', authMiddleware, (req, res) => {
  const { name, date, hours, accessCode } = req.body || {};
  const smsText = buildPaidSmsText({
    name,
    date,
    hours,
    accessCode: accessCode || '3141',
  });

  res.json({
    smsText,
    length: smsText.length,
    segmentsApprox: smsText.length <= 160 ? 1 : (smsText.length <= 306 ? 2 : 3),
  });
});

app.post('/admin/sms/send-test', authMiddleware, async (req, res) => {
  try {
    const { to, name, date, hours, accessCode } = req.body || {};

    if (!to) {
      return res.status(400).json({ message: 'Chybi "to" (telefon v E.164, napr. +420777123456).' });
    }

    const toE164 = normalizeAndValidatePhoneE164(to);
    if (!toE164) {
      return res.status(400).json({ message: 'Neplatne "to". Pouzij E.164, napr. +420777123456.' });
    }

    const code = accessCode || (await getAccessCode());

    const smsText = buildPaidSmsText({
      name: name || 'Test User',
      date: date || new Date(),
      hours: Array.isArray(hours) && hours.length ? hours : ['20:00-21:00', '21:00-22:00'],
      accessCode: code,
    });

    const smsRes = await sendSms({ to: toE164, body: smsText });

    return res.json({
      ok: true,
      to: toE164,
      body: smsText,
      sid: smsRes.sid,
      status: smsRes.status,
    });
  } catch (e) {
    console.error('❌ /admin/sms/send-test error:', e);
    return res.status(500).json({ ok: false, message: 'SMS send failed', error: String(e?.message || e) });
  }
});

/* =========================
   GOPAY: webhook (no auto-cancel on non-PAID)
   ========================= */
app.all('/gopay/webhook',
  express.urlencoded({ extended: false }),
  express.json(),
  async (req, res) => {
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
          `UPDATE bookings
           SET payment_status='paid', payment_paid_at=NOW(), payment_error=NULL
           WHERE id=? AND payment_status!='paid'`,
          [row.id],
          async (upErr, result) => {
            if (upErr) {
              console.error('❌ MySQL UPDATE error:', upErr);
              return res.status(200).json({ ok: true, note: 'db error' });
            }

            if (!result || result.affectedRows !== 1) {
              return res.status(200).json({ ok: true, state: 'PAID', note: 'already processed' });
            }
            try {
              const accessCode = await getAccessCode();
              await sendConfirmationEmail({
                name: row.name, email: row.email, date: row.date, hours, phone: row.phone,
                accessCode
              });
            } catch (e) { console.error('❌ sendConfirmationEmail error:', e); }
            // --- SMS (demo) - send only once ---
            try {
              const lock = await reserveSmsSend(row.id);
              if (!lock.ok) {
                console.log('📩 SMS skipped (already sent or reserved) for booking id', row.id);
              } else {
                const accessCode = await getAccessCode();

                // 1) SMS pro uživatele (stejná jako doteď)
                const smsTextUser = buildPaidSmsText({
                  name: row.name,
                  date: row.date,
                  hours,
                  accessCode,
                });

                const smsResUser = await sendSms({
                  to: row.phone || '',
                  body: smsTextUser,
                });

                // 2) SMS pro recepci (kratká)
                try {
                  const receptionRaw = process.env.RECEPTION_PHONE_E164 || '+420705926425';
                  const receptionTo = normalizeAndValidatePhoneE164(receptionRaw);

                  if (!receptionTo) {
                    console.error('❌ Invalid RECEPTION_PHONE_E164:', receptionRaw, 'booking id=', row.id);
                  } else {
                    const smsTextReception = buildReceptionSmsText({
                      name: row.name,
                      date: row.date,
                      hours,
                    });

                    const smsResReception = await sendSms({
                      to: receptionTo,
                      body: smsTextReception,
                    });

                    console.log('✅ Reception SMS sent for booking id', row.id, 'sid=', smsResReception.sid, 'status=', smsResReception.status);
                  }
                } catch (e) {
                  console.error('❌ Reception SMS failed:', e?.message || e, 'booking id=', row.id);
                }

                // DB status držíme podle uživatelské SMS
                db.query(
                  `UPDATE bookings SET sms_status='sent', sms_sent_at=NOW(), sms_message_sid=?, sms_error=NULL WHERE id=?`,
                  [smsResUser.sid || 'demo', row.id],
                  () => {}
                );

                console.log('✅ User SMS sent for booking id', row.id, 'sid=', smsResUser.sid, 'status=', smsResUser.status);
              }
            } catch (e) {
              console.error('❌ SMS failed:', e?.message || e);
              db.query(
                `UPDATE bookings SET sms_status='failed', sms_error=? WHERE id=?`,
                [String(e?.message || e), row.id],
                () => {}
              );
            }
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
   MANUAL CONFIRM ENDPOINT (GoPay-compliant)
   ========================= */
app.get('/confirm/:id', async (req, res) => {
  const bookingId = req.params.id;

  db.query('SELECT * FROM bookings WHERE id = ?', [bookingId], async (err, rows) => {
    if (err) return res.status(500).json({ message: 'DB error' });
    if (!rows || rows.length === 0) return res.status(404).json({ message: 'Booking not found' });

    const row = rows[0];
    if (!row.gopay_payment_id) return res.status(400).json({ message: 'No payment linked' });

    try {
      const status = await gopayGetPayment(row.gopay_payment_id);
      const state = status?.state?.id || status?.state;

      if (state === 'PAID') {
        db.query(
          `UPDATE bookings
           SET payment_status='paid', payment_paid_at=NOW(), payment_error=NULL
           WHERE id=? AND payment_status!='paid'`,
          [row.id],
          async (upErr, result) => {
            if (upErr) {
              console.error('❌ confirm UPDATE error:', upErr);
              return res.status(500).json({ message: 'DB error' });
            }

            if (!result || result.affectedRows !== 1) {
              // už bylo paid, tak nic znovu neposílej
              return res.json({ ok: true, state: 'PAID', note: 'already processed' });
            }

            try {
              const hours = safeParseHours(row.hours);
              const accessCode = await getAccessCode();
              await sendConfirmationEmail({
                name: row.name,
                email: row.email,
                date: row.date,
                hours,
                phone: row.phone,
                accessCode
              });
            } catch (e) {
              console.error('❌ confirm sendConfirmationEmail error:', e);
            }

            return res.json({ ok: true, state: 'PAID' });
          }
        );
      } else {
        return res.json({ ok: true, state });
      }
    } catch (e) {
      console.error('❌ confirm error:', e);
      return res.status(500).json({ message: 'Error checking payment', error: e.message });
    }
  });
});

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