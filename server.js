const express = require("express");
const app = express();
const PORT = process.env.PORT || 3001;

// Manually set CORS headers on every response
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: "10mb" }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const ODDS_KEY = "300321be5cb6ceb939c23cb0c40a04da";

app.get("/", (req, res) => {
  res.json({ status: "OddsIQ backend running" });
});

app.post("/api/analyze", async (req, res) => {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.listen(PORT, () => console.log("OddsIQ backend on port " + PORT));
