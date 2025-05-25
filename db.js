const mysql = require('mysql2');

const pool = mysql.createPool({
  host: process.env.MYSQLHOST,        // ✅ Not 'localhost'
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT         // ✅ Don't hardcode 3306
});

connection.connect((err) => {
  if (err) {
    console.error('❌ Error connecting to MySQL:', err);
  } else {
    console.log('✅ Connected to MySQL database');
  }
});

module.exports = connection;