const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const fs = require('fs');
const path = require('path');
const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');

app.post('/book', (req, res) => {
  const newBooking = req.body;

  // Prevent past bookings
  const bookingDate = new Date(newBooking.date);
  const now = new Date();
  now.setHours(0, 0, 0, 0); // ignore time, just compare dates

  if (bookingDate < now) {
    console.log('❌ Booking is in the past:', newBooking);
    return res.status(400).json({ message: 'Nelze rezervovat zpětně.' });
  }

  // Load existing bookings
  let bookings = [];
  if (fs.existsSync(BOOKINGS_FILE)) {
    const raw = fs.readFileSync(BOOKINGS_FILE);
    bookings = JSON.parse(raw);
  }

  // Check for overlapping bookings
  const conflict = bookings.some((b) =>
    b.date === newBooking.date &&
    b.hours.some((hour) => newBooking.hours.includes(hour))
  );

  if (conflict) {
    console.log('❌ Booking conflict:', newBooking);
    return res.status(409).json({ message: 'Termín je již rezervovaný.' });
  }

  // If no conflict, save booking
  bookings.push(newBooking);

  // Save updated list back to file
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));

  console.log('Saved booking:', newBooking);
  res.status(200).json({ message: 'Booking saved to file' });
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