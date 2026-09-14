const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");

const convertRoutes = require("./routes/convert");

const app = express();
const PORT = process.env.PORT || 3000;

// ensure work dirs exist
for (const d of ["uploads", "converted"]) {
  const p = path.join(__dirname, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60, // 60 requests / 15min / IP — adjust for real traffic
  message: { error: "Too many requests, please try again in a bit." },
});
app.use("/api/convert", limiter, convertRoutes);

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (req, res) => res.json({ ok: true }));

// 404 handler — must come after static, before listen
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "..", "public", "404.html"));
});

app.listen(PORT, () => {
  console.log(`convert server running on http://localhost:${PORT}`);
});
