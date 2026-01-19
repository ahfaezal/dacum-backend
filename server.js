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
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;

server.listen(PORT, () => console.log("Listening on", PORT));

// ✅ OpenAI SDK v4
const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const fs = require("fs");
const path = require("path");

/**
 * =========================
 * iNOSS – CU Naming Rules (NOSS Compliant)
 * =========================
 * - SATU kata kerja sahaja
 * - TIADA perkataan "dan"
 * - Format: [Kata Kerja] + [Objek] + [Konteks]
 */

const CU_OBJECT_MAP = [
  {
    keywords: ["dokumen", "dokumentasi", "fail", "rekod", "simpan"],
    verb: "Urus",
    object: "Dokumentasi Pengimarahan Masjid"
  },
  {
    keywords: ["solat", "imam", "iqamah", "azan", "fardu", "jumaat"],
    verb: "Pimpin",
    object: "Solat Berjemaah"
  },
  {
    keywords: ["wirid", "doa", "zikir"],
    verb: "Pimpin",
    object: "Wirid Jemaah"
  },
  {
    keywords: ["minit", "mesyuarat", "surat", "rasmi"],
    verb: "Sediakan",
    object: "Minit Mesyuarat Masjid"
  },
  {
    keywords: ["baucar", "kewangan", "resit", "bil", "bayaran"],
    verb: "Sediakan",
    object: "Laporan Kewangan Masjid"
  },
  {
    keywords: ["penceramah", "jemput", "undangan"],
    verb: "Selaras",
    object: "Penceramah Program Masjid"
  }
];

/*
 * =========================
 * iNOSS – CU Naming Engine (Rule-Based)
 * =========================
 * Rules:
 * - 1 kata kerja sahaja
 * - tidak boleh ada "dan"
 * - output: "KATA KERJA + OBJEK"
 */
function suggestCUName(activities = []) {
  const text = String(Array.isArray(activities) ? activities.join(" ") : activities || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  // fallback jika tiada data
  if (!text) {
    return {
      title: "Urus Aktiviti Pengimarahan Masjid",
      verb: "Urus",
      object: "Aktiviti Pengimarahan Masjid",
      confidence: 0.2,
      reasons: ["fallback:no-activities"],
    };
  }

  let best = null;
  let bestScore = 0;
  let bestReasons = [];

  for (const map of CU_OBJECT_MAP) {
    const keywords = Array.isArray(map?.keywords) ? map.keywords : [];
    let score = 0;
    const reasons = [];

    for (const kw of keywords) {
      const k = String(kw || "").toLowerCase().trim();
      if (!k) continue;
      if (text.includes(k)) {
        score += 1;
        reasons.push(k);
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = map;
      bestReasons = reasons;
    }
  }

  // fallback jika tiada padanan
  if (!best) {
    return {
      title: "Urus Aktiviti Pengimarahan Masjid",
      verb: "Urus",
      object: "Aktiviti Pengimarahan Masjid",
      confidence: 0.3,
      reasons: ["fallback:no-match"],
    };
  }

  // pastikan tiada "dan" dalam objek
  const verb = String(best.verb || "Urus").trim();
  let object = String(best.object || "Aktiviti Pengimarahan Masjid").trim();
  object = object.replace(/\bdan\b/gi, "");     // buang perkataan "dan"
  object = object.replace(/\s+/g, " ").trim();  // kemas whitespace

  // pastikan output ada 1 kata kerja sahaja (kita guna verb dari map, bukan dari text)
  const title = `${verb} ${object}`.trim();

  // confidence ringkas berdasarkan bil match (maks 5)
  const confidence = Math.max(0.35, Math.min(0.95, bestScore / 5));

  return {
    title,
    verb,
    object,
    confidence,
    reasons: bestReasons,
  };
}

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

// ===============================
// MySPIKE CU Index (REAL)
// ===============================
const DATA_DIR = path.join(__dirname, "data");
const INDEX_FILE = path.join(DATA_DIR, "myspike_index.json");
const META_FILE = path.join(DATA_DIR, "myspike_index.meta.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadIndex() {
  ensureDataDir();
  if (!fs.existsSync(INDEX_FILE)) return [];
  return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
}

function saveIndex(items) {
  ensureDataDir();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(items, null, 2), "utf8");
}

function loadMeta() {
  ensureDataDir();
  if (!fs.existsSync(META_FILE)) return { totalNoss: 0, totalCU: 0, lastPage: 0, updatedAt: null };
  return JSON.parse(fs.readFileSync(META_FILE, "utf8"));
}

function saveMeta(meta) {
  ensureDataDir();
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), "utf8");
}

// Crawl NOSS list page (Paparan 1) dan extract link CPC (Paparan 2: index-cp&id=XXX)
async function fetchNossListPage(page = 1) {
  // MySPIKE guna DataTables; kadang page param berbeza.
  // Kita buat cara "paling stabil": scrap semua link index-cp&id=... yang muncul.
  const url = `https://www.myspike.my/index.php?r=umum-noss%2Findex-noss&page=${page}`;
  const html = (await axios.get(url)).data;
  const $ = cheerio.load(html);

  // cari semua link ke index-cp&id=...
  const cpIds = new Set();
  $("a[href*='r=umum-noss%2Findex-cp&id=']").each((_, a) => {
    const href = $(a).attr("href") || "";
    const m = href.match(/index-cp&id=(\d+)/);
    if (m) cpIds.add(m[1]);
  });

  return Array.from(cpIds);
}

// Crawl CP page (Paparan 2) dan extract CU rows
async function fetchCuFromCpId(cpId) {
  const url = `https://www.myspike.my/index.php?r=umum-noss%2Findex-cp&id=${cpId}`;
  const html = (await axios.get(url)).data;
  const $ = cheerio.load(html);

  // Ambil Kod NOSS + Tajuk NOSS + Tahap (kalau ada di header)
  const pageText = $("body").text();
  const nossCodeMatch = pageText.match(/Kod NOSS\s*:\s*([A-Z0-9\-:]+)/i);
  const nossCode = nossCodeMatch ? nossCodeMatch[1].trim() : "";

  const nossTitleMatch = pageText.match(/Nama NOSS\s*:\s*(.+)/i);
  const nossTitle = nossTitleMatch ? nossTitleMatch[1].trim().split("\n")[0] : "";

  // CU table: biasanya ada kolum "Tajuk Competency Unit (CU)"
  const items = [];
  $("table tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 3) return;

    const cuType = $(tds[1]).text().trim(); // contoh: Core/Elektif
    const cuTitle = $(tds[2]).text().trim();

    if (!cuTitle) return;

    // JD link (optional) – boleh guna untuk WA later (on-demand)
    const jdHref = $(tr).find("a[href*='Job Description']").attr("href") || "";

    items.push({
      source: "myspike",
      cpId: String(cpId),
      nossCode,
      nossTitle,
      cuType,
      cuTitle,
      jdUrl: jdHref || null,
    });
  });

  return items;
}

// Status index
app.get("/api/myspike/index/status", (req, res) => {
  const meta = loadMeta();
  res.json({ ok: true, meta });
});

// Build index secara batch (supaya tak timeout)
// Body: { fromPage: 1, toPage: 2 }  -> crawl pages 1..2, collect cpIds, extract CU, append
app.post("/api/myspike/index/build", async (req, res) => {
  try {
    const fromPage = Number(req.body?.fromPage || 1);
    const toPage = Number(req.body?.toPage || fromPage);

    let index = loadIndex();
    const meta = loadMeta();

    for (let p = fromPage; p <= toPage; p++) {
      const cpIds = await fetchNossListPage(p);

      for (const cpId of cpIds) {
        const cuItems = await fetchCuFromCpId(cpId);

        // append unik (berdasarkan cpId + cuTitle)
        for (const it of cuItems) {
          const key = `${it.cpId}::${it.cuTitle}`;
          const exists = index.some((x) => `${x.cpId}::${x.cuTitle}` === key);
          if (!exists) index.push(it);
        }
      }

      meta.lastPage = Math.max(meta.lastPage || 0, p);
    }

    meta.totalCU = index.length;
    meta.updatedAt = new Date().toISOString();
    saveIndex(index);
    saveMeta(meta);

    res.json({ ok: true, meta, addedTotalCU: index.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * =========================
 * Sessions store (pastikan wujud)
 * =========================
 * Jika dalam server.js Prof dah ada `sessions`, JANGAN duplicate.
 * Kalau belum ada, kekalkan ini.
 */

/**
 * Helper: pastikan session wujud
 */
function ensureSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cards: [],
    };
  }
  if (!Array.isArray(sessions[sessionId].cards)) sessions[sessionId].cards = [];
  return sessions[sessionId];
}

/**
 * Helper: ambil text kad (fallback pelbagai field)
 * Ini yang selesaikan isu "Semua card kosong".
 */
function getCardText(card) {
  return String(
    card?.activity ||
      card?.activityTitle ||
      card?.waTitle ||
      card?.title ||
      card?.text ||
      card?.name ||
      ""
  ).trim();
}

/**
 * =========================
 * Sistem 2 Bridge (Seed WA)
 * =========================
 * POST /api/s2/seed-wa
 * Body: { sessionId: "Masjid", waList: string[] }
 * Tujuan: Jadikan WA sebagai "kad sementara" dalam sessions[sessionId]
 */
app.post("/api/s2/seed-wa", (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    const waList = Array.isArray(req.body?.waList) ? req.body.waList : [];

    if (!sessionId) {
      return res.status(400).json({ ok: false, error: "sessionId diperlukan" });
    }
    if (!waList.length) {
      return res
        .status(400)
        .json({ ok: false, error: "waList mesti ada sekurang-kurangnya 1 item" });
    }

    const s = ensureSession(sessionId);

    let added = 0;
    for (const raw of waList) {
      const waTitle = String(raw || "").trim();
      if (!waTitle) continue;

      // elak duplicate berdasarkan waTitle
      const exists = s.cards.some(
        (c) => String(c?.waTitle || c?.activity || c?.title || "").trim() === waTitle
      );
      if (exists) continue;

      const id = Date.now() + Math.floor(Math.random() * 1000);

      // ✅ Simpan dalam beberapa field supaya mana-mana modul boleh baca
      s.cards.push({
        id,
        createdAt: new Date().toISOString(),
        source: "seed-wa",

        // Field utama
        waTitle,
        activity: waTitle,
        title: waTitle,
        text: waTitle,
      });

      added++;
    }

    s.updatedAt = new Date().toISOString();

    return res.json({ ok: true, sessionId, totalSeeded: added, totalCards: s.cards.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * =========================
 * Debug: List Cards by Session
 * =========================
 * GET /api/s2/cards?sessionId=Masjid
 */
app.get("/api/s2/cards", (req, res) => {
  try {
    const sessionId = String(req.query?.sessionId || "").trim();
    if (!sessionId) {
      return res.status(400).json({ ok: false, error: "sessionId diperlukan" });
    }

    const s = ensureSession(sessionId);
    const cards = Array.isArray(s.cards) ? s.cards : [];

    return res.json({
      ok: true,
      sessionId,
      totalCards: cards.length,
      sampleKeys: cards[0] ? Object.keys(cards[0]) : [],
      cardsPreview: cards.slice(0, 20), // cukup untuk semak, elak response besar
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * =========================
 * AI Cluster Preview
 * =========================
 * POST /api/cluster/preview
 * Body: { sessionId, similarityThreshold, minClusterSize }
 * Nota: Ini versi "minimal & selamat" — fokus buang isu card kosong.
 */
app.post("/api/cluster/preview", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    const similarityThreshold = Number(req.body?.similarityThreshold ?? 0.55);
    const minClusterSize = Number(req.body?.minClusterSize ?? 2);

    if (!sessionId) {
      return res.status(400).json({ ok: false, error: "sessionId diperlukan" });
    }

    const s = ensureSession(sessionId);
    const cards = Array.isArray(s.cards) ? s.cards : [];

    if (!cards.length) {
      return res.json({
        ok: true,
        sessionId,
        totalCards: 0,
        clusters: [],
        unassigned: [],
        meta: { note: "Tiada card dalam session." },
      });
    }

    // 1) Ambil text daripada kad
    const items = cards
      .map((c) => ({ id: c.id, text: getCardText(c) }))
      .filter((x) => x.text);

    if (!items.length) {
      return res.json({
        ok: true,
        sessionId,
        totalCards: cards.length,
        clusters: [],
        unassigned: cards.map((c) => c.id),
        meta: { note: "Semua card kosong (tiada activity/title/name/text)." },
      });
    }

    /**
     * 2) Clustering ringkas (baseline)
     * - Untuk sekarang: kita tak guna embedding dulu.
     * - Kita buat grouping berdasarkan keyword overlap ringkas.
     * - Lepas confirm flow, baru upgrade ke OpenAI embeddings / model.
     */
    function tokenize(t) {
      return String(t)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean);
    }
    function jaccard(a, b) {
      const A = new Set(a);
      const B = new Set(b);
      let inter = 0;
      for (const x of A) if (B.has(x)) inter++;
      const union = A.size + B.size - inter;
      return union ? inter / union : 0;
    }

    const tokens = items.map((it) => ({ ...it, tok: tokenize(it.text) }));
    const used = new Set();
    const clusters = [];

    for (let i = 0; i < tokens.length; i++) {
      if (used.has(tokens[i].id)) continue;

      const group = [tokens[i]];
      used.add(tokens[i].id);

      for (let j = i + 1; j < tokens.length; j++) {
        if (used.has(tokens[j].id)) continue;
        const sim = jaccard(tokens[i].tok, tokens[j].tok);
        if (sim >= similarityThreshold) {
          group.push(tokens[j]);
          used.add(tokens[j].id);
        }
      }

      if (group.length >= minClusterSize) {
        clusters.push({
          clusterId: `C${clusters.length + 1}`,
          cardIds: group.map((g) => g.id),
          sample: group.map((g) => g.text).slice(0, 5),
        });
      } else {
        // kalau tak cukup min size, keluarkan balik dari "used"
        for (const g of group) used.delete(g.id);
      }
    }

    const assignedIds = new Set(clusters.flatMap((c) => c.cardIds));
    const unassigned = cards.map((c) => c.id).filter((id) => !assignedIds.has(id));

    return res.json({
      ok: true,
      sessionId,
      totalCards: cards.length,
      clusters,
      unassigned,
      meta: {
        note:
          clusters.length
            ? "Preview clustering siap."
            : "Tiada cluster memenuhi threshold/minClusterSize. Cuba turunkan threshold atau tambah kad.",
        similarityThreshold,
        minClusterSize,
        usableTextCount: items.length,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * =========================
 * SISTEM 2: MySPIKE Comparator (REAL AI)
 * =========================
 */

function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function confidenceLabel(score) {
  if (score >= 0.85) return "HIGH";
  if (score >= 0.78) return "MEDIUM";
  if (score >= 0.70) return "LOW";
  return "NONE";
}

function buildCuText(cu) {
  const title = String(cu.cuTitle || "").trim();
  const code = String(cu.cuCode || "").trim();
  const acts = Array.isArray(cu.activities) ? cu.activities : [];
  const actTitles = acts
    .map((a) => String(a.waTitle || "").trim())
    .filter(Boolean)
    .join("; ");
  return `CU ${code}: ${title}\nAktiviti: ${actTitles}`.trim();
}

function buildMyspikeText(item) {
  const title = String(item.cuTitle || "").trim();
  const code = String(item.cuCode || "").trim();
  const desc = String(item.description || "").trim();
  return `MySPIKE CU ${code}: ${title}\nHuraian: ${desc}`.trim();
}

// In-memory cache
let MY_SPIKE_ITEMS = null;
let MY_SPIKE_EMB = null;
let MY_SPIKE_LOADED_AT = null;

function loadMyspikeSeed() {
  if (MY_SPIKE_ITEMS) return MY_SPIKE_ITEMS;
  const p = path.join(__dirname, "data", "myspike_cu_seed.json");
  const raw = fs.readFileSync(p, "utf8");
  MY_SPIKE_ITEMS = JSON.parse(raw);
  return MY_SPIKE_ITEMS;
}

async function ensureMyspikeEmbeddings({ model = "text-embedding-3-small" } = {}) {
  if (
    MY_SPIKE_ITEMS &&
    MY_SPIKE_EMB &&
    MY_SPIKE_ITEMS.length === MY_SPIKE_EMB.length
  ) {
    return;
  }
  const items = loadMyspikeSeed();
  const inputs = items.map(buildMyspikeText);

  const emb = await client.embeddings.create({
    model,
    input: inputs
  });

  MY_SPIKE_EMB = emb.data.map((d) => d.embedding);
  MY_SPIKE_LOADED_AT = new Date().toISOString();
}

/**
 * POST /api/s2/compare
 */
app.post("/api/s2/compare", async (req, res) => {
  try {
    const { sessionId, meta, cus, options } = req.body || {};
    const list = Array.isArray(cus) ? cus : [];

    if (!list.length) {
      return res
        .status(400)
        .json({ error: "cus kosong. Sila hantar sekurang-kurangnya 1 CU." });
    }

    const thresholdAda = Number(options?.thresholdAda ?? 0.78);
    const topK = Math.max(1, Math.min(10, Number(options?.topK ?? 3)));

    await ensureMyspikeEmbeddings({ model: "text-embedding-3-small" });
    const myItems = MY_SPIKE_ITEMS || [];
    const myEmb = MY_SPIKE_EMB || [];

    const cuTexts = list.map(buildCuText);
    const cuEmbRes = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: cuTexts
    });
    const cuEmb = cuEmbRes.data.map((d) => d.embedding);

    const results = list.map((cu, idx) => {
      const vec = cuEmb[idx];
      const scored = myItems.map((item, j) => {
        const score = cosineSimilarity(vec, myEmb[j]);
        return {
          docId: item.docId,
          cuCode: item.cuCode,
          cuTitle: item.cuTitle,
          score: Number(score.toFixed(4))
        };
      });

      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, topK);

      const best = top[0] ? top[0].score : 0;
      const conf = confidenceLabel(best);
      const status = best >= thresholdAda ? "ADA" : "TIADA";

      return {
        input: {
          cuCode: cu.cuCode,
          cuTitle: cu.cuTitle,
          activitiesCount: Array.isArray(cu.activities) ? cu.activities.length : 0
        },
        decision: {
          status,
          bestScore: best,
          confidence: conf,
          thresholdAda
        },
        matches: top
      };
    });

    return res.json({
      ok: true,
      sessionId: sessionId || meta?.sessionId || "unknown",
      meta: meta || {},
      myspike: {
        source: "seed",
        loadedAt: MY_SPIKE_LOADED_AT,
        totalCandidates: myItems.length,
        embeddingModel: "text-embedding-3-small"
      },
      summary: {
        totalCU: results.length,
        ada: results.filter((r) => r.decision.status === "ADA").length,
        tiada: results.filter((r) => r.decision.status === "TIADA").length
      },
      results,
      generatedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error("S2 compare error:", e);
    return res.status(500).json({
      error: "Gagal buat perbandingan MySPIKE",
      detail: String(e?.message || e)
    });
  }
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

/* ======================================================
 * COMPAT: /api/cards routes (untuk frontend baru)
 * - LiveBoard poll guna: GET /api/cards/:sessionId -> { ok:true, items:[...] }
 * - Panel submit guna: POST /api/cards/:sessionId -> { ok:true, item }
 * ====================================================== */

// GET: List cards by session (frontend expect {ok:true, items})
app.get("/api/cards/:sessionId", (req, res) => {
  const sid = String(req.params.sessionId || "").trim();
  const items = Array.isArray(sessions[sid]) ? sessions[sid] : [];
  return res.json({ ok: true, sessionId: sid, items });
});

// POST: Create new card for session (frontend panel submit)
app.post("/api/cards/:sessionId", (req, res) => {
  const sid = String(req.params.sessionId || "").trim();

  const name = String(req.body?.name || req.body?.activity || "").trim();
  const activity = String(req.body?.activity || name || "").trim();
  const panelName = String(req.body?.panelName || "").trim();

  if (!sid) return res.status(400).json({ ok: false, error: "Missing sessionId" });
  if (!name) return res.status(400).json({ ok: false, error: "Missing name/activity" });

  if (!sessions[sid]) sessions[sid] = [];

  const card = {
    id: Date.now(),
    name,
    activity,
    panelName,
    time: new Date().toISOString(),
  };

  sessions[sid].push(card);

  io.to(sid).emit("card:new", { session: sid, card });

  return res.json({ ok: true, item: card, card });
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

// =========================
// AI Helper: Generate CU Title
// =========================
async function aiGenerateCuTitle(items) {
  const prompt = `
Berikut ialah senarai aktiviti kerja masjid.
Cadangkan satu nama CU (Competency Unit) yang sesuai,
ringkas, profesional, dan bersifat NOSS.

Aktiviti:
- ${items.join("\n- ")}

Jawapan dalam 5–7 perkataan sahaja.
`;

  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: "Jawab dengan satu frasa sahaja." },
      { role: "user", content: prompt },
    ],
  });

  return res.choices[0].message.content.trim();
}

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

    const rawClusters = await Promise.all(
      valid.map(async (idxs, k) => {
    const clusterItems = idxs.map((i) => ({
      id: filtered[i].id,
      name: texts[i],
    }));

    const aiTitle = await aiGenerateCuTitle(clusterItems.map((x) => x.name));

    return {
      clusterId: `C${k + 1}`,
      title: aiTitle || keywordTitle(clusterItems.map((x) => x.name), 3),
      items: clusterItems,
    };
  })
);

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
      clusters: clustersWithSuggestedCU,
      unassigned,
    };

// =========================
// iNOSS: Suggest CU title (rule-based)
// =========================
const clustersWithSuggestedCU = (Array.isArray(clusters) ? clusters : []).map((cl) => {
  const cardIds = Array.isArray(cl.cardIds) ? cl.cardIds : [];

  const activities = cardIds
    .map((cid) => {
      const found = items.find((it) => it.id === cid);
      return found ? String(found.activity || found.name || "").trim() : "";
    })
    .filter(Boolean);

  const suggestedCU = suggestCUName(activities);

  return {
    ...cl,
    suggestedCU, // { title, verb, object, confidence, reasons }
  };
});
    
    // store for refresh
    clusterStore[sid] = result;

    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e?.message || "AI cluster run error" });
  }
});

// =========================
// iNOSS: Session summary (lightweight)
// =========================
app.get("/api/session/summary/:sessionId", (req, res) => {
  const sid = String(req.params.sessionId || "").trim();
  const items = Array.isArray(sessions[sid]) ? sessions[sid] : [];

  // kira assigned ikut field yang ada pada card (ikut struktur anda)
  // cuba beberapa kemungkinan: cuId, cuTitle, assignedCuId, cu
  const isAssigned = (c) =>
    !!(c && (c.cuId || c.cuTitle || c.assignedCuId || c.cu));

  const total = items.length;
  const assigned = items.filter(isAssigned).length;
  const unassigned = total - assigned;

  return res.json({
    ok: true,
    sessionId: sid,
    total,
    assigned,
    unassigned,
    updatedAt: new Date().toISOString(),
  });
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
 * =========================
 * Sistem 2 Bridge (Seed WA)
 * =========================
 * POST /api/s2/seed-wa
 * Body: { sessionId: "ANY_SESSION_ID", waList: string[] }
 * Tujuan: Jadikan WA dari Page 2.1 sebagai "kad sementara" dalam sessions[sessionId]
 */
app.post("/api/s2/seed-wa", (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    const waList = Array.isArray(req.body?.waList) ? req.body.waList : [];

    if (!sessionId) return res.status(400).json({ error: "sessionId diperlukan" });
    if (!waList.length) return res.status(400).json({ error: "waList kosong" });

    const now = Date.now();
    sessions[sessionId] = waList
      .map((wa, i) => String(wa || "").trim())
      .filter(Boolean)
      .map((wa, i) => ({
        id: now + i,
        wa,      // ini yang compare guna
        title: wa, // fallback
        source: "s2-seed",
      }));

    return res.json({
      ok: true,
      sessionId,
      totalSeeded: sessions[sessionId].length,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
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

/**
 * POST /api/myspike/compare
 * Body:
 * {
 *   sessionId?: string,
 *   threshold?: number,
 *   topK?: number,
 *   cuTitle?: string,          // optional: fokus domain CU (cth "Budget Management")
 *   urls?: string[]            // optional override DEFAULT_MYSPIKE_URLS
 * }
 */
app.post("/api/myspike/compare", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "dacum-demo").trim();

    const urls =
      Array.isArray(req.body?.urls) && req.body.urls.length
        ? req.body.urls
        : DEFAULT_MYSPIKE_URLS;

    // ✅ guna threshold dari request (UI)
    const threshold = Number.isFinite(Number(req.body?.threshold))
      ? Number(req.body.threshold)
      : 0.45;

    const topK = Number.isFinite(Number(req.body?.topK)) ? Number(req.body.topK) : 6;

    // optional: fokus domain CU (untuk elak "lari" ke domain lain)
    const cuTitle = String(req.body?.cuTitle || "").trim();

    // =========================
    // 1) Ambil DACUM WA (seed/label)
    // =========================
    const sessionCards = sessions[sessionId] || [];

    // buang ayat panjang/“hasil pembelajaran...” supaya similarity tak rosak
    const stripNoiseWA = (s) => {
      const t = String(s || "").trim();
      if (!t) return "";

      const lower = t.toLowerCase();

      // buang baris "hasil pembelajaran..." (biasa muncul dalam MySPIKE)
      if (
        lower.includes("hasil pembelajaran unit kompetensi") ||
        lower.includes("akhir pembelajaran unit kompetensi") ||
        lower.includes("pelatih hendaklah terampil")
      ) {
        return "";
      }

      // buang yang terlalu panjang (selalunya bukan WA, tapi deskripsi)
      if (t.length > 180) return "";

      return t;
    };

    const dacumWA = sessionCards
      .map((c) => {
        // WA sebenar (seed / label)
        if (c?.wa) return stripNoiseWA(c.wa);

        // fallback demo
        if (c?.title) return stripNoiseWA(c.title);

        // fallback lama (kurangkan penggunaan; boleh jadi noise)
        if (c?.text) return stripNoiseWA(c.text);

        return "";
      })
      .filter(Boolean);

    if (!dacumWA.length) {
      return res.status(400).json({
        error:
          "Tiada WA dalam session ini. Pastikan anda sudah 'seed WA' dari Sistem 2 atau label kad DACUM (field wa).",
        hint: { sessionId, totalCardsInSession: sessionCards.length },
      });
    }

    // =========================
    // 2) Ambil MySPIKE WA (cache)
    // =========================
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

    // kumpul semua WA dari semua CP
    const myspikeWAAll = [];
    for (const item of items) for (const w of item.wa || []) myspikeWAAll.push(w);

    // =========================
    // 3) Dedupe + optional filter ikut CU title
    // =========================
    const dedupeList = (arr) => {
      const out = [];
      const seen = new Set();
      for (const x of arr) {
        const cleaned = stripNoiseWA(x);
        if (!cleaned) continue;

        const n = normalizeText(cleaned);
        if (!n || seen.has(n)) continue;

        seen.add(n);
        out.push(String(cleaned).trim());
      }
      return out;
    };

    let myspikeList = dedupeList(myspikeWAAll);
    const dacumList = dedupeList(dacumWA);

    // ✅ FILTER DOMAIN: bila cuTitle diberi, tapis WA MySPIKE yang ada kaitan
    // (heuristik: cari perkataan kunci dalam cuTitle, ambil token >=4 huruf)
    if (cuTitle) {
      const tokens = normalizeText(cuTitle)
        .split(" ")
        .map((x) => x.trim())
        .filter((x) => x.length >= 4);

      if (tokens.length) {
        const before = myspikeList.length;
        myspikeList = myspikeList.filter((w) => {
          const nw = normalizeText(w);
          return tokens.some((tk) => nw.includes(tk));
        });

        // jika terlalu ketat sampai kosong, fallback semula supaya UI tak “kosong”
        if (!myspikeList.length) {
          myspikeList = dedupeList(myspikeWAAll);
        }

        // optional: tambah info debug kecil
        // console.log("CU filter", cuTitle, tokens, before, myspikeList.length);
      }
    }

    // =========================
    // 4) Compare: MySPIKE WA vs DACUM WA (best match)
    // =========================
    const matches = [];
    const missingInDacum = [];

    // simpan topK terbaik (bukan 1 sahaja)
    const bestMatches = (mw) => {
      const scored = dacumList.map((dw) => ({
        dw,
        score: jaccardSimilarity(mw, dw),
      }));
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, Math.max(1, topK));
    };

    for (const mw of myspikeList) {
      const top = bestMatches(mw);
      const best = top[0] || { score: -1, dw: null };

      if (best.score >= threshold) {
        matches.push({
          myspikeWA: mw,
          bestDacumWA: best.dw,
          score: Number(best.score.toFixed(3)),
          topK: top.map((x) => ({
            dacumWA: x.dw,
            score: Number(x.score.toFixed(3)),
          })),
        });
      } else {
        missingInDacum.push({
          myspikeWA: mw,
          bestDacumWA: best.dw,
          score: Number(best.score.toFixed(3)),
          topK: top.map((x) => ({
            dacumWA: x.dw,
            score: Number(x.score.toFixed(3)),
          })),
        });
      }
    }

    // extra: WA yang DACUM ada tapi MySPIKE tak padan (ikut threshold)
    const matchedDacumNorm = new Set(
      matches.map((m) => normalizeText(m.bestDacumWA || ""))
    );
    const extraInDacum = dacumList.filter(
      (dw) => !matchedDacumNorm.has(normalizeText(dw))
    );

    // =========================
    // 5) Response
    // =========================
    return res.json({
      sessionId,
      threshold,
      topK,
      cuTitle: cuTitle || null,
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
