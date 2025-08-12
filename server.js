// TikTok Analyzer Backend (full file)
// - Accepts TikTok link -> resolves media via yt-dlp (mobile UA + extractor args)
// - Transcribes via AssemblyAI
// - Runs quick heuristic analysis
// - Stores jobs + scripts in SQLite (better-sqlite3)
// Endpoints:
//   POST /jobs { tiktokUrl } -> { id, status }
//   GET  /jobs/:id           -> { status, transcript, analysis, ... }
//   POST /scripts            -> { id }
//   GET  /scripts            -> list saved

import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import { execFile } from "child_process";
import fetch from "node-fetch";
import { promisify } from "util";

const exec = promisify(execFile);
const AAI_KEY = process.env.AAI_KEY; // <- set this in Render Environment
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

// ---------- DB ----------
const db = new Database("data.db");
db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  tiktok_url TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT,
  transcript TEXT,
  analysis_json TEXT
);
CREATE TABLE IF NOT EXISTS scripts (
  id TEXT PRIMARY KEY,
  title TEXT,
  source_url TEXT,
  transcript TEXT,
  analysis_json TEXT,
  created_at TEXT NOT NULL
);
`);

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const now = () => new Date().toISOString();

// ---------- Analysis ----------
function analyzeTranscript(txt) {
  const lower = (txt || "").toLowerCase();
  const metrics = {
    length_chars: txt.length,
    length_words: (txt.match(/\b\w+\b/g) || []).length,
    has_numbers: /\d/.test(lower),
    power_words:
      lower.match(/\b(shock|insane|secret|proof|hack|guarantee|science|doctor|study)\b/g) || [],
    risky_claims:
      lower.match(/\b(cure|guarantee|instant|permanent|miracle)\b/g) || [],
    cta_lines: (txt.match(/(link|buy|shop|tap|order|try|today|now)[^\n]*$/gim) || []),
  };
  const hasHook = /^[^\n]{1,150}/.test(txt);
  const hookScore =
    (metrics.power_words.length > 0 ? 0.3 : 0) +
    (metrics.has_numbers ? 0.2 : 0) +
    (hasHook ? 0.3 : 0) +
    (metrics.length_words >= 30 && metrics.length_words <= 220 ? 0.2 : 0);

  const structure = {
    prehook: txt.split("\n")[0] || "",
    cta: metrics.cta_lines.slice(-1)[0] || "",
    has_risky_claims: metrics.risky_claims.length > 0,
  };
  return { metrics, hook_score: +hookScore.toFixed(2), structure };
}

// ---------- TikTok resolver (yt-dlp with mobile UA + extractor args) ----------
async function resolveDirectMedia(tiktokUrl) {
  const common = [
    "--no-warnings",
    "--geo-bypass",
    "--no-check-certificate",
    "--referer", "https://www.tiktok.com/",
    "--user-agent",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1"
  ];

  // 1) Mobile API path (more reliable)
  let args = [
    ...common,
    "--extractor-args", "tiktok:app_info=android;download_api=tiktok",
    "-g", tiktokUrl
  ];
  try {
    const { stdout } = await exec("yt-dlp", args);
    const url = stdout.trim().split("\n").pop();
    if (url) return url;
  } catch (e) {
    console.warn("yt-dlp mobile path failed:", e?.stderr || e?.message || e);
  }

  // 2) Generic with headers
  args = [ ...common, "-g", tiktokUrl ];
  try {
    const { stdout } = await exec("yt-dlp", args);
    const url = stdout.trim().split("\n").pop();
    if (url) return url;
  } catch (e) {
    console.warn("yt-dlp generic failed:", e?.stderr || e?.message || e);
  }

  // 3) Best audio only (smaller for transcription)
  args = [ ...common, "-g", "-f", "bestaudio/best", tiktokUrl ];
  const { stdout } = await exec("yt-dlp", args); // let error bubble here
  const url = stdout.trim().split("\n").pop();
  if (!url) throw new Error("Could not resolve TikTok media URL");
  return url;
}

// ---------- AssemblyAI ----------
async function transcribeWithAAI(mediaUrl) {
  if (!AAI_KEY) throw new Error("Missing AAI_KEY env");
  const start = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: { Authorization: AAI_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ audio_url: mediaUrl }),
  }).then(r => r.json());

  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const s = await fetch(`https://api.assemblyai.com/v2/transcript/${start.id}`, {
      headers: { Authorization: AAI_KEY }
    }).then(r => r.json());
    if (s.status === "completed") return s.text || "";
    if (s.status === "error") throw new Error(s.error || "AAI error");
  }
  throw new Error("AAI timeout");
}

// ---------- Worker ----------
async function processJob(id) {
  const get = db.prepare("SELECT * FROM jobs WHERE id=?");
  const upd = db.prepare("UPDATE jobs SET status=?, updated_at=?, error=?, transcript=?, analysis_json=? WHERE id=?");

  try {
    const row = get.get(id);
    if (!row || row.status !== "queued") return;

    upd.run("resolving", now(), null, null, null, id);
    const mediaUrl = await resolveDirectMedia(row.tiktok_url);

    upd.run("transcribing", now(), null, null, null, id);
    const transcript = await transcribeWithAAI(mediaUrl);

    const analysis = analyzeTranscript(transcript);
    upd.run("completed", now(), null, transcript, JSON.stringify(analysis), id);
  } catch (err) {
    upd.run("error", now(), String(err), null, null, id);
  }
}

// ---------- Routes ----------
app.post("/jobs", (req, res) => {
  const { tiktokUrl } = req.body || {};
  if (!tiktokUrl) return res.status(400).json({ error: "tiktokUrl required" });
  const id = uid();
  db.prepare("INSERT INTO jobs (id, tiktok_url, status, created_at, updated_at) VALUES (?,?,?,?,?)")
    .run(id, tiktokUrl, "queued", now(), now());
  processJob(id); // fire-and-forget
  res.json({ id, status: "queued" });
});

app.get("/jobs/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json({
    id: row.id,
    tiktokUrl: row.tiktok_url,
    status: row.status,
    error: row.error,
    transcript: row.transcript,
    analysis: row.analysis_json ? JSON.parse(row.analysis_json) : null,
    updatedAt: row.updated_at
  });
});

app.post("/scripts", (req, res) => {
  const { title, sourceUrl, transcript, analysis } = req.body || {};
  if (!transcript) return res.status(400).json({ error: "transcript required" });
  const id = uid();
  db.prepare("INSERT INTO scripts (id,title,source_url,transcript,analysis_json,created_at) VALUES (?,?,?,?,?,?)")
    .run(id, title || "Untitled", sourceUrl || "", transcript, JSON.stringify(analysis || {}), now());
  res.json({ id });
});

app.get("/scripts", (req, res) => {
  const rows = db.prepare("SELECT * FROM scripts ORDER BY created_at DESC LIMIT 200").all();
  res.json(rows.map(r => ({
    id: r.id,
    title: r.title,
    sourceUrl: r.source_url,
    transcript: r.transcript,
    analysis: r.analysis_json ? JSON.parse(r.analysis_json) : null,
    createdAt: r.created_at
  })));
});

app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, () => console.log("server on :" + PORT));
