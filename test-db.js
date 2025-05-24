const db = require('./db');

async function test() {
  try {
    const [rows] = await db.query('SELECT 1 + 1 AS result');
    console.log('DB Connected, test result:', rows[0].result);
  } catch (err) {
    console.error('DB Error:', err);
  }
}

test();