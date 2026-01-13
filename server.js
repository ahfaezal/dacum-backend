const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();

// CORS + JSON body
app.use(cors({ origin: "*" }));
app.use(express.json());

// Create HTTP server + Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

// In-memory storage (MVP)
const sessions = {}; // { [sessionId]: Array<Card> }

// Root route for quick test
app.get("/", (req, res) => {
  res.send("DACUM Backend OK");
});

/**
 * =========================
 * FASA 1: CARDS API (MVP)
 * =========================
 *
 * Card model (MVP):
 * {
 *   id: number,
 *   name: string,
 *   activity: string,
 *   time: ISOString,
 *   cu?: string,
 *   wa?: string,
 *   updatedAt?: ISOString
 * }
 */

// GET: List cards by session
app.get("/cards/:session", (req, res) => {
  const session = req.params.session;
  res.json(sessions[session] || []);
});

// POST: Create new RAW DACUM card
app.post("/cards/:session", (req, res) => {
  const session = req.params.session;
  const { name, activity } = req.body || {};

  if (!name || !activity) {
    return res
      .status(400)
      .json({ success: false, error: "name & activity required" });
  }

  if (!sessions[session]) sessions[session] = [];

  const card = {
    id: Date.now(),
    name: String(name).trim(),
    activity: String(activity).trim(),
    time: new Date().toISOString(),
  };

  sessions[session].push(card);

  // Live update to clients watching this session (optional)
  io.emit("card:new", { session, card });

  return res.json({ success: true, card });
});

// PATCH: Label card with CU & WA (untuk bina CPC hasil DACUM)
app.patch("/cards/:session/:id", (req, res) => {
  try {
    const session = req.params.session;
    const id = String(req.params.id);

    const { cu, wa } = req.body || {};
    if (!cu || !wa) {
      return res
        .status(400)
        .json({ success: false, error: "cu & wa required" });
    }

    const arr = sessions[session];
    if (!Array.isArray(arr)) {
      return res
        .status(404)
        .json({ success: false, error: "session not found" });
    }

    const idx = arr.findIndex((c) => String(c.id) === id);
    if (idx === -1) {
      return res
        .status(404)
        .json({ success: false, error: "card not found" });
    }

    const updated = {
      ...arr[idx],
      cu: String(cu).trim(),
      wa: String(wa).trim(),
      updatedAt: new Date().toISOString(),
    };

    arr[idx] = updated;

    // Live update
    io.emit("card:update", { session, card: updated });

    return res.json({ success: true, card: updated });
  } catch (e) {
    return res
      .status(500)
      .json({ success: false, error: String(e?.message || e) });
  }
});

/**
 * ======================================================
 * LALUAN B: MySPIKE Comparator (Parse WA + Compare)
 * ======================================================
 */

// 5 URL default (boleh override dari request)
const DEFAULT_MYSPIKE_URLS = [
  "https://www.myspike.my/index.php?r=umum-noss%2Findex-cp&id=8666",
  "https://www.myspike.my/index.php?r=umum-noss%2Findex-cp&id=8669",
  "https://www.myspike.my/index.php?r=umum-noss%2Findex-cp&id=8670",
  "https://www.myspike.my/index.php?r=umum-noss%2Findex-cp&id=8673",
  "https://www.myspike.my/index.php?r=umum-noss%2Findex-cp&id=8676",
];

// Cache ringkas ikut session (in-memory)
const myspikeCache = new Map(); // key: sessionId, value: { fetchedAt, data }

// --- util text ---
function normalizeText(s = "") {
  return String(s)
    .replace(/\s+/g, " ")
    .replace(/[“”‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .trim()
    .toLowerCase();
}

// Similarity ringkas: token Jaccard (0..1)
function jaccardSimilarity(a, b) {
  const A = new Set(normalizeText(a).split(" ").filter(Boolean));
  const B = new Set(normalizeText(b).split(" ").filter(Boolean));
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;

  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Try parse CP id from url
function extractCpId(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get("id");
  } catch {
    const m = String(url).match(/id=(\d+)/);
    return m ? m[1] : null;
  }
}

/**
 * Parse MySPIKE CP page -> extract WA list (best-effort).
 */
async function parseMySpikeWA(url) {
  const resp = await axios.get(url, {
    timeout: 20000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  const html = resp.data;
  const $ = cheerio.load(html);

  const pageTitle =
    $("h1").first().text().trim() ||
    $("title").text().trim() ||
    `CP ${extractCpId(url) || ""}`.trim();

  let candidates = [];

  // 1) Cari dalam table row yang ada petunjuk WA
  $("table tr").each((_, tr) => {
    const cells = $(tr).find("td,th");
    const texts = [];
    cells.each((__, c) => texts.push($(c).text().replace(/\s+/g, " ").trim()));
    const rowText = texts.join(" | ");

    if (/(work\s*activity|aktiviti\s*kerja|\bwa\b)/i.test(rowText)) {
      const last = texts[texts.length - 1] || "";
      if (last && last.length > 4) candidates.push(last);
    }
  });

  // 2) Fallback: list item
  if (candidates.length < 3) {
    $("li").each((_, li) => {
      const t = $(li).text().replace(/\s+/g, " ").trim();
      if (
        t.length >= 12 &&
        t.length <= 180 &&
        !/cookie|privacy|copyright/i.test(t)
      ) {
        candidates.push(t);
      }
    });
  }

  // 3) Fallback: text lines
  if (candidates.length < 3) {
    const bodyText = $("body").text().replace(/\r/g, "\n");
    const lines = bodyText
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    for (const l of lines) {
      if (l.length >= 12 && l.length <= 180 && !/login|daftar|carian/i.test(l)) {
        candidates.push(l);
      }
    }
  }

  // Clean + dedupe
  const dedup = [];
  const seen = new Set();
  for (const c of candidates) {
    const n = normalizeText(c);
    if (!n || n === "work activity" || n === "aktiviti kerja") continue;
    if (seen.has(n)) continue;
    seen.add(n);
    dedup.push(c.trim());
  }

  return {
    url,
    cpId: extractCpId(url),
    title: pageTitle,
    wa: dedup,
  };
}

/**
 * POST /api/myspike/parse-wa
 * Body: { sessionId?: "dacum-demo", urls?: [..] }
 */
app.post("/api/myspike/parse-wa", async (req, res) => {
  try {
    const sessionId = req.body?.sessionId || "dacum-demo";
    const urls =
      Array.isArray(req.body?.urls) && req.body.urls.length
        ? req.body.urls
        : DEFAULT_MYSPIKE_URLS;

    // cache 15 min
    const cached = myspikeCache.get(sessionId);
    if (cached && Date.now() - cached.fetchedAt < 15 * 60 * 1000) {
      return res.json({
        sessionId,
        fetchedAt: cached.fetchedAt,
        cached: true,
        items: cached.data,
      });
    }

    const results = [];
    for (const url of urls) {
      const item = await parseMySpikeWA(url);
      results.push(item);
    }

    myspikeCache.set(sessionId, { fetchedAt: Date.now(), data: results });

    return res.json({
      sessionId,
      fetchedAt: Date.now(),
      cached: false,
      items: results,
    });
  } catch (err) {
    console.error("parse-wa error:", err?.message || err);
    return res.status(500).json({
      error: "Failed to parse MySPIKE WA",
      detail: String(err?.message || err),
    });
  }
});

/**
 * POST /api/myspike/compare
 * Body:
 * { sessionId?: "dacum-demo", urls?: [...], dacumWA: [...], threshold?: 0.45 }
 */
app.post("/api/myspike/compare", async (req, res) => {
  try {
    const sessionId = req.body?.sessionId || "dacum-demo";
    const urls =
      Array.isArray(req.body?.urls) && req.body.urls.length
        ? req.body.urls
        : DEFAULT_MYSPIKE_URLS;

    const dacumWA = Array.isArray(req.body?.dacumWA) ? req.body.dacumWA : [];
    const threshold =
      typeof req.body?.threshold === "number" ? req.body.threshold : 0.45;

    if (!dacumWA.length) {
      return res.status(400).json({
        error:
          "dacumWA is required (array). Buat sementara, hantar dari frontend dahulu.",
      });
    }

    // Parse MySPIKE (guna cache jika ada)
    let parsed;
    const cached = myspikeCache.get(sessionId);
    if (cached && Date.now() - cached.fetchedAt < 15 * 60 * 1000) {
      parsed = cached.data;
    } else {
      parsed = [];
      for (const url of urls) parsed.push(await parseMySpikeWA(url));
      myspikeCache.set(sessionId, { fetchedAt: Date.now(), data: parsed });
    }

    // Flatten all MySPIKE WA
    const myspikeWA = [];
    for (const item of parsed) {
      for (const w of item.wa) myspikeWA.push(w);
    }

    // Dedupe lists
    const dedupeList = (arr) => {
      const out = [];
      const seen = new Set();
      for (const x of arr) {
        const n = normalizeText(x);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        out.push(x.trim());
      }
      return out;
    };

    const myspikeList = dedupeList(myspikeWA);
    const dacumList = dedupeList(dacumWA);

    // Match MySPIKE -> best DACUM
    const matches = [];
    const missingInDacum = [];

    for (const mw of myspikeList) {
      let best = { score: -1, dw: null };
      for (const dw of dacumList) {
        const s = jaccardSimilarity(mw, dw);
        if (s > best.score) best = { score: s, dw };
      }
      if (best.score >= threshold) {
        matches.push({
          myspikeWA: mw,
          bestDacumWA: best.dw,
          score: Number(best.score.toFixed(3)),
        });
      } else {
        missingInDacum.push({
          myspikeWA: mw,
          bestDacumWA: best.dw,
          score: Number(best.score.toFixed(3)),
        });
      }
    }

    // Extra in DACUM: yang tak matched oleh mana-mana MySPIKE
    const matchedDacumNorm = new Set(
      matches.map((m) => normalizeText(m.bestDacumWA))
    );
    const extraInDacum = dacumList.filter(
      (dw) => !matchedDacumNorm.has(normalizeText(dw))
    );

    return res.json({
      sessionId,
      threshold,
      myspike: { total: myspikeList.length, list: myspikeList },
      dacum: { total: dacumList.length, list: dacumList },
      matches,
      missingInDacum,
      extraInDacum,
      source: {
        urls,
        parsedSummary: parsed.map((p) => ({
          cpId: p.cpId,
          title: p.title,
          waCount: p.wa.length,
        })),
      },
    });
  } catch (err) {
    console.error("compare error:", err?.message || err);
    return res.status(500).json({
      error: "Failed to compare MySPIKE vs DACUM",
      detail: String(err?.message || err),
    });
  }
});

/**
 * =========================
 * Socket.IO basic events
 * =========================
 */
io.on("connection", (socket) => {
  // Optional: boleh log untuk debug
  // console.log("Socket connected:", socket.id);

  socket.on("disconnect", () => {
    // console.log("Socket disconnected:", socket.id);
  });
});

// Port
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("DACUM Backend running on port", PORT);
});
