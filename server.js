const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
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

const ODDS_KEY = process.env.ODDS_KEY;
const STRIPE_SECRET = process.env.STRIPE_SECRET;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID;
const APP_URL = process.env.APP_URL || "https://resplendent-kitsune-13d57e.netlify.app";
const MONGODB_URI = process.env.MONGODB_URI;

// ── MongoDB Connection ────────────────────────
mongoose.connect(MONGODB_URI)
  .then(() => console.log("✓ Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// ── User Schema ───────────────────────────────
const userSchema = new mongoose.Schema({
  id: String,
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  plan: { type: String, default: "free" },
  createdAt: { type: String, default: () => new Date().toISOString() },
  savedProps: { type: Array, default: [] },
  alerts: { type: Array, default: [] },
  stripeCustomerId: { type: String, default: null },
  subscriptionId: { type: String, default: null },
});

const User = mongoose.models.User || mongoose.model("User", userSchema);

// ── Health ────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "EliteBetsAI backend running" }));

// ── Auth: Register ────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "All fields required" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  try {
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: "Email already registered" });

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({
      id: Date.now().toString(),
      name,
      email: email.toLowerCase(),
      password: hashed,
    });

    const { password: _, ...safeUser } = user.toObject();
    res.json({ user: safeUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// ── Auth: Login ───────────────────────────────
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ error: "No account found with that email" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Incorrect password" });

    const { password: _, ...safeUser } = user.toObject();
    res.json({ user: safeUser });
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
});

// ── Auth: Update profile ──────────────────────
app.post("/api/auth/update", async (req, res) => {
  const { email, name } = req.body;
  try {
    const user = await User.findOneAndUpdate(
      { email: email.toLowerCase() },
      { name },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Update failed" });
  }
});

// ── Stripe: Create checkout session ──────────
app.post("/api/stripe/create-checkout", async (req, res) => {
  const { email, userId } = req.body;
  if (!STRIPE_SECRET) return res.status(500).json({ error: "Stripe not configured" });

  try {
    const Stripe = require("stripe");
    const stripe = Stripe(STRIPE_SECRET);

    const user = await User.findOne({ email: email.toLowerCase() });
    let customerId = user?.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({ email, metadata: { userId } });
      customerId = customer.id;
      if (user) {
        user.stripeCustomerId = customerId;
        await user.save();
      }
    }

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

// ── Stripe: Customer portal ───────────────────
app.post("/api/stripe/portal", async (req, res) => {
  const { email } = req.body;
  if (!STRIPE_SECRET) return res.status(500).json({ error: "Stripe not configured" });

  try {
    const Stripe = require("stripe");
    const stripe = Stripe(STRIPE_SECRET);
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user?.stripeCustomerId) return res.status(404).json({ error: "No subscription found" });

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: APP_URL,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stripe: Webhook ───────────────────────────
app.post("/api/stripe/webhook", async (req, res) => {
  if (!STRIPE_SECRET) return res.sendStatus(200);

  try {
    const Stripe = require("stripe");
    const stripe = Stripe(STRIPE_SECRET);
    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const email = session.metadata?.email;
      if (email) {
        await User.findOneAndUpdate(
          { email: email.toLowerCase() },
          { plan: "pro", subscriptionId: session.subscription }
        );
        console.log(`✓ Upgraded to Pro: ${email}`);
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      await User.findOneAndUpdate(
        { subscriptionId: sub.id },
        { plan: "free", subscriptionId: null }
      );
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// ── Check subscription status ─────────────────
app.get("/api/auth/subscription/:email", async (req, res) => {
  try {
    const user = await User.findOne({ email: req.params.email.toLowerCase() });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ plan: user.plan, subscriptionId: user.subscriptionId });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch subscription" });
  }
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
