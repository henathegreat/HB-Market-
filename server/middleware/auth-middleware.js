const jwt = require("jsonwebtoken");
const pool = require("../db");

// Checks the login token AND that the account is still active.
// The role is read from the database, so role changes by the admin work immediately.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) return res.status(401).json({ message: "Please log in." });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ message: "Your session expired. Please log in again." });
  }

  try {
    const result = await pool.query("SELECT id, role, is_active FROM users WHERE id = $1", [payload.id]);
    const user = result.rows[0];

    if (!user || !user.is_active) {
      return res.status(401).json({ message: "This account is not active. Please contact the admin." });
    }

    req.user = { id: user.id, role: user.role };
    next();
  } catch (err) {
    console.error("Auth check error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
}

// Allows only certain roles, for example requireRole("admin")
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: "You do not have access to this." });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
