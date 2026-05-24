const express = require("express");
const fs = require("fs");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3001;

// Manual CORS headers
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "10mb" }));

const ODDS_KEY = "300321be5cb6ceb939c23cb0c40a04da";
const USERS_FILE = path.join("/tmp", "eliteodds_users.json");

// ── User helpers ──────────────────────────────
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    }
  } catch (e) {}
  return {};
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (e) {
    console.error("Error saving users:", e.message);
  }
}

// ── Health check ──────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "EliteOdds backend running" });
});

// ── Register ──────────────────────────────────
app.post("/api/auth/register", (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: "All fields required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  const users = loadUsers();
  if (users[email]) {
    return res.status(409).json({ error: "Email already registered" });
  }

  const user = {
    id: Date.now().toString(),
    name,
    email,
    password, // In production use bcrypt — keeping simple for now
    plan: "free",
    createdAt: new Date().toISOString(),
    savedProps: [],
    alerts: [],
  };

  users[email] = user;
  saveUsers(users);

  const { password: _, ...safeUser } = user;
  console.log(`New user registered: ${email}`);
  res.json({ user: safeUser });
});

// ── Login ─────────────────────────────────────
app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  const users = loadUsers();
  const user = users[email];

  if (!user) {
    return res.status(404).json({ error: "No account found with that email" });
  }
  if (user.password !== password) {
    return res.status(401).json({ error: "Incorrect password" });
  }

  const { password: _, ...safeUser } = user;
  console.log(`User logged in: ${email}`);
  res.json({ user: safeUser });
});

// ── Get user profile ──────────────────────────
app.get("/api/auth/user/:email", (req, res) => {
  const users = loadUsers();
  const user = users[req.params.email];
  if (!user) return res.status(404).json({ error: "User not found" });
  const { password: _, ...safeUser } = user;
  res.json({ user: safeUser });
});

// ── Save prop ─────────────────────────────────
app.post("/api/auth/save-prop", (req, res) => {
  const { email, propId } = req.body;
  const users = loadUsers();
  if (!users[email]) return res.status(404).json({ error: "User not found" });
  if (!users[email].savedProps.includes(propId)) {
    users[email].savedProps.push(propId);
    saveUsers(users);
  }
  res.json({ success: true, savedProps: users[email].savedProps });
});

// ── Odds API proxy ────────────────────────────
app.get("/api/odds/*", async (req, res) => {
  try {
    const path = req.params[0];
    const query = new URLSearchParams(req.query);
    query.set("apiKey", ODDS_KEY);
    const url = "https://api.the-odds-api.com/v4/" + path + "?" + query.toString();
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log("EliteOdds backend on port " + PORT));
