// index.js
require('./db');

const authMiddleware = require('./authMiddleware');
const sendConfirmationEmail = require('./mailer');           // default export (confirmation)
const { sendCancellationEmail } = require('./mailer');       // named export (cancellation)

const express = require('express');
const app = express();
app.set('trust proxy', 1); // behind Railway proxy (fixes express-rate-limit X-Forwarded-For warning)
const PORT = 3001;

const cors = require('cors');
const sanitizeHtml = require('sanitize-html');
const rateLimit = require('express-rate-limit');

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,     // 1 minute
  max: 10,                 // only for PUBLIC endpoints
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests from this IP. Please try again later.' },
});

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl/Postman) and your sites
    if (!origin) return callback(null, true);
    const allowed = [
      'http://localhost:5173',
      'https://topzkusebny-booking-frontend.netlify.app'
    ];
    if (allowed.includes(origin)) return callback(null, true);
    return callback(new Error('CORS not allowed from this origin'), false);
  },
  credentials: true
}));

app.use(express.json());

const db = require('./db');

function safeParseHours(val) {
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return []; }
  }
  return Array.isArray(val) ? val : [];
}

/* =========================
   PUBLIC ENDPOINTS (rate-limited)
   ========================= */

// make a booking (public form) – limit
app.post('/book', publicLimiter, async (req, res) => {
  const newBooking = req.body;
  // Sanitize user input to prevent XSS
  newBooking.name = sanitizeHtml(newBooking.name, { allowedTags: [], allowedAttributes: {} });
  newBooking.email = sanitizeHtml(newBooking.email, { allowedTags: [], allowedAttributes: {} });
  newBooking.phone = sanitizeHtml(newBooking.phone, { allowedTags: [], allowedAttributes: {} });

  // reCAPTCHA
  const token = newBooking.token;
  if (!token) return res.status(400).json({ message: 'Chybí reCAPTCHA token' });

  try {
    const recaptchaResponse = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: process.env.RECAPTCHA_SECRET_KEY,
        response: token,
      }),
    });
    const recaptchaData = await recaptchaResponse.json();
    if (!recaptchaData.success || recaptchaData.score < 0.5) {
      console.warn('❌ reCAPTCHA selhalo:', recaptchaData);
      return res.status(403).json({ message: 'Ověření reCAPTCHA selhalo.' });
    }
  } catch (error) {
    console.error('❌ Chyba při ověřování reCAPTCHA:', error);
    return res.status(500).json({ message: 'Chyba při ověřování reCAPTCHA.' });
  }

  // Block past dates
  const bookingDate = new Date(newBooking.date);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  if (bookingDate < now) return res.status(400).json({ message: 'Nelze rezervovat zpětně.' });

  // Collision check
  const checkQuery = `
    SELECT * FROM bookings 
    WHERE date = ? 
    AND (${newBooking.hours.map(() => `JSON_CONTAINS(hours, ?, '$')`).join(' OR ')})
  `;
  const params = [newBooking.date, ...newBooking.hours.map(h => JSON.stringify(h))];

  db.query(checkQuery, params, (err, results) => {
    if (err) {
      console.error('❌ MySQL SELECT error:', err);
      return res.status(500).json({ message: 'Chyba serveru' });
    }
    if (results.length > 0) return res.status(409).json({ message: 'Termín je již rezervovaný.' });

    const insertQuery = `INSERT INTO bookings (date, hours, name, email, phone) VALUES (?, ?, ?, ?, ?)`;
    db.query(insertQuery, [
      newBooking.date,
      JSON.stringify(newBooking.hours),
      newBooking.name,
      newBooking.email,
      newBooking.phone
    ], async (err2) => {
      if (err2) {
        console.error('❌ MySQL INSERT error:', err2);
        return res.status(500).json({ message: 'Chyba při ukládání' });
      }
      console.log('✅ Booking saved to MySQL:', newBooking);
      try { await sendConfirmationEmail(newBooking); } catch (e) {
        console.error('❌ Failed to send confirmation email:', e);
      }
      res.status(200).json({ message: 'Booking uložen do MySQL' });
    });
  });
});

// get booked hours for a given date (public) – limit
app.get('/bookings/:date', publicLimiter, (req, res) => {
  const date = req.params.date;
  db.query('SELECT date, hours FROM bookings', [], (err, results) => {
    if (err) {
      console.error('❌ MySQL query error:', err);
      return res.status(500).json({ message: 'Server error' });
    }
    const matching = results.filter(row => {
      const rowDate = new Date(row.date).toISOString().split('T')[0];
      return rowDate === date;
    });
    const allHours = matching.flatMap((row) => {
      if (typeof row.hours === 'string') { try { return JSON.parse(row.hours); } catch { return []; } }
      if (Array.isArray(row.hours)) return row.hours;
      return [];
    });
    res.json({ hours: allHours });
  });
});

/* =========================
   ADMIN ENDPOINTS (no rate limit)
   ========================= */

app.get('/all-bookings', authMiddleware, (req, res) => {
  db.query('SELECT * FROM bookings', (err, results) => {
    if (err) {
      console.error('❌ MySQL query error:', err);
      return res.status(500).json({ message: 'Server error' });
    }
    const bookings = results.map((row) => ({
      id: row.id,
      date: row.date,
      hours: safeParseHours(row.hours),
      name: row.name,
      email: row.email,
      phone: row.phone,
    }));
    res.json(bookings);
  });
});

// delete without email (kept for completeness; not used by UI anymore)
app.delete('/bookings/:id', authMiddleware, (req, res) => {
  const bookingId = req.params.id;
  db.query('DELETE FROM bookings WHERE id = ?', [bookingId], (err, result) => {
    if (err) {
      console.error('❌ MySQL DELETE error:', err);
      return res.status(500).json({ message: 'Chyba serveru při mazání' });
    }
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Rezervace nenalezena' });
    console.log(`🗑️ Booking with ID ${bookingId} deleted`);
    res.status(200).json({ message: 'Rezervace úspěšně smazána' });
  });
});

// cancel + email + delete (admin)
app.post('/bookings/:id/cancel', authMiddleware, (req, res) => {
  const bookingId = req.params.id;
  const { message } = req.body || {};

  db.query('SELECT * FROM bookings WHERE id = ?', [bookingId], async (selErr, results) => {
    if (selErr) {
      console.error('❌ MySQL SELECT error:', selErr);
      return res.status(500).json({ message: 'Chyba serveru' });
    }
    if (!results || results.length === 0) return res.status(404).json({ message: 'Rezervace nenalezena' });

    const row = results[0];
    const hours = (() => {
      if (Array.isArray(row.hours)) return row.hours;
      try { return JSON.parse(row.hours); } catch { return []; }
    })();

    const booking = { id: row.id, date: row.date, hours, name: row.name, email: row.email, phone: row.phone };

    try {
      console.log('✉️ Sending cancellation email for booking ID:', bookingId);
      await sendCancellationEmail(booking, message);
    } catch (e) {
      console.error('❌ Failed to send cancellation email:', e?.message || e);
    }

    db.query('DELETE FROM bookings WHERE id = ?', [bookingId], (delErr, result) => {
      if (delErr) {
        console.error('❌ MySQL DELETE error:', delErr);
        return res.status(500).json({ message: 'Chyba serveru při mazání' });
      }
      if (result.affectedRows === 0) return res.status(404).json({ message: 'Rezervace nenalezena' });
      console.log(`🗑️ Booking with ID ${bookingId} cancelled and deleted`);
      res.status(200).json({ message: 'Rezervace zrušena a email odeslán (pokud bylo možné).' });
    });
  });
});

app.listen(PORT, () => {
  console.log(`✅ Backend is running. Local: http://localhost:${PORT} or hosted on Railway.`);
});