/**
 * server.js — Kemaskini penuh (copy/paste terus)
 * Fokus: DACUM Cards + Live Board + AI Clustering (REAL) + MySPIKE Comparator
 *
 * ✅ Fix: route /api/cluster/run wujud (sebelum ini 404)
 * ✅ Fix: elak route nested (app.post dalam app.post)
 * ✅ Fix: guna OpenAI SDK v4 secara konsisten
 * ✅ Add: GET /api/cluster/result/:sessionId (untuk refresh)
 * ✅ Keep: Socket.IO session rooms
 * ✅ Keep: MySPIKE endpoints (parse-wa, compare)
 * ✅ Remove: endpoint duplicate/mengelirukan (/cluster/suggest/:sessionId)
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

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

/* =========================
 * In-memory storage (MVP)
 * ========================= */
const sessions = {};     // { [sessionId]: Array<Card> }
const clusterStore = {}; // { [sessionId]: { sessionId, generatedAt, clusters, unassigned } }

/* =========================
 * Root
 * ========================= */
app.get("/", (req, res) => {
  res.send("DACUM Backend OK");
});

/* =========================
 * DEBUG: OpenAI connection
 * ========================= */
app.get("/debug/openai", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, message: "OPENAI_API_KEY belum diset" });
    }

    const r = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: "test connection",
    });

    return res.json({
      ok: true,
      embedding_dim: r.data?.[0]?.embedding?.length || null,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e?.message || "OpenAI debug error",
      detail: e?.response?.data || null,
    });
  }
});

/* ======================================================
 * FASA 1: CARDS API (MVP)
 * ======================================================
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
  const session = String(req.params.session || "").trim();
  return res.json(sessions[session] || []);
});

// POST: Create new RAW DACUM card
app.post("/cards/:session", (req, res) => {
  const session = String(req.params.session || "").trim();
  const { name, activity } = req.body || {};

  if (!name || !activity) {
    return res.status(400).json({ success: false, error: "name & activity required" });
  }

  if (!sessions[session]) sessions[session] = [];

  const card = {
    id: Date.now(), // MVP ok; nanti boleh tukar uuid
    name: String(name).trim(),
    activity: String(activity).trim(),
    time: new Date().toISOString(),
  };

  sessions[session].push(card);

  // Live update to clients watching this session (room-based)
  io.to(session).emit("card:new", { session, card });

  return res.json({ success: true, card });
});

// PATCH: Label card with CU & WA
app.patch("/cards/:session/:id", (req, res) => {
  try {
    const session = String(req.params.session || "").trim();
    const id = String(req.params.id || "").trim();

    const { cu, wa } = req.body || {};
    if (!cu || !wa) {
      return res.status(400).json({ success: false, error: "cu & wa required" });
    }

    const arr = sessions[session];
    if (!Array.isArray(arr)) {
      return res.status(404).json({ success: false, error: "session not found" });
    }

    const idx = arr.findIndex((c) => String(c.id) === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: "card not found" });
    }

    const updated = {
      ...arr[idx],
      cu: String(cu).trim(),
      wa: String(wa).trim(),
      updatedAt: new Date().toISOString(),
    };

    arr[idx] = updated;

    io.to(session).emit("card:update", { session, card: updated });

    return res.json({ success: true, card: updated });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

/* =========================
 * Socket.IO rooms
 * ========================= */
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

// Optional debug join via HTTP (placeholder)
app.post("/socket/join", (req, res) => {
  return res.json({ ok: true, note: "Join room perlu dibuat dari Socket.IO client." });
});

/* ======================================================
 * FASA 2A (OPTIONAL): AI Cluster Preview (Embeddings + Graph)
 * - Ini masih berguna untuk debug / eksperimen
 * - Tetapi FRONTEND anda sekarang fokus pada /api/cluster/run (REAL CU)
 * ====================================================== */
app.post("/api/cluster/preview", async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    const sid = String(sessionId || "").trim();
    if (!sid) return res.status(400).json({ ok: false, error: "sessionId diperlukan" });

    const items = Array.isArray(sessions[sid]) ? sessions[sid] : [];
    const totalCards = items.length;

    if (!totalCards) {
      return res.json({
        ok: true,
        sessionId: sid,
        totalCards: 0,
        clusters: [],
        unassigned: [],
        meta: { note: "Tiada card dalam session." },
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "OPENAI_API_KEY belum diset" });
    }

    const filtered = items
      .map((c) => ({
        id: c.id,
        text: String(c?.activity ?? c?.name ?? "").trim(),
      }))
      .filter((x) => x.text);

    if (!filtered.length) {
      return res.json({
        ok: true,
        sessionId: sid,
        totalCards,
        clusters: [],
        unassigned: items.map((x) => x.id),
        meta: { note: "Semua card kosong (tiada activity/name)." },
      });
    }

    const texts = filtered.map((x) => x.text);

    const emb = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: texts,
    });

    const vectors = emb.data.map((d) => d.embedding);

    const similarityThreshold = Number(req.body?.similarityThreshold ?? 0.82);
    const minClusterSize = Number(req.body?.minClusterSize ?? 3);
    const maxClusters = Number(req.body?.maxClusters ?? 12);

    const comps = buildGraphClusters(vectors, similarityThreshold);

    const valid = comps
      .filter((c) => c.length >= minClusterSize)
      .sort((a, b) => b.length - a.length)
      .slice(0, maxClusters);

    const clusteredIdx = new Set(valid.flat());
    const unassigned = [];
    for (let i = 0; i < filtered.length; i++) {
      if (!clusteredIdx.has(i)) unassigned.push(filtered[i].id);
    }

    const rawClusters = valid.map((idxs, k) => {
      const clusterItems = idxs.map((i) => ({
        id: filtered[i].id,
        name: texts[i],
      }));

      return {
        clusterId: `c${k + 1}`,
        theme: keywordTitle(clusterItems.map((x) => x.name), 3),
        items: clusterItems,
      };
    });

    const processed = postProcessClusters(rawClusters, {
      minStable: 3,
      keepEmptyClusters: false,
      sortByCountDesc: true,
    });

    return res.json({
      ok: true,
      sessionId: sid,
      totalCards,
      generatedAt: new Date().toISOString(),
      params: { similarityThreshold, minClusterSize, maxClusters },
      clusters: processed.clusters,
      meta: { ...processed.meta, unassignedCount: unassigned.length },
      unassigned,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "AI cluster preview error",
    });
  }
});

/* ======================================================
 * FASA 2B (REAL): AI Cluster RUN (Chat -> JSON clusters)
 * Endpoint yang FRONTEND anda panggil:
 *   POST /api/cluster/run  { sessionId }
 * Output standard:
 * {
 *   sessionId,
 *   generatedAt,
 *   clusters: [{ title, cardIds }],
 *   unassigned: [id...]
 * }
 * ====================================================== */
app.post("/api/cluster/run", async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    const sid = String(sessionId || "").trim();
    if (!sid) return res.status(400).json({ error: "sessionId diperlukan" });

    const items = Array.isArray(sessions[sid]) ? sessions[sid] : [];
    if (items.length < 5) {
      return res.status(400).json({ error: "Terlalu sedikit kad untuk clustering (min 5)" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY belum diset" });
    }

    const cards = items
      .map((c) => ({
        id: c.id,
        activity: String(c?.activity ?? c?.name ?? "").trim(),
      }))
      .filter((c) => c.activity);

    if (cards.length < 5) {
      return res.status(400).json({ error: "Terlalu sedikit kad yang ada teks (min 5)" });
    }

    const prompt = `
Anda ialah fasilitator DACUM.
Tugas: klusterkan aktiviti kerja kepada kumpulan CU yang logik.

Keluaran mestilah JSON SAHAJA, format:
{
  "clusters":[{"title":"...","cardIds":[1,2,3]}],
  "unassigned":[]
}

Peraturan:
- Bilangan cluster antara 4 hingga 12 (ikut kesesuaian).
- Tajuk cluster ringkas (2–6 perkataan) dalam Bahasa Melayu.
- Setiap cardId hanya berada dalam SATU cluster.
- Jika aktiviti terlalu umum/pelik, letak dalam unassigned.

Data aktiviti:
${cards.map((c) => `(${c.id}) ${c.activity}`).join("\n")}
`.trim();

    // ✅ OpenAI SDK v4 (chat)
    const out = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Anda menjawab dengan JSON sahaja." },
        { role: "user", content: prompt },
      ],
    });

    const raw = out?.choices?.[0]?.message?.content || "{}";

    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }

    if (!parsed || !Array.isArray(parsed.clusters)) {
      return res.status(500).json({ error: "Output AI tidak sah", raw });
    }

    // Normalize output
    const clusters = parsed.clusters
      .map((cl) => ({
        title: String(cl?.title || "").trim(),
        cardIds: Array.isArray(cl?.cardIds) ? cl.cardIds : [],
      }))
      .filter((cl) => cl.title && cl.cardIds.length);

    const unassigned = Array.isArray(parsed.unassigned) ? parsed.unassigned : [];

    const result = {
      sessionId: sid,
      generatedAt: new Date().toISOString(),
      clusters,
      unassigned,
    };

    // store for refresh
    clusterStore[sid] = result;

    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e?.message || "AI cluster run error" });
  }
});

// GET last result (for refresh)
app.get("/api/cluster/result/:sessionId", (req, res) => {
  const sid = String(req.params.sessionId || "").trim();
  const data = clusterStore[sid];
  if (!data) return res.status(404).json({ error: "Tiada cluster result untuk session ini" });
  return res.json(data);
});

/* =========================
 * Utils (cluster)
 * ========================= */
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
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

function buildGraphClusters(vectors, threshold = 0.82) {
  const n = vectors.length;
  const adj = Array.from({ length: n }, () => []);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = cosineSim(vectors[i], vectors[j]);
      if (s >= threshold) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }

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

function postProcessClusters(rawClusters, opts = {}) {
  const {
    minStable = 3,
    keepEmptyClusters = false,
    sortByCountDesc = true,
  } = opts;

  const seenIds = new Set();
  const cleaned = [];

  for (const cl of Array.isArray(rawClusters) ? rawClusters : []) {
    const items = Array.isArray(cl.items) ? cl.items : [];
    const filteredItems = [];

    for (const it of items) {
      const key = (it && (it.id ?? it.name)) ?? null;
      if (key === null) continue;

      if (!seenIds.has(key)) {
        seenIds.add(key);
        filteredItems.push(it);
      }
    }

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

function keywordTitle(texts, topK = 3) {
  const stop = new Set([
    "dan", "yang", "untuk", "dengan", "pada", "kepada", "dalam", "di", "ke", "dari", "atau",
    "oleh", "ini", "itu", "sahaja", "juga", "agar", "supaya", "bagi", "serta", "adalah",
    "akan", "telah", "semasa", "ketika", "bila", "apabila", "cara", "buat", "membuat",
    "mengurus", "urus", "pimpin", "sebagai", "satu", "dua", "tiga", "empat", "lima",
    "program", "aktiviti", "kerja",
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

/* ======================================================
 * LALUAN B: MySPIKE Comparator (CP -> JD -> WA)
 * ====================================================== */

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

// JD page -> extract WA dari "Objektif Pembelajaran"
async function parseMySpikeJDForWA(jdUrl) {
  const html = await httpGetHtml(jdUrl);
  const $ = cheerio.load(html);

  const title =
    $("h1").first().text().trim() ||
    $("title").text().trim() ||
    `JD ${extractAnyId(jdUrl) || ""}`.trim();

  let wa = [];

  $("tr").each((_, tr) => {
    const tds = $(tr).find("td,th");
    if (!tds || tds.length < 2) return;

    const left = $(tds[0]).text().replace(/\s+/g, " ").trim();
    if (/Objektif Pembelajaran/i.test(left)) {
      const rightCell = $(tds[1]);

      const li = rightCell.find("ol li, ul li");
      if (li.length) {
        li.each((__, x) => {
          const text = $(x).text().replace(/\s+/g, " ").trim();
          if (text) wa.push(text);
        });
      } else {
        const raw = rightCell.text().replace(/\s+/g, " ").trim();
        const parts = raw.split(/\s(?=\d+\.)/g).map((s) => s.trim());
        for (const p of parts) {
          const cleaned = p.replace(/^\d+\.\s*/, "").trim();
          if (cleaned && cleaned.length >= 4) wa.push(cleaned);
        }
      }
    }
  });

  const seen = new Set();
  wa = wa.filter((x) => {
    const k = normalizeText(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { jdUrl, jdId: extractAnyId(jdUrl), title, wa };
}

// CP page -> collect semua link JD
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

async function buildCPResult(cpUrl) {
  const cp = await parseMySpikeCP(cpUrl);

  const jdItems = [];
  for (const jdUrl of cp.jdLinks) {
    const jd = await parseMySpikeJDForWA(jdUrl);
    jdItems.push(jd);
  }

  const allWA = [];
  for (const j of jdItems) for (const w of j.wa || []) allWA.push(w);

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
    const sessionId = String(req.body?.sessionId || "dacum-demo").trim();
    const urls =
      Array.isArray(req.body?.urls) && req.body.urls.length
        ? req.body.urls
        : DEFAULT_MYSPIKE_URLS;

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
    for (const cpUrl of urls) results.push(await buildCPResult(cpUrl));

    myspikeCache.set(cacheKey, { fetchedAt: Date.now(), data: results });

    return res.json({
      sessionId,
      fetchedAt: Date.now(),
      cached: false,
      items: results,
    });
  } catch (err) {
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
 *   threshold?: 0.45
 * }
 */
app.post("/api/myspike/compare", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "dacum-demo").trim();
    const urls =
      Array.isArray(req.body?.urls) && req.body.urls.length
        ? req.body.urls
        : DEFAULT_MYSPIKE_URLS;

    const threshold = Number(req.body?.threshold ?? 0.45);

    const sessionCards = sessions[sessionId] || [];
    const dacumWA = sessionCards
      .map((c) => (c && c.wa ? String(c.wa).trim() : ""))
      .filter(Boolean);

    if (!dacumWA.length) {
      return res.status(400).json({
        error: "Tiada DACUM WA dalam session ini. Pastikan kad DACUM telah dilabel (PATCH /cards/:session/:id dengan field wa).",
        hint: { sessionId, totalCardsInSession: sessionCards.length },
      });
    }

    const cacheKey = `${sessionId}::${urls.join("|")}`;
    let items;

    const cached = myspikeCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < 15 * 60 * 1000) {
      items = cached.data;
    } else {
      items = [];
      for (const cpUrl of urls) items.push(await buildCPResult(cpUrl));
      myspikeCache.set(cacheKey, { fetchedAt: Date.now(), data: items });
    }

    const myspikeWA = [];
    for (const item of items) for (const w of item.wa || []) myspikeWA.push(w);

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

    const matchedDacumNorm = new Set(matches.map((m) => normalizeText(m.bestDacumWA)));
    const extraInDacum = dacumList.filter((dw) => !matchedDacumNorm.has(normalizeText(dw)));

    return res.json({
      sessionId,
      threshold,
      myspike: {
        total: myspikeList.length,
        itemsSummary: items.map((x) => ({
          cpId: x.cpId,
          title: x.title,
          jdCount: x.jdCount,
          waCount: (x.wa || []).length,
        })),
      },
      dacum: { total: dacumList.length },
      matches,
      missingInDacum,
      extraInDacum,
      source: { urls },
    });
  } catch (err) {
    return res.status(500).json({
      error: "Failed to compare MySPIKE vs DACUM",
      detail: String(err?.message || err),
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
