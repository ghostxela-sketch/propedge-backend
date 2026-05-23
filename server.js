import express from "express";
import cors from "cors";

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10mb" }));

const ANTHROPIC_KEY = "sk-ant-api03-Q_wtHo6hebcezLX6uvhyQ2jR5E2RQp4p-XzrYbWxJhycpcWZ1Jdf1sX_LbhEqJgFLb0LTDBQgFwLeXmpenplYA-qaXRlQAA";
const ODDS_KEY = "300321be5cb6ceb939c23cb0c40a04da";
const PORT = process.env.PORT || 3001;

// ── Health check ──────────────────────────────
app.get("/", (req, res) => res.json({ status: "PropEdge backend running ✓" }));

// ── Claude AI proxy ───────────────────────────
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
    console.error("Anthropic error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Odds API proxy ────────────────────────────
app.get("/api/odds/*", async (req, res) => {
  try {
    const path = req.params[0];
    const query = new URLSearchParams(req.query);
    query.set("apiKey", ODDS_KEY);
    const url = `https://api.the-odds-api.com/v4/${path}?${query}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Odds API error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`✓ PropEdge backend on port ${PORT}`));
