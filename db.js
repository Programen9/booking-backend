const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: 'md405.wedos.net',
  user: 'w343072_ow0qq3', // limited user
  password: 'WRgQ4RcV',
  database: 'd343072_ow0qq3',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

module.exports = pool;