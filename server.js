// TikTok → (server downloads AUDIO bytes) → upload to AssemblyAI → transcript
// No cookies required. Mobile UA + TikTok extractor args. Better AAI options.
// Includes richer analysis metrics.

import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import { spawn } from "child_process";
import fetch from "node-fetch";

const PORT = process.env.PORT || 3000;
const AAI_KEY = process.env.AAI_KEY;               // REQUIRED
const YTDLP_PROXY = process.env.YTDLP_PROXY || ""; // OPTIONAL (e.g., http://eu-proxy:3128)

const app = express();
app.use(cors());
app.use(express.json());

// ---------------- DB ----------------
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

// ---------------- Analysis ----------------
function analyzeTranscript(txt = "") {
  const lower = txt.toLowerCase();

  // Tokenization-ish helpers
  const wordsArr = (txt.match(/\b[\p{L}\p{N}'-]+\b/gu) || []);
  const words = wordsArr.length;
  const sentencesArr = (txt.split(/[.!?]+[\s\n]+/).map(s => s.trim()).filter(Boolean));
  const sentences = Math.max(1, sentencesArr.length);
  const avgWordsPerSentence = +(words / sentences).toFixed(2);

  const numbersCount = (txt.match(/\b\d+(?:[.,]\d+)?\b/g) || []).length;
  const exclamationsCount = (txt.match(/!/g) || []).length;
  const questionsCount = (txt.match(/\?/g) || []).length;

  const powerWords =
    lower.match(/\b(shock|insane|secret|proof|hack|guarantee|science|doctor|study|instant|boost|breakthrough|viral|free|limited)\b/g) || [];
  const riskyClaims =
    lower.match(/\b(cure|guarantee|permanent|miracle|overnight|instantly|no\s*risk)\b/g) || [];
  const ctaLines = (txt.match(/^(.*?(link|buy|shop|tap|order|try|subscribe|follow|download|today|now).*)$/gim) || []);

  // Super lightweight sentiment (bag-of-words)
  const posWords = ["good","great","amazing","win","love","best","easy","success","benefit","fast","wow","wow!","save","safe"];
  const negWords = ["bad","worse","worst","hate","risk","scam","hard","problem","pain","danger","fail","loss"];
  let score = 0;
  for (const w of wordsArr.map(w => w.toLowerCase())) {
    if (posWords.includes(w)) score += 1;
    if (negWords.includes(w)) score -= 1;
  }
  const sentimentScore = words ? +(score / Math.sqrt(words)).toFixed(2) : 0;

  // Hook score
  const prehook = txt.split("\n")[0] || "";
  const hasHook = prehook.length > 0 && prehook.length <= 150;
  const hookScore =
    (powerWords.length > 0 ? 0.3 : 0) +
    (numbersCount > 0 ? 0.2 : 0) +
    (hasHook ? 0.3 : 0) +
    (words >= 30 && words <= 220 ? 0.2 : 0);

  const readingTimeSec = +(words / 150 * 60).toFixed(1); // 150 wpm

  return {
    metrics: {
      length_chars: txt.length,
      length_words: words,
      sentences,
      avg_words_per_sentence: avgWordsPerSentence,
      numbers_count: numbersCount,
      power_words: powerWords,
      risky_claims: riskyClaims,
      cta_lines: ctaLines,
      exclamations_count: exclamationsCount,
      questions_count: questionsCount,
      reading_time_sec: readingTimeSec,
      sentiment_score: sentimentScore
    },
    hook_score: +hookScore.toFixed(2),
    structure: {
      prehook,
      cta: ctaLines.slice(-1)[0] || "",
      has_risky_claims: riskyClaims.length > 0
    }
  };
}

// ---------------- TikTok helpers ----------------
function normalizeTikTokUrl(input) {
  try {
    const u = new URL(input);
    if (/tiktok\.com$/i.test(u.hostname) && /\/video\/\d+/.test(u.pathname)) return input;
    const id =
      u.searchParams.get("video_id") ||
      u.searchParams.get("item_id") ||
      (u.pathname.match(/\/video\/(\d+)/)?.[1]) ||
      (u.search.match(/[\?&](?:video_id|item_id)=(\d+)/)?.[1]);
    if (id) return `https://www.tiktok.com/video/${id}`;
  } catch {}
  return input;
}

// Download AUDIO bytes with yt-dlp (mobile UA, extractor args) to stdout
async function downloadAudioBytes(tiktokUrl) {
  const url = normalizeTikTokUrl(tiktokUrl);
  const args = [
    "--no-warnings",
    "--geo-bypass",
    "--no-check-certificate",
    "--referer", "https://www.tiktok.com/",
    "--user-agent",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
    "--extractor-args", "tiktok:app_info=android;download_api=tiktok",
    "-f", "bestaudio/best",
    "-o", "-",
    url
  ];
  if (YTDLP_PROXY) { args.unshift(YTDLP_PROXY); args.unshift("--proxy"); }

  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args);
    const chunks = [];
    let errText = "";

    child.stdout.on("data", d => chunks.push(d));
    child.stderr.on("data", d => (errText += d.toString()));
    child.on("close", code => {
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error(errText || `yt-dlp exited with code ${code}`));
    });
  });
}

// ---------------- AssemblyAI ----------------
async function aaiUpload(buffer) {
  if (!AAI_KEY) throw new Error("Missing AAI_KEY env");
  const resp = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: { Authorization: AAI_KEY },
    body: buffer
  });
  const text = await resp.text();
  try { const j = JSON.parse(text); return j.upload_url || j.url || text; }
  catch { return text; }
}

async function transcribeWithAAI(uploadUrl) {
  if (!AAI_KEY) throw new Error("Missing AAI_KEY env");

  const start = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: { Authorization: AAI_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      audio_url: uploadUrl,

      // Quality + readability
      punctuate: true,
      format_text: true,
      audio_boost: true,

      // Robust language handling
      language_detection: true,

      // Useful extras (keep off in UI unless you want to surface them)
      auto_highlights: true,
      entity_detection: true,
      iab_categories: false,
      speaker_labels: false
    })
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

// ---------------- Worker ----------------
async function processJob(id) {
  const get = db.prepare("SELECT * FROM jobs WHERE id=?");
  const upd = db.prepare("UPDATE jobs SET status=?, updated_at=?, error=?, transcript=?, analysis_json=? WHERE id=?");

  try {
    const row = get.get(id);
    if (!row || row.status !== "queued") return;

    upd.run("downloading", now(), null, null, null, id);
    const audio = await downloadAudioBytes(row.tiktok_url);

    upd.run("uploading", now(), null, null, null, id);
    const uploadUrl = await aaiUpload(audio);

    upd.run("transcribing", now(), null, null, null, id);
    const transcript = await transcribeWithAAI(uploadUrl);

    const analysis = analyzeTranscript(transcript);
    upd.run("completed", now(), null, transcript, JSON.stringify(analysis), id);
  } catch (err) {
    upd.run("error", now(), String(err), null, null, id);
  }
}

// ---------------- Routes ----------------
app.post("/jobs", (req, res) => {
  const { tiktokUrl } = req.body || {};
  if (!tiktokUrl) return res.status(400).json({ error: "tiktokUrl required" });
  const id = uid();
  db.prepare("INSERT INTO jobs (id,tiktok_url,status,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(id, tiktokUrl, "queued", now(), now());
  processJob(id);
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
app.get("/health", (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => console.log("server on :" + PORT));
