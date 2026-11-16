const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const pool = require("../db");

const router = express.Router();

// ---------- Profile picture upload ----------
const storage = multer.diskStorage({
  destination: path.join(__dirname, "..", "uploads"),
  filename: (req, file, cb) => {
    const exts = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
    cb(null, "profile-" + Date.now() + "-" + Math.round(Math.random() * 1e9) + (exts[file.mimetype] || ".jpg"));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    cb(allowed.includes(file.mimetype) ? null : new Error("INVALID_IMAGE"), allowed.includes(file.mimetype));
  }
});

function handleUpload(req, res, next) {
  upload.single("profilePicture")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ message: "Image must be 2MB or smaller." });
      }
      return res.status(400).json({ message: "Only JPG, PNG or WEBP images are allowed." });
    }
    next();
  });
}

function removeFile(file) {
  if (file && file.path) fs.unlink(file.path, () => {});
}

// ---------- Helpers ----------
const s = (value) => String(value ?? "").trim();

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function getAge(dateString) {
  const birth = new Date(dateString);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

function isStrongEnough(password) {
  return password.length >= 8 && password.length <= 72 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// =====================================================
// POST /api/auth/register
// =====================================================
router.post("/register", handleUpload, async (req, res) => {
  const file = req.file;
  const fail = (status, message) => {
    removeFile(file);
    return res.status(status).json({ message });
  };

  try {
    const b = req.body;
    const role = s(b.role);
    const firstName = s(b.firstName);
    const lastName = s(b.lastName);
    const email = s(b.email).toLowerCase();
    const birthday = s(b.birthday);
    const gender = s(b.gender);
    const country = s(b.country);
    const city = s(b.city);
    const address = s(b.address);
    const phone = s(b.phone);
    const password = String(b.password ?? "");

    if (!["producer", "consumer"].includes(role)) return fail(400, "Choose Producer or Consumer.");
    if (firstName.length < 2 || firstName.length > 50) return fail(400, "Enter a valid first name.");
    if (lastName.length < 2 || lastName.length > 50) return fail(400, "Enter a valid last name.");
    if (!isEmail(email) || email.length > 120) return fail(400, "Enter a valid email address.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday) || isNaN(new Date(birthday))) return fail(400, "Enter a valid birthday.");
    if (getAge(birthday) < 18) return fail(400, "You must be at least 18 years old.");
    if (!["male", "female", "other"].includes(gender)) return fail(400, "Select your gender.");
    if (country.length < 2 || country.length > 60) return fail(400, "Select your country.");
    if (city.length < 2 || city.length > 60) return fail(400, "Enter your city.");
    if (address.length < 5 || address.length > 200) return fail(400, "Enter your address.");
    if (!/^\+\d{8,15}$/.test(phone)) return fail(400, "Enter a valid phone number.");
    if (!isStrongEnough(password)) return fail(400, "Password must be 8+ characters with letters and numbers.");

    const passwordHash = await bcrypt.hash(password, 10);
    const picture = file ? "/uploads/" + file.filename : null;

    await pool.query(
      `INSERT INTO users
        (role, first_name, last_name, email, password_hash, phone, birthday, gender, country, city, address, profile_picture)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [role, firstName, lastName, email, passwordHash, phone, birthday, gender, country, city, address, picture]
    );

    res.status(201).json({ message: "Account created successfully." });
  } catch (err) {
    if (err.code === "23505") return fail(409, "This email is already registered.");
    console.error("Register error:", err.message);
    fail(500, "Server error. Please try again.");
  }
});

// =====================================================
// POST /api/auth/login
// =====================================================
router.post("/login", async (req, res) => {
  try {
    const email = s(req.body.email).toLowerCase();
    const password = String(req.body.password ?? "");

    if (!isEmail(email) || !password) {
      return res.status(400).json({ message: "Enter your email and password." });
    }

    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = result.rows[0];

    const passwordOk = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!user || !passwordOk) {
      return res.status(401).json({ message: "Incorrect email or password." });
    }
    if (!user.is_active) {
      return res.status(403).json({ message: "This account is disabled." });
    }

    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });

    res.json({
      token,
      user: {
        id: user.id,
        role: user.role,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        profilePicture: user.profile_picture
      }
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// =====================================================
// POST /api/auth/forgot-password
// =====================================================
router.post("/forgot-password", async (req, res) => {
  const reply = () => res.json({ message: "If an account exists for this email, a reset link has been sent." });

  try {
    const email = s(req.body.email).toLowerCase();
    if (!isEmail(email)) return res.status(400).json({ message: "Enter a valid email address." });

    const result = await pool.query("SELECT id FROM users WHERE email = $1 AND is_active = TRUE", [email]);
    const user = result.rows[0];

    if (user) {
      const token = crypto.randomBytes(32).toString("hex");

      await pool.query("DELETE FROM password_resets WHERE user_id = $1", [user.id]);
      await pool.query(
        "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')",
        [user.id, hashToken(token)]
      );

      const link = `http://localhost:${process.env.PORT || 3000}/html/reset-password.html?token=${token}`;

      // Real email sending will be added later. For now, the link is printed here:
      console.log("\n=== PASSWORD RESET LINK (valid 1 hour) ===");
      console.log("For:", email);
      console.log(link);
      console.log("==========================================\n");
    }

    reply();
  } catch (err) {
    console.error("Forgot password error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// =====================================================
// POST /api/auth/reset-password
// =====================================================
router.post("/reset-password", async (req, res) => {
  const token = s(req.body.token);
  const password = String(req.body.password ?? "");

  if (!token) return res.status(400).json({ message: "This reset link is invalid." });
  if (!isStrongEnough(password)) {
    return res.status(400).json({ message: "Password must be 8+ characters with letters and numbers." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const found = await client.query(
      `SELECT user_id FROM password_resets
       WHERE token_hash = $1 AND used = FALSE AND expires_at > NOW()
       FOR UPDATE`,
      [hashToken(token)]
    );

    if (found.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "This link is invalid or has expired." });
    }

    const userId = found.rows[0].user_id;
    const passwordHash = await bcrypt.hash(password, 10);

    await client.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, userId]);
    await client.query("UPDATE password_resets SET used = TRUE WHERE user_id = $1", [userId]);
    await client.query("COMMIT");

    res.json({ message: "Password changed successfully." });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Reset password error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  } finally {
    client.release();
  }
});

module.exports = router;
