/**
 * server.js — Kemaskini penuh (boleh terus copy/paste)
 * - Fix app missing
 * - Fix OpenAI SDK mismatch (gunakan v4)
 * - Fix threshold undefined
 * - Fix debug endpoint
 * - Improve Socket.IO by session rooms
 * - Slight robustness improvements
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

// ✅ OpenAI SDK v4
const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================
 * App + Server
 * ========================= */
const app = express();

// CORS + JSON body
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" })); // limit kecil untuk safety

// Create HTTP server + Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

/* =========================
 * In-memory storage (MVP)
 * ========================= */
const sessions = {}; // { [sessionId]: Array<Card> }

// =====================================
// FASA 2 (DUMMY): AI Cluster Preview
// =====================================
app.post("/api/cluster/preview", (req, res) => {
  const { sessionId, cards } = req.body || {};

  const items =
    Array.isArray(cards) && cards.length
      ? cards
      : [
          { id: 1, name: "Laungkan azan waktu Subuh" },
          { id: 2, name: "Simpan resit kewangan rasmi" },
          { id: 3, name: "Urus mesyuarat jawatankuasa masjid" },
          { id: 4, name: "Pantau kebersihan ruang solat" },
        ];

  const clusters = [
    {
      theme: "Ibadah & Imam/Bilal",
      items: items.filter((c) =>
        /azan|iqamah|imam|khutbah|solat|wirid/i.test(c.name || "")
      ),
    },
    {
      theme: "Kewangan",
      items: items.filter((c) =>
        /resit|baucar|akaun|kutipan|tabung|bayaran|bajet/i.test(c.name || "")
      ),
    },
    {
      theme: "Pentadbiran",
      items: items.filter((c) =>
        /mesyuarat|minit|surat|rekod|fail|dokumen|jadual/i.test(c.name || "")
      ),
    },
    {
      theme: "Fasiliti & Keselamatan",
      items: items.filter((c) =>
        /kerosakan|penyelenggaraan|keselamatan|peralatan|lampu|kebersihan|pendingin/i.test(
          c.name || ""
        )
      ),
    },
    {
      theme: "Pengimarahan & Program",
      items: items.filter((c) =>
        /kuliah|tazkirah|program|ceramah|jemputan|hebah|media/i.test(c.name || "")
      ),
    },
  ].map((cl) => ({
    ...cl,
    count: cl.items.length,
  }));

  res.json({
    ok: true,
    sessionId: sessionId || null,
    totalCards: items.length,
    clusters,
  });
});

/* =========================
 * Utils (cluster)
 * ========================= */
function cosineSim(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i] || 0;
    const bi = b[i] || 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

/**
 * =========================
 * Post-processing clusters (RULE-BASED)
 * - 1 aktiviti hanya boleh berada dalam 1 CU
 * - buang cluster kosong
 * - label strength (stable/weak)
 * =========================
 */
function postProcessClusters(rawClusters, opts = {}) {
  const {
    minStable = 3,          // >=3 aktiviti => stable (cadangan)
    keepEmptyClusters = false, // default buang cluster kosong
    sortByCountDesc = true,
  } = opts;

  const seenIds = new Set();
  const cleaned = [];

  for (const cl of Array.isArray(rawClusters) ? rawClusters : []) {
    const items = Array.isArray(cl.items) ? cl.items : [];
    const filteredItems = [];

    for (const it of items) {
      // guna id jika ada; fallback guna name (untuk safety)
      const key = (it && (it.id ?? it.name)) ?? null;
      if (key === null) continue;

      if (!seenIds.has(key)) {
        seenIds.add(key);
        filteredItems.push(it);
      }
    }

    // buang cluster kosong (kecuali jika opts keepEmptyClusters = true)
    if (!keepEmptyClusters && filteredItems.length === 0) continue;

    const count = filteredItems.length;
    cleaned.push({
      ...cl,
      items: filteredItems,
      count,
      strength: count >= minStable ? "stable" : "weak",
    });
  }

  if (sortByCountDesc) {
    cleaned.sort((a, b) => (b.count || 0) - (a.count || 0));
  }

  // ringkasan isu untuk debug cepat
  const totalItems = cleaned.reduce((sum, c) => sum + (c.count || 0), 0);

  return {
    clusters: cleaned,
    meta: {
      totalClusters: cleaned.length,
      totalClusteredItems: totalItems,
      minStable,
    },
  };
}

function buildGraphClusters(vectors, threshold = 0.82) {
  const n = vectors.length;
  const adj = Array.from({ length: n }, () => []);

  // graph edges by cosine threshold
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = cosineSim(vectors[i], vectors[j]);
      if (s >= threshold) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }

  // connected components
  const seen = new Array(n).fill(false);
  const comps = [];
  for (let i = 0; i < n; i++) {
    if (seen[i]) continue;
    const stack = [i];
    seen[i] = true;
    const comp = [];
    while (stack.length) {
      const u = stack.pop();
      comp.push(u);
      for (const v of adj[u]) {
        if (!seen[v]) {
          seen[v] = true;
          stack.push(v);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

function keywordTitle(texts, topK = 3) {
  const stop = new Set([
    "dan",
    "yang",
    "untuk",
    "dengan",
    "pada",
    "kepada",
    "dalam",
    "di",
    "ke",
    "dari",
    "atau",
    "oleh",
    "ini",
    "itu",
    "sahaja",
    "juga",
    "agar",
    "supaya",
    "bagi",
    "serta",
    "adalah",
    "akan",
    "telah",
    "semasa",
    "ketika",
    "bila",
    "apabila",
    "cara",
    "buat",
    "membuat",
    "mengurus",
    "urus",
    "pimpin",
    "sebagai",
    "satu",
    "dua",
    "tiga",
    "empat",
    "lima",
    "program",
    "aktiviti",
    "kerja",
  ]);

  const freq = new Map();
  for (const t of texts) {
    const toks = String(t || "")
      .toLowerCase()
      .replace(/[^a-z0-9\u00C0-\u024F\u1E00-\u1EFF\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .filter((w) => w.length >= 3)
      .filter((w) => !stop.has(w));
    for (const w of toks) freq.set(w, (freq.get(w) || 0) + 1);
  }

  const top = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([w]) => w);
  return top.length ? top.join(" / ") : "CU";
}

/* =========================
 * Root route
 * ========================= */
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

  // Live update to clients watching this session (room-based)
  io.to(session).emit("card:new", { session, card });

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

    // Live update to clients in that session room
    io.to(session).emit("card:update", { session, card: updated });

    return res.json({ success: true, card: updated });
  } catch (e) {
    return res
      .status(500)
      .json({ success: false, error: String(e?.message || e) });
  }
});

/* =========================
 * Socket.IO rooms helper
 * =========================
 * Frontend boleh buat:
 *   const socket = io(API_BASE);
 *   socket.emit("session:join", { sessionId });
 *
 * Atau guna endpoint POST /socket/join (optional) untuk debug.
 */
io.on("connection", (socket) => {
  socket.on("session:join", (payload) => {
    try {
      const sessionId = String(payload?.sessionId || "").trim();
      if (!sessionId) return;
      socket.join(sessionId);
      socket.emit("session:joined", { sessionId });
    } catch {}
  });

  socket.on("disconnect", () => {});
});

// Optional debug join via HTTP
app.post("/socket/join", (req, res) => {
  // Ini hanya placeholder untuk debug; join sebenar perlu dibuat dari client socket.
  res.json({ ok: true, note: "Join room perlu dibuat dari Socket.IO client." });
});

/**
 * ======================================================
 * LALUAN B: MySPIKE Comparator (CP -> JD -> WA)
 * WA di MySPIKE: "Objektif Pembelajaran" (senarai 1..n)
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
const myspikeCache = new Map(); // key: sessionId::signature, value: { fetchedAt, data }

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

// Extract id param from URL
function extractAnyId(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get("id");
  } catch {
    const m = String(url).match(/id=(\d+)/);
    return m ? m[1] : null;
  }
}

// Try parse CP id from url
function extractCpId(url) {
  return extractAnyId(url);
}

async function httpGetHtml(url) {
  const resp = await axios.get(url, {
    timeout: 20000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  return resp.data;
}

/**
 * JD page -> extract WA dari "Objektif Pembelajaran"
 */
async function parseMySpikeJDForWA(jdUrl) {
  const html = await httpGetHtml(jdUrl);
  const $ = cheerio.load(html);

  const title =
    $("h1").first().text().trim() ||
    $("title").text().trim() ||
    `JD ${extractAnyId(jdUrl) || ""}`.trim();

  let wa = [];

  // Cari row yang label dia "Objektif Pembelajaran"
  $("tr").each((_, tr) => {
    const tds = $(tr).find("td,th");
    if (!tds || tds.length < 2) return;

    const left = $(tds[0]).text().replace(/\s+/g, " ").trim();
    if (/Objektif Pembelajaran/i.test(left)) {
      const rightCell = $(tds[1]);

      // Jika wujud list <ol><li> atau <ul><li>
      const li = rightCell.find("ol li, ul li");
      if (li.length) {
        li.each((__, x) => {
          const text = $(x).text().replace(/\s+/g, " ").trim();
          if (text) wa.push(text);
        });
      } else {
        // Fallback: parse format "1. ..." "2. ..."
        const raw = rightCell.text().replace(/\s+/g, " ").trim();
        const parts = raw.split(/\s(?=\d+\.)/g).map((s) => s.trim());
        for (const p of parts) {
          const cleaned = p.replace(/^\d+\.\s*/, "").trim();
          if (cleaned && cleaned.length >= 4) wa.push(cleaned);
        }
      }
    }
  });

  // Dedupe
  const seen = new Set();
  wa = wa.filter((x) => {
    const k = normalizeText(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { jdUrl, jdId: extractAnyId(jdUrl), title, wa };
}

/**
 * CP page -> collect semua link JD (r=umum-noss/view&id=XXXX)
 */
async function parseMySpikeCP(cpUrl) {
  const html = await httpGetHtml(cpUrl);
  const $ = cheerio.load(html);

  const title =
    $("h1").first().text().trim() ||
    $("title").text().trim() ||
    `CP ${extractCpId(cpUrl) || ""}`.trim();

  const links = new Set();

  $("a").each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;

    let full = href;

    // Absolute-kan link
    if (href.startsWith("/")) full = "https://www.myspike.my" + href;
    if (href.startsWith("index.php")) full = "https://www.myspike.my/" + href;

    if (
      /r=umum-noss%2Fview&id=\d+/i.test(full) ||
      /r=umum-noss\/view&id=\d+/i.test(full)
    ) {
      links.add(full);
    }
  });

  return {
    cpUrl,
    cpId: extractCpId(cpUrl),
    title,
    jdLinks: Array.from(links),
  };
}

/**
 * Helper: CP->JD->WA (result untuk 1 CP)
 */
async function buildCPResult(cpUrl) {
  const cp = await parseMySpikeCP(cpUrl);

  const jdItems = [];
  for (const jdUrl of cp.jdLinks) {
    const jd = await parseMySpikeJDForWA(jdUrl);
    jdItems.push(jd);
  }

  // Gabung WA dari semua JD
  const allWA = [];
  for (const j of jdItems) for (const w of j.wa || []) allWA.push(w);

  // Dedupe gabungan
  const seen = new Set();
  const mergedWA = allWA.filter((x) => {
    const k = normalizeText(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    cpUrl: cp.cpUrl,
    cpId: cp.cpId,
    title: cp.title,
    jdCount: cp.jdLinks.length,
    wa: mergedWA,
    jd: jdItems.map((j) => ({
      jdUrl: j.jdUrl,
      jdId: j.jdId,
      title: j.title,
      waCount: (j.wa || []).length,
      wa: j.wa || [],
    })),
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

    // cache 15 min (ikut sessionId + url list signature ringkas)
    const cacheKey = `${sessionId}::${urls.join("|")}`;
    const cached = myspikeCache.get(cacheKey);

    if (cached && Date.now() - cached.fetchedAt < 15 * 60 * 1000) {
      return res.json({
        sessionId,
        fetchedAt: cached.fetchedAt,
        cached: true,
        items: cached.data,
      });
    }

    const results = [];
    for (const cpUrl of urls) {
      results.push(await buildCPResult(cpUrl));
    }

    myspikeCache.set(cacheKey, { fetchedAt: Date.now(), data: results });

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
 * {
 *   sessionId?: "dacum-demo",
 *   urls?: [...],
 *   dacumWA?: ["...", "..."],   // optional: gabung dengan session cards
 *   threshold?: 0.45
 * }
 */
app.post("/api/myspike/compare", async (req, res) => {
  try {
    const sessionId = req.body?.sessionId || "dacum-demo";
    const urls =
      Array.isArray(req.body?.urls) && req.body.urls.length
        ? req.body.urls
        : DEFAULT_MYSPIKE_URLS;

    // ✅ FIX: threshold mesti wujud
    const threshold = Number(req.body?.threshold ?? 0.45);

    // Auto ambil DACUM WA dari session (cards yang dah dilabel wa)
    const sessionCards = sessions[sessionId] || [];
    const dacumWA = sessionCards
      .map((c) => (c && c.wa ? String(c.wa).trim() : ""))
      .filter(Boolean);

    // fallback optional: kalau user masih hantar dacumWA dari luar, kita gabungkan
    const dacumWAFromBody = Array.isArray(req.body?.dacumWA)
      ? req.body.dacumWA
      : [];
    for (const x of dacumWAFromBody) {
      const t = String(x || "").trim();
      if (t) dacumWA.push(t);
    }

    if (!dacumWA.length) {
      return res.status(400).json({
        error:
          "Tiada DACUM WA dalam session ini. Pastikan kad DACUM telah dilabel (PATCH /cards/:session/:id dengan field wa).",
        hint: {
          sessionId,
          totalCardsInSession: sessionCards.length,
        },
      });
    }

    // Build parsed MySPIKE from CP->JD->WA (guna cache)
    const cacheKey = `${sessionId}::${urls.join("|")}`;
    let items;

    const cached = myspikeCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < 15 * 60 * 1000) {
      items = cached.data;
    } else {
      items = [];
      for (const cpUrl of urls) {
        items.push(await buildCPResult(cpUrl));
      }
      myspikeCache.set(cacheKey, { fetchedAt: Date.now(), data: items });
    }

    // Flatten all MySPIKE WA
    const myspikeWA = [];
    for (const item of items) for (const w of item.wa || []) myspikeWA.push(w);

    // Dedupe lists
    const dedupeList = (arr) => {
      const out = [];
      const seen = new Set();
      for (const x of arr) {
        const n = normalizeText(x);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        out.push(String(x).trim());
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
      myspike: {
        total: myspikeList.length,
        list: myspikeList,
        itemsSummary: items.map((x) => ({
          cpId: x.cpId,
          title: x.title,
          jdCount: x.jdCount,
          waCount: (x.wa || []).length,
        })),
      },
      dacum: { total: dacumList.length, list: dacumList },
      matches,
      missingInDacum,
      extraInDacum,
      source: { urls },
    });
  } catch (err) {
    console.error("compare error:", err?.message || err);
    return res.status(500).json({
      error: "Failed to compare MySPIKE vs DACUM",
      detail: String(err?.message || err),
    });
  }
});

/* ================================
 * AI CLUSTER SUGGESTION ENDPOINT
 * ================================ */
app.post("/cluster/suggest/:sessionId", async (req, res) => {
  try {
    const sid = String(req.params.sessionId || "").trim();
    if (!sid) return res.status(400).json({ error: "sessionId diperlukan" });

    if (!process.env.OPENAI_API_KEY) {
      return res
        .status(500)
        .json({ error: "OPENAI_API_KEY belum diset di Render" });
    }

    const {
      similarityThreshold = 0.82,
      minClusterSize = 3,
      maxClusters = 12,
    } = req.body || {};

    const items = sessions[sid] || [];

    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ sessionId: sid, clusters: [], unassigned: [] });
    }

    // texts untuk embedding (filter yang kosong supaya OpenAI tak meragam)
    const filtered = items.map(c => ({
      id: c.id,
      text: String(c?.activity || "").trim()
    }));

    if (filtered.length === 0) {
      return res.json({
        sessionId: sid,
        clusters: [],
        unassigned: items.map((x) => x.id),
        note: "Semua activity kosong, tiada input untuk embedding.",
      });
    }

    const texts = filtered.map((x) => x.text);
    const idxToCardId = filtered.map((x) => x.id);

    // Embeddings (OpenAI v4)
    const emb = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: texts,
    });

    const vectors = emb.data.map((d) => d.embedding);

    // cluster by similarity graph
    const comps = buildGraphClusters(vectors, Number(similarityThreshold));

    // pilih cluster yang cukup besar
    const valid = comps
      .filter((c) => c.length >= Number(minClusterSize))
      .sort((a, b) => b.length - a.length)
      .slice(0, Number(maxClusters));

    const clustered = new Set(valid.flat());
    const unassigned = [];
    for (let i = 0; i < idxToCardId.length; i++) {
      if (!clustered.has(i)) unassigned.push(idxToCardId[i]);
    }

    // create cluster result + tajuk sementara
    const clusters = valid.map((idxs, k) => {
      const clusterTexts = idxs.map((i) => texts[i]);
      return {
        clusterId: `c${k + 1}`,
        title: keywordTitle(clusterTexts, 3),
        cardIds: idxs.map((i) => idxToCardId[i]),
      };
    });

    const processed = postProcessClusters(clusters, {
      minStable: 3,
      keepEmptyClusters: false,
      sortByCountDesc: true,
    });
    
    return res.json({
      ok: true,
      sessionId: sid,
      generatedAt: new Date().toISOString(),
      params: { similarityThreshold, minClusterSize, maxClusters },

      clusters: processed.clusters,
      meta: processed.meta,
      
      unassigned,
    });
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ error: e?.message || "AI clustering error" });
  }
});

/* ================================
 * DEBUG OPENAI CONNECTION (v4)
 * ================================ */
app.get("/debug/openai", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        message: "OPENAI_API_KEY belum diset",
      });
    }

    const r = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: "test connection",
    });

    res.json({
      ok: true,
      embedding_dim: r.data[0].embedding.length,
    });
  } catch (e) {
    console.error("OPENAI DEBUG ERROR:", e?.message);
    res.status(500).json({
      ok: false,
      message: e?.message,
      detail: e?.response?.data || null,
    });
  }
});

/* =========================
 * Port
 * ========================= */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("DACUM Backend running on port", PORT);
});
