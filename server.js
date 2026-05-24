const express = require("express");
const fs = require("fs");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3001;

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Raw body for Stripe webhooks BEFORE json parser
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "10mb" }));

const ODDS_KEY = process.env.ODDS_KEY || "300321be5cb6ceb939c23cb0c40a04da";
const STRIPE_SECRET = process.env.STRIPE_SECRET; // sk_live_... or sk_test_...
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET; // whsec_...
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID; // price_...
const APP_URL = process.env.APP_URL || "https://resplendent-kitsune-13d57e.netlify.app";

const USERS_FILE = path.join("/tmp", "elitebetsai_users.json");

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {}
  return {};
}
function saveUsers(users) {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch (e) { console.error(e); }
}

// ── Health ────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "EliteBetsAI backend running" }));

// ── Auth ──────────────────────────────────────
app.post("/api/auth/register", (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "All fields required" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  const users = loadUsers();
  if (users[email]) return res.status(409).json({ error: "Email already registered" });
  const user = { id: Date.now().toString(), name, email, password, plan: "free", createdAt: new Date().toISOString(), savedProps: [], alerts: [], stripeCustomerId: null, subscriptionId: null };
  users[email] = user;
  saveUsers(users);
  const { password: _, ...safeUser } = user;
  res.json({ user: safeUser });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  const users = loadUsers();
  const user = users[email];
  if (!user) return res.status(404).json({ error: "No account found with that email" });
  if (user.password !== password) return res.status(401).json({ error: "Incorrect password" });
  const { password: _, ...safeUser } = user;
  res.json({ user: safeUser });
});

app.post("/api/auth/update", (req, res) => {
  const { email, name } = req.body;
  const users = loadUsers();
  if (!users[email]) return res.status(404).json({ error: "User not found" });
  users[email].name = name;
  saveUsers(users);
  res.json({ success: true });
});

// ── Stripe: Create checkout session ──────────
app.post("/api/stripe/create-checkout", async (req, res) => {
  const { email, userId } = req.body;
  if (!STRIPE_SECRET) return res.status(500).json({ error: "Stripe not configured" });

  try {
    const Stripe = require("stripe");
    const stripe = Stripe(STRIPE_SECRET);

    // Create or get customer
    const users = loadUsers();
    let customerId = users[email]?.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({ email, metadata: { userId } });
      customerId = customer.id;
      if (users[email]) {
        users[email].stripeCustomerId = customerId;
        saveUsers(users);
      }
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      mode: "subscription",
      success_url: `${APP_URL}?upgrade=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}?upgrade=cancelled`,
      metadata: { email, userId },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Stripe: Customer portal (manage subscription) ──
app.post("/api/stripe/portal", async (req, res) => {
  const { email } = req.body;
  if (!STRIPE_SECRET) return res.status(500).json({ error: "Stripe not configured" });

  try {
    const Stripe = require("stripe");
    const stripe = Stripe(STRIPE_SECRET);
    const users = loadUsers();
    const customerId = users[email]?.stripeCustomerId;
    if (!customerId) return res.status(404).json({ error: "No subscription found" });

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: APP_URL,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stripe: Webhook (handles payment events) ──
app.post("/api/stripe/webhook", async (req, res) => {
  if (!STRIPE_SECRET) return res.sendStatus(200);

  try {
    const Stripe = require("stripe");
    const stripe = Stripe(STRIPE_SECRET);
    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);

    const users = loadUsers();

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const email = session.metadata?.email;
      if (email && users[email]) {
        users[email].plan = "pro";
        users[email].subscriptionId = session.subscription;
        saveUsers(users);
        console.log(`✓ Upgraded to Pro: ${email}`);
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      // Find user by subscription ID
      const user = Object.values(users).find((u) => u.subscriptionId === sub.id);
      if (user) {
        users[user.email].plan = "free";
        users[user.email].subscriptionId = null;
        saveUsers(users);
        console.log(`✓ Downgraded to Free: ${user.email}`);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// ── Check subscription status ─────────────────
app.get("/api/auth/subscription/:email", (req, res) => {
  const users = loadUsers();
  const user = users[req.params.email];
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ plan: user.plan, subscriptionId: user.subscriptionId });
});

// ── Odds API proxy ────────────────────────────
app.get("/api/odds/*", async (req, res) => {
  try {
    const oddsPath = req.params[0];
    const query = new URLSearchParams(req.query);
    query.set("apiKey", ODDS_KEY);
    const url = "https://api.the-odds-api.com/v4/" + oddsPath + "?" + query.toString();
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log("EliteBetsAI backend on port " + PORT));
