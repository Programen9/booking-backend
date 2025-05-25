require('./db');

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const fs = require('fs');
const path = require('path');
const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');

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
  const params = [newBooking.date, ...newBooking.hours.map(h => `"${h}"`)];

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

  let bookings = [];
  if (fs.existsSync(BOOKINGS_FILE)) {
    const raw = fs.readFileSync(BOOKINGS_FILE);
    bookings = JSON.parse(raw);
  }

  const matched = bookings.filter((b) => b.date === date);
  const hours = matched.flatMap((b) => b.hours);

  res.json({ hours });
});

app.get('/all-bookings', (req, res) => {
  let bookings = [];
  if (fs.existsSync(BOOKINGS_FILE)) {
    const raw = fs.readFileSync(BOOKINGS_FILE);
    bookings = JSON.parse(raw);
  }
  res.json(bookings);
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});