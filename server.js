const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();

// CORS + JSON body
app.use(cors({ origin: "*" }));
app.use(express.json());

// Create HTTP server + Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// In-memory storage (MVP)
const sessions = {};

// Root route for quick test
app.get("/", (req, res) => {
  res.send("DACUM Backend OK");
});

/**
 * =========================
 * FASA 1: CARDS API (MVP)
 * =========================
 */
app.get("/cards/:session", (req, res) => {
  const session = req.params.session;
  res.json(sessions[session] || []);
});

app.post("/cards/:session", (req, res) => {
  const session = req.params.session;
  const { name, activity } = req.body || {};

  if (!name || !activity) {
    return res.status(400).json({ success: false, error: "name & activity required" });
  }

  if (!sessions[session]) sessions[session] = [];

  const card = {
    id: Date.now(),
    name: String(name).trim(),
    activity: String(activity).trim(),
    time: new Date().toISOString()
  };

  sessions[session].push(card);
  io.to(session).emit("new-card", card);

  return res.json({ success: true, card });
});

// Optional compatibility endpoint
app.post("/submit", (req, res) => {
  const { session, name, activity } = req.body || {};

  if (!session || !name || !activity) {
    return res.status(400).json({
      success: false,
      error: "session, name & activity required"
    });
  }

  if (!sessions[session]) sessions[session] = [];

  const card = {
    id: Date.now(),
    name: String(name).trim(),
    activity: String(activity).trim(),
    time: new Date().toISOString()
  };

  sessions[session].push(card);
  io.to(session).emit("new-card", card);

  res.json({ success: true, card });
});

/**
 * =========================
 * FASA 2: CLUSTER DACUM TASKS
 * =========================
 */
app.post("/cluster/:session", (req, res) => {
  const session = req.params.session;
  const cards = sessions[session] || [];

  if (!cards.length) {
    return res.status(400).json({ success: false, error: "No cards to cluster" });
  }

  const groups = {};

  for (const c of cards) {
    const text = (c.activity || "").toLowerCase();
    let key = "Lain-lain";

    if (text.includes("jadual") || text.includes("schedule")) key = "Pengurusan Jadual";
    else if (text.includes("imam")) key = "Pengurusan Imam";
    else if (text.includes("bilal")) key = "Pengurusan Bilal";
    else if (text.includes("kehadiran") || text.includes("jemaah") || text.includes("attendance")) key = "Pengurusan Kehadiran/Jemaah";
    else if (text.includes("kewangan") || text.includes("finance") || text.includes("akaun") || text.includes("bayaran")) key = "Pengurusan Kewangan";
    else if (text.includes("program") || text.includes("kuliah") || text.includes("event") || text.includes("majlis")) key = "Pengurusan Program";
    else if (text.includes("aset") || text.includes("inventori") || text.includes("peralatan")) key = "Pengurusan Aset/Inventori";
    else if (text.includes("penyelenggaraan") || text.includes("maintenance")) key = "Penyelenggaraan";

    if (!groups[key]) groups[key] = [];
    groups[key].push(c.activity);
  }

  const clusters = Object.keys(groups).map((title) => ({
    title,
    tasks: groups[title]
  }));

  return res.json({
    success: true,
    session,
    totalCards: cards.length,
    clusters
  });
});

/**
 * =========================
 * FASA 3: AUTO CU GENERATOR (EN)
 * =========================
 */
app.post("/cu/:session", (req, res) => {
  const session = req.params.session;
  const cards = sessions[session] || [];

  if (!cards.length) {
    return res.status(400).json({ success: false, error: "No cards available" });
  }

  const groups = {};

  for (const c of cards) {
    const text = (c.activity || "").toLowerCase();
    let key = "General Operations";

    if (text.includes("schedule") || text.includes("jadual")) key = "Scheduling Management";
    else if (text.includes("imam")) key = "Imam Management";
    else if (text.includes("bilal")) key = "Bilal Management";
    else if (text.includes("attendance") || text.includes("kehadiran") || text.includes("jemaah")) key = "Congregation Attendance";
    else if (text.includes("finance") || text.includes("kewangan") || text.includes("akaun") || text.includes("bayaran")) key = "Financial Management";
    else if (text.includes("program") || text.includes("kuliah") || text.includes("event") || text.includes("majlis")) key = "Programme Management";
    else if (text.includes("asset") || text.includes("aset") || text.includes("inventori") || text.includes("peralatan")) key = "Asset & Inventory Management";
    else if (text.includes("maintenance") || text.includes("penyelenggaraan")) key = "Facilities Maintenance";

    if (!groups[key]) groups[key] = [];
    groups[key].push(c.activity);
  }

  const CU = Object.keys(groups).map((key, index) => ({
    code: `CU${String(index + 1).padStart(2, "0")}`,
    title: key,
    description: `Perform tasks related to ${key.toLowerCase()} to ensure effective and efficient mosque operations.`,
    tasks: groups[key]
  }));

  return res.json({
    success: true,
    session,
    totalCU: CU.length,
    CU
  });
});

/**
 * =========================
 * FASA 4: MySPIKE CPC Extract + Compare (MVP)
 * =========================
 */

/** ---- helpers ---- **/
function decodeHtml(str = "") {
  return String(str)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(html = "") {
  return decodeHtml(String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

async function safeFetch(url) {
  // Node 18+ has global fetch. If not, fallback to node-fetch (optional)
  if (typeof fetch === "function") {
    const res = await fetch(url, { method: "GET" });
    return res;
  } else {
    const nodeFetch = (await import("node-fetch")).default;
    const res = await nodeFetch(url, { method: "GET" });
    return res;
  }
}

function tokenize(text = "") {
  const stop = new Set([
    "dan","yang","di","ke","dari","untuk","pada","oleh","dengan","bagi","atau","serta",
    "the","and","to","of","in","for","on","by","with","a","an"
  ]);

  return stripTags(text)
    .toLowerCase()
    .replace(/[^a-z0-9\u00C0-\u024F\s]/gi, " ")
    .split(/\s+/)
    .filter(t => t && t.length > 2 && !stop.has(t));
}

function jaccard(aTokens, bTokens) {
  const A = new Set(aTokens);
  const B = new Set(bTokens);
  if (!A.size || !B.size) return 0;

  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;

  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

// Extract CU list from a MySPIKE CPC page (simple HTML parse)
async function extractMySpikeCPC(cpcUrl) {
  const res = await safeFetch(cpcUrl);
  const html = await res.text();

  // Quick meta extraction (best-effort)
  // NOSS name/code/level appear in the page as plain text
  const pageText = stripTags(html);

  // Try to find "Kod NOSS" / "Tahap"
  const nossCodeMatch = pageText.match(/Kod\s*NOSS\s*[:\-]?\s*([A-Z0-9\-:\/\.]+)/i);
  const levelMatch = pageText.match(/Tahap\s*[:\-]?\s*(Satu|Dua|Tiga|Empat|Lima|\d+)/i);

  // NOSS name: look near "Nama NOSS" or pick the first long ALLCAPS-ish phrase
  const nossNameMatch =
    pageText.match(/Nama\s*NOSS\s*[:\-]?\s*([A-Z0-9'’\-\(\)\s]{6,})/i) ||
    pageText.match(/Tajuk\s*\/\s*Nama\s*NOSS\s*[:\-]?\s*([A-Z0-9'’\-\(\)\s]{6,})/i);

  // CU titles: usually in a table, with JD links near it.
  // Strategy: collect anchor texts around JD links OR collect TD texts that look like CU titles.
  const cuSet = new Map(); // title -> {title, jdUrl?}

  // Capture JD links and their visible anchor text
  // Example: <a href="...index-jd&id=XXXX">KENDALI ...</a>
  const jdLinkRegex = /<a[^>]+href="([^"]*index-jd[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = jdLinkRegex.exec(html)) !== null) {
    const jdHref = decodeHtml(m[1]);
    const title = stripTags(m[2]);
    if (title && title.length > 3) {
      const fullJdUrl = jdHref.startsWith("http")
        ? jdHref
        : "https://www.myspike.my/" + jdHref.replace(/^\//, "");
      cuSet.set(title, { title, jdUrl: fullJdUrl });
    }
  }

  // Fallback: find table rows, grab <td> that look like CU title
  if (cuSet.size === 0) {
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    while ((m = tdRegex.exec(html)) !== null) {
      const cell = stripTags(m[1]);
      // Heuristic: CU titles tend to be >= 8 chars and contain letters
      if (cell && cell.length >= 8 && /[A-Za-z\u00C0-\u024F]/.test(cell)) {
        // avoid common headers
        const low = cell.toLowerCase();
        if (
          low.includes("core") ||
          low.includes("elektif") ||
          low.includes("competency") ||
          low.includes("profile") ||
          low.includes("chart") ||
          low.includes("bil") ||
          low === "jd"
        ) continue;
        cuSet.set(cell, { title: cell });
      }
    }
  }

  const cuList = Array.from(cuSet.values());

  return {
    cpcUrl,
    nossName: decodeHtml(nossNameMatch ? nossNameMatch[1].trim() : ""),
    nossCode: decodeHtml(nossCodeMatch ? nossCodeMatch[1].trim() : ""),
    level: decodeHtml(levelMatch ? levelMatch[1].trim() : ""),
    totalCU: cuList.length,
    cuList
  };
}

/**
 * POST /myspike/cpc/extract
 * Body: { cpcUrl }
 */
app.post("/myspike/cpc/extract", async (req, res) => {
  try {
    const { cpcUrl } = req.body || {};
    if (!cpcUrl || typeof cpcUrl !== "string") {
      return res.status(400).json({ success: false, error: "cpcUrl required" });
    }
    const data = await extractMySpikeCPC(cpcUrl);
    return res.json({ success: true, ...data });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e.message || e) });
  }
});

/**
 * POST /myspike/compare/:session
 * Body: { cpcUrls: [ ... ] }
 *
 * Compare candidate CU (from /cu/:session) vs MySPIKE CU titles (merged from all CPC URLs)
 * Output: adopted / modified / new (MVP similarity-based)
 */
app.post("/myspike/compare/:session", async (req, res) => {
  try {
    const session = req.params.session;
    const { cpcUrls } = req.body || {};

    if (!Array.isArray(cpcUrls) || cpcUrls.length === 0) {
      return res.status(400).json({ success: false, error: "cpcUrls (array) required" });
    }

    // Candidate CU from our session
    const cards = sessions[session] || [];
    if (!cards.length) {
      return res.status(400).json({ success: false, error: "No cards available for this session" });
    }

    // Rebuild Candidate CU (same logic as /cu/:session) to keep it deterministic
    const groups = {};
    for (const c of cards) {
      const text = (c.activity || "").toLowerCase();
      let key = "General Operations";

      if (text.includes("schedule") || text.includes("jadual")) key = "Scheduling Management";
      else if (text.includes("imam")) key = "Imam Management";
      else if (text.includes("bilal")) key = "Bilal Management";
      else if (text.includes("attendance") || text.includes("kehadiran") || text.includes("jemaah")) key = "Congregation Attendance";
      else if (text.includes("finance") || text.includes("kewangan") || text.includes("akaun") || text.includes("bayaran")) key = "Financial Management";
      else if (text.includes("program") || text.includes("kuliah") || text.includes("event") || text.includes("majlis")) key = "Programme Management";
      else if (text.includes("asset") || text.includes("aset") || text.includes("inventori") || text.includes("peralatan")) key = "Asset & Inventory Management";
      else if (text.includes("maintenance") || text.includes("penyelenggaraan")) key = "Facilities Maintenance";

      if (!groups[key]) groups[key] = [];
      groups[key].push(c.activity);
    }

    const candidateCU = Object.keys(groups).map((key, index) => ({
      code: `CU${String(index + 1).padStart(2, "0")}`,
      title: key,
      tasks: groups[key]
    }));

    // Extract MySPIKE CU from all CPC URLs
    const extracted = [];
    for (const url of cpcUrls) {
      const item = await extractMySpikeCPC(url);
      extracted.push(item);
    }

    // Merge MySPIKE CU list
    const myspikeCU = [];
    const seen = new Set();
    for (const e of extracted) {
      for (const cu of e.cuList || []) {
        const t = (cu.title || "").trim();
        if (!t) continue;
        const key = t.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        myspikeCU.push({
          title: t,
          jdUrl: cu.jdUrl || "",
          sourceCpcUrl: e.cpcUrl || ""
        });
      }
    }

    // Pre-tokenize MySPIKE CU titles
    const myTokens = myspikeCU.map(x => ({
      ...x,
      tokens: tokenize(x.title)
    }));

    // Compare each candidate CU using:
    // - match using CU title + tasks combined (more signal)
    const adoptedCU = [];
    const modifiedCU = [];
    const newCU = [];

    for (const cu of candidateCU) {
      const candidateText = [cu.title, ...(cu.tasks || [])].join(" ");
      const cTokens = tokenize(candidateText);

      let best = { score: 0, match: null };
      for (const mcu of myTokens) {
        const score = jaccard(cTokens, mcu.tokens);
        if (score > best.score) best = { score, match: mcu };
      }

      // Thresholds (MVP)
      const result = {
        candidate: cu,
        bestMatch: best.match
          ? {
              title: best.match.title,
              jdUrl: best.match.jdUrl,
              sourceCpcUrl: best.match.sourceCpcUrl
            }
          : null,
        similarity: Number(best.score.toFixed(3))
      };

      if (best.score >= 0.60) adoptedCU.push(result);
      else if (best.score >= 0.35) modifiedCU.push(result);
      else newCU.push(result);
    }

    return res.json({
      success: true,
      session,
      candidate: { totalCU: candidateCU.length, CU: candidateCU },
      myspike: {
        sources: extracted.map(x => ({
          cpcUrl: x.cpcUrl,
          nossName: x.nossName,
          nossCode: x.nossCode,
          level: x.level,
          totalCU: x.totalCU
        })),
        totalMergedCU: myspikeCU.length
      },
      results: {
        adoptedCU,
        modifiedCU,
        newCU
      },
      notes: [
        "This is MVP similarity-based matching (token Jaccard).",
        "Next upgrade: use JD content + embeddings/LLM for higher accuracy."
      ]
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e.message || e) });
  }
});

// Socket events
io.on("connection", (socket) => {
  socket.on("join", (session) => {
    if (session) socket.join(session);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("DACUM Backend running on port", PORT);
});
