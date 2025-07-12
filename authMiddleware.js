function checkAdminPassword(req, res, next) {
  const providedPassword = req.headers['x-admin-password'];

  if (!providedPassword || providedPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  next();
}

module.exports = checkAdminPassword;