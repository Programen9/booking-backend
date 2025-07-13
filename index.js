require('./db');

const authMiddleware = require('./authMiddleware');

const express = require('express');
const app = express();
const PORT = 3001;

const cors = require('cors');

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    
    const allowed = [
      'http://localhost:5173',
      'https://topzkusebny-booking-frontend.netlify.app'
    ];
    
    if (allowed.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error('CORS not allowed from this origin'), false);
    }
  },
  credentials: true
}));

app.use(express.json());

const db = require('./db');

function safeParseHours(val) {
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return [];
    }
  }
  return Array.isArray(val) ? val : [];
}

app.post('/book', (req, res) => {
  const { date, hours, name, email, phone } = req.body;

  // Basic presence check
  if (!date || !hours || !name || !email || !phone) {
    return res.status(400).json({ message: 'Chybí některá z povinných položek.' });
  }

  // Validate date
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ message: 'Neplatný formát data.' });
  }

  // Validate hours as array of strings/numbers (e.g., ['14:00', '15:00'])
  if (!Array.isArray(hours) || hours.some(h => typeof h !== 'string' && typeof h !== 'number')) {
    return res.status(400).json({ message: 'Neplatný formát hodin.' });
  }

  // Name should contain at least 2 words
  if (typeof name !== 'string' || !/^\s*\S+\s+\S+/.test(name)) {
    return res.status(400).json({ message: 'Zadejte své jméno a příjmení.' });
  }

  // Basic email check
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: 'Zadejte platný email.' });
  }

  // Phone number check (digits, spaces, optional +)
  if (typeof phone !== 'string' || !/^(\+)?[0-9 ]{9,16}$/.test(phone)) {
    return res.status(400).json({ message: 'Zadejte platné telefonní číslo.' });
  }

  const bookingDate = new Date(date);
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  if (bookingDate < now) {
    console.log('❌ Booking is in the past:', req.body);
    return res.status(400).json({ message: 'Nelze rezervovat zpětně.' });
  }

  // ...continue with DB query as you already have

  // ✅ reCAPTCHA ověření
  const token = newBooking.token;
  if (!token) {
    return res.status(400).json({ message: 'Chybí reCAPTCHA token' });
  }

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

  // 🚫 Zákaz rezervace zpětně
  const bookingDate = new Date(newBooking.date);
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  if (bookingDate < now) {
    console.log('❌ Booking is in the past:', newBooking);
    return res.status(400).json({ message: 'Nelze rezervovat zpětně.' });
  }

  // 🔍 Kontrola kolize v MySQL
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

    if (results.length > 0) {
      console.log('❌ Booking conflict:', newBooking);
      return res.status(409).json({ message: 'Termín je již rezervovaný.' });
    }

    // 💾 Uložení do DB
    const insertQuery = `
      INSERT INTO bookings (date, hours, name, email, phone)
      VALUES (?, ?, ?, ?, ?)
    `;
    db.query(insertQuery, [
      newBooking.date,
      JSON.stringify(newBooking.hours),
      newBooking.name,
      newBooking.email,
      newBooking.phone
    ], (err2) => {
      if (err2) {
        console.error('❌ MySQL INSERT error:', err2);
        return res.status(500).json({ message: 'Chyba při ukládání' });
      }

      console.log('✅ Booking saved to MySQL:', newBooking);
      res.status(200).json({ message: 'Booking uložen do MySQL' });
    });
  });
});

app.get('/bookings/:date', (req, res) => {
  const date = req.params.date;
  console.log('📆 Incoming date string:', date);

  db.query(
    'SELECT date, hours FROM bookings',
    [],
    (err, results) => {
      if (err) {
        console.error('❌ MySQL query error:', err);
        return res.status(500).json({ message: 'Server error' });
      }

      console.log('🧾 Raw results from DB:', results);

      const matching = results.filter(row => {
        const rowDate = new Date(row.date).toISOString().split('T')[0]; // 'YYYY-MM-DD'
        return rowDate === date;
      });

      const allHours = matching.flatMap((row) => {
        if (typeof row.hours === 'string') {
          try {
            return JSON.parse(row.hours);
          } catch {
            return [];
          }
        } else if (Array.isArray(row.hours)) {
          return row.hours;
        } else {
          return [];
        }
      });

      res.json({ hours: allHours });
    }
  );
});

app.get('/all-bookings', authMiddleware, (req, res) => {
  db.query('SELECT * FROM bookings', (err, results) => {
    if (err) {
      console.error('❌ MySQL query error:', err);
      return res.status(500).json({ message: 'Server error' });
    }

    // Parse hours JSON
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

app.delete('/bookings/:id', authMiddleware, (req, res) => {
  const bookingId = req.params.id;

  db.query('DELETE FROM bookings WHERE id = ?', [bookingId], (err, result) => {
    if (err) {
      console.error('❌ MySQL DELETE error:', err);
      return res.status(500).json({ message: 'Chyba serveru při mazání' });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Rezervace nenalezena' });
    }

    console.log(`🗑️ Booking with ID ${bookingId} deleted`);
    res.status(200).json({ message: 'Rezervace úspěšně smazána' });
  });
});

app.listen(PORT, () => {
  console.log(`✅ Backend is running. Local: http://localhost:${PORT} or hosted on Railway.`);
});