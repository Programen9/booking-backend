require('./db');

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const db = require('./db');

app.post('/book', (req, res) => {
  const newBooking = req.body;

  // Prevent past bookings
  const bookingDate = new Date(newBooking.date);
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  if (bookingDate < now) {
    console.log('❌ Booking is in the past:', newBooking);
    return res.status(400).json({ message: 'Nelze rezervovat zpětně.' });
  }

  // Check for overlapping bookings in MySQL
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

    // Insert new booking
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

  db.query(
    'SELECT hours FROM bookings WHERE date = ?',
    [date],
    (err, results) => {
      if (err) {
        console.error('❌ MySQL query error:', err);
        return res.status(500).json({ message: 'Server error' });
      }

      const allHours = results.flatMap((row) => {
        try {
          return JSON.parse(row.hours) || [];
        } catch {
          return [];
        }
      });
      res.json({ hours: allHours });
    }
  );
});

app.get('/all-bookings', (req, res) => {
  db.query('SELECT * FROM bookings', (err, results) => {
    if (err) {
      console.error('❌ MySQL query error:', err);
      return res.status(500).json({ message: 'Server error' });
    }

    // Parse hours JSON
    const bookings = results.map((row) => ({
      id: row.id,
      date: row.date,
      hours: JSON.parse(row.hours),
      name: row.name,
      email: row.email,
      phone: row.phone,
    }));

    res.json(bookings);
  });
});

app.listen(PORT, () => {
  console.log(`✅ Backend is running. Local: http://localhost:${PORT} or hosted on Railway.`);
});