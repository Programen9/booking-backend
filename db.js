const mysql = require('mysql2');

const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: process.env.MYSQLPORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

pool.getConnection((err, connection) => {
  if (err) {
    console.error('❌ Failed to connect to MySQL:', err);
  } else {
    console.log('✅ MySQL pool is ready.');
    connection.release(); // return it immediately
  }
});

module.exports = pool;