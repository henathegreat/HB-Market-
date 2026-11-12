require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const pool = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

// Make sure the uploads folder exists (profile pictures, product images)
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the front end (the "HB Web" folder is one level above /server)
app.use(express.static(path.join(__dirname, "..")));
app.use("/uploads", express.static(uploadsDir));

// Test route: checks that the server and PostgreSQL are connected
app.get("/api/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() AS time");
    res.json({ status: "ok", database: "connected", time: result.rows[0].time });
  } catch (err) {
    res.status(500).json({ status: "error", database: "not connected", message: err.message });
  }
});

// Routes will be added in the next steps:
// app.use("/api/auth", require("./routes/auth"));

// Unknown API route
app.use("/api", (req, res) => {
  res.status(404).json({ message: "API route not found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "Server error" });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Register page: http://localhost:${PORT}/html/register.html`);
});
