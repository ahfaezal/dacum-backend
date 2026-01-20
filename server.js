/**
 * server.js — iNOSS Backend (FINAL CLEAN)
 * Fokus:
 * 1) DACUM Cards + LiveBoard (Socket.IO + REST)
 * 2) AI Clustering (REAL) -> /api/cluster/run + /api/cluster/result/:sessionId
 * 3) MySPIKE REAL CU Index (crawl NOSS->CPC->JD)
 * 4) MySPIKE AI Comparator (Embeddings) guna index REAL
 *
 * Prinsip:
 * - sessions berbentuk OBJECT: { sessionId, cards: [] }
 * - Semua endpoint cards guna helper getSessionCards()
 * - server+io dideclare awal (sebelum io digunakan)
 * - server.listen di bawah sekali (Render friendly)
 */

const express = require("express");
const http = require("http");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

// ===== OpenAI SDK v4 =====
const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================
 * APP + MIDDLEWARE
 * ========================= */
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

/* =========================
 * SERVER + SOCKET (MESTI DI ATAS)
 * ========================= */
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/* =========================
 * HEALTH + ROOT
 * ========================= */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "dacum-backend",
    time: new Date().toISOString(),
  });
});

app.get("/", (req, res) => res.send("iNOSS Backend OK"));

/* ======================================================
 * 0) SESSIONS (CANONICAL)
 * ====================================================== */
const sessions = {}; // { [sessionId]: { sessionId, createdAt, updatedAt, cards: [] } }
const clusterStore = {}; // { [sessionId]: last cluster result }

function ensureSession(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return null;

  if (!sessions[sid]) {
    sessions[sid] = {
      sessionId: sid,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cards: [],
    };
  }
  if (!Array.isArray(sessions[sid].cards)) sessions[sid].cards = [];
  return sessions[sid];
}

function getSessionCards(sessionId) {
  const s = ensureSession(sessionId);
  return s ? s.cards : [];
}

function setSessionCards(sessionId, newCardsArray) {
  const s = ensureSession(sessionId);
  if (!s) return;
  s.cards = Array.isArray(newCardsArray) ? newCardsArray : [];
  s.updatedAt = new Date().toISOString();
}

function getCardText(card) {
  return String(
    card?.activity ||
      card?.activityTitle ||
      card?.waTitle ||
      card?.wa ||
      card?.title ||
      card?.text ||
      card?.name ||
      ""
  ).trim();
}

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
});

/* ======================================================
 * 1) CARDS API (LiveBoard)
 * ====================================================== */

// Legacy routes
app.get("/cards/:session", (req, res) => {
  const sid = String(req.params.session || "").trim();
  return res.json(getSessionCards(sid));
});

app.post("/cards/:session", (req, res) => {
  const sid = String(req.params.session || "").trim();
  const { name, activity } = req.body || {};

  const nm = String(name || "").trim();
  const act = String(activity || "").trim();
  if (!sid || !nm || !act) {
    return res.status(400).json({ success: false, error: "session, name & activity required" });
  }

  const card = {
    id: Date.now(),
    name: nm,
    activity: act,
    time: new Date().toISOString(),
  };

  const cards = getSessionCards(sid);
  cards.push(card);

  io.to(sid).emit("card:new", { session: sid, card });
  return res.json({ success: true, card });
});

app.patch("/cards/:session/:id", (req, res) => {
  try {
    const sid = String(req.params.session || "").trim();
    const id = String(req.params.id || "").trim();
    const { cu, wa } = req.body || {};

    if (!sid || !id) return res.status(400).json({ success: false, error: "session & id required" });

    const cards = getSessionCards(sid);
    const idx = cards.findIndex((c) => String(c.id) === id);
    if (idx === -1) return res.status(404).json({ success: false, error: "card not found" });

    cards[idx] = {
      ...cards[idx],
      cu: String(cu || cards[idx].cu || "").trim(),
      wa: String(wa || cards[idx].wa || "").trim(),
      updatedAt: new Date().toISOString(),
    };

    io.to(sid).emit("card:update", { session: sid, card: cards[idx] });
    return res.json({ success: true, card: cards[idx] });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// Frontend baru (compat)
app.get("/api/cards/:sessionId", (req, res) => {
  const sid = String(req.params.sessionId || "").trim();
  const items = getSessionCards(sid);
  return res.json({ ok: true, sessionId: sid, items });
});

app.post("/api/cards/:sessionId", (req, res) => {
  const sid = String(req.params.sessionId || "").trim();
  if (!sid) return res.status(400).json({ ok: false, error: "Missing sessionId" });

  const name = String(req.body?.name || req.body?.activity || "").trim();
  const activity = String(req.body?.activity || name || "").trim();
  const panelName = String(req.body?.panelName || "").trim();

  if (!name) return res.status(400).json({ ok: false, error: "Missing name/activity" });

  const card = {
    id: Date.now(),
    name,
    activity,
    panelName,
    time: new Date().toISOString(),
  };

  const items = getSessionCards(sid);
  items.push(card);

  io.to(sid).emit("card:new", { session: sid, card });
  return res.json({ ok: true, item: card, card });
});

// Debug cards
app.get("/api/s2/cards", (req, res) => {
  try {
    const sessionId = String(req.query?.sessionId || "").trim();
    if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId diperlukan" });

    const cards = getSessionCards(sessionId);
    return res.json({
      ok: true,
      sessionId,
      totalCards: cards.length,
      sampleKeys: cards[0] ? Object.keys(cards[0]) : [],
      cardsPreview: cards.slice(0, 20),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ======================================================
 * 2) AI CLUSTER (REAL)
 * ====================================================== */

// Get last result
app.get("/api/cluster/result/:sessionId", (req, res) => {
  const sid = String(req.params.sessionId || "").trim();
  const data = clusterStore[sid];
  if (!data) return res.status(404).json({ error: "Tiada cluster result untuk session ini" });
  return res.json(data);
});

// Session summary
app.get("/api/session/summary/:sessionId", (req, res) => {
  const sid = String(req.params.sessionId || "").trim();
  const items = getSessionCards(sid);

  const isAssigned = (c) => !!(c && (c.cuId || c.cuTitle || c.assignedCuId || c.cu));
  const total = items.length;
  const assigned = items.filter(isAssigned).length;
  const unassigned = total - assigned;

  return res.json({ ok: true, sessionId: sid, total, assigned, unassigned, updatedAt: new Date().toISOString() });
});

// Debug: lihat cus dalam session (hasil Apply AI)
app.get("/api/session/cus/:sessionId", (req, res) => {
  const sid = String(req.params.sessionId || "").trim();
  const s = ensureSession(sid);
  return res.json({
    ok: true,
    sessionId: sid,
    cus: s?.cus || [],
    appliedAt: s?.appliedAt || null,
  });
});

// Preview clustering (lite) – tanpa OpenAI
app.post("/api/cluster/preview", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    const similarityThreshold = Number(req.body?.similarityThreshold ?? 0.55);
    const minClusterSize = Number(req.body?.minClusterSize ?? 2);

    if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId diperlukan" });

    const cards = getSessionCards(sessionId);
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

    const items = cards.map((c) => ({ id: c.id, text: getCardText(c) })).filter((x) => x.text);
    if (!items.length) {
      return res.json({
        ok: true,
        sessionId,
        totalCards: cards.length,
        clusters: [],
        unassigned: cards.map((c) => c.id),
        meta: { note: "Semua card kosong." },
      });
    }

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
      meta: { similarityThreshold, minClusterSize, usableTextCount: items.length },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// REAL cluster RUN (OpenAI)
app.post("/api/cluster/run", async (req, res) => {
  try {
    const sid = String(req.body?.sessionId || "").trim();
    if (!sid) return res.status(400).json({ error: "sessionId diperlukan" });

    const items = getSessionCards(sid);
    if (items.length < 5) return res.status(400).json({ error: "Terlalu sedikit kad untuk clustering (min 5)" });

    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY belum diset" });

    const cards = items
      .map((c) => ({ id: c.id, activity: getCardText(c) }))
      .filter((c) => c.activity);

    if (cards.length < 5) return res.status(400).json({ error: "Terlalu sedikit kad yang ada teks (min 5)" });

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
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }

    if (!parsed || !Array.isArray(parsed.clusters)) {
      return res.status(500).json({ error: "Output AI tidak sah", raw });
    }

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

    clusterStore[sid] = result;
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e?.message || "AI cluster run error" });
  }
});

/**
 * Apply AI Cluster result -> simpan sebagai CU/WA dalam session (cus[])
 * POST /api/cluster/apply
 * Body: { sessionId: "..." }
 */
app.post("/api/cluster/apply", (req, res) => {
  try {
    const sid = String(req.body?.sessionId || "").trim();
    if (!sid) return res.status(400).json({ ok: false, error: "sessionId diperlukan" });

    const last = clusterStore[sid];
    if (!last || !Array.isArray(last.clusters) || !last.clusters.length) {
      return res.status(400).json({
        ok: false,
        error: "Tiada cluster result. Sila run /api/cluster/run dahulu.",
      });
    }

    const sess = ensureSession(sid);
    const cards = getSessionCards(sid);
    const byId = new Map(cards.map((c) => [String(c.id), c]));

    // bina CU/WA dari clusters
    const cus = last.clusters.map((cl, i) => {
      const cuId = `CU-${String(i + 1).padStart(2, "0")}`;
      const cuTitle = String(cl?.title || `CU ${i + 1}`).trim();

      const cardIds = Array.isArray(cl?.cardIds) ? cl.cardIds : [];
      const activities = cardIds.map((id, j) => {
        const card = byId.get(String(id));
        const waTitle = (card && getCardText(card)) || `Aktiviti ${j + 1}`;
        return {
          waId: `WA-${String(j + 1).padStart(2, "0")}`,
          waTitle,
          cardIds: [id],
        };
      });

      return { cuId, cuTitle, activities };
    });

    // simpan dalam session supaya frontend boleh guna (MySPIKE compare, export, dll)
    sess.cus = cus;
    sess.appliedAt = new Date().toISOString();
    sess.updatedAt = new Date().toISOString();

    // Optional: tandakan cards dengan cuTitle (supaya summary/assigned boleh reflect)
    // Ini membantu kalau UI baca assigned daripada card.cu / card.cuTitle
    const cuByCardId = new Map();
    cus.forEach((cu) => {
      cu.activities.forEach((wa) => {
        (wa.cardIds || []).forEach((cid) => cuByCardId.set(String(cid), cu.cuTitle));
      });
    });

    cards.forEach((c) => {
      const t = cuByCardId.get(String(c.id));
      if (t) c.cuTitle = t; // minimal tagging
    });

    return res.json({
      ok: true,
      sessionId: sid,
      cusCount: cus.length,
      appliedAt: sess.appliedAt,
      sampleCu: cus[0] || null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ======================================================
 * 3) SISTEM 2 Bridge (Seed WA)
 * ====================================================== */
app.post("/api/s2/seed-wa", (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    const waList = Array.isArray(req.body?.waList) ? req.body.waList : [];

    if (!sessionId) return res.status(400).json({ error: "sessionId diperlukan" });
    if (!waList.length) return res.status(400).json({ error: "waList kosong" });

    const now = Date.now();
    const cards = waList
      .map((wa) => String(wa || "").trim())
      .filter(Boolean)
      .map((wa, i) => ({
        id: now + i,
        activity: wa,
        wa,
        title: wa,
        source: "s2-seed",
        time: new Date().toISOString(),
      }));

    setSessionCards(sessionId, cards);
    return res.json({ ok: true, sessionId, totalSeeded: cards.length });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ======================================================
 * 4) MySPIKE REAL CU INDEX
 * ====================================================== */
const DATA_DIR = path.join(__dirname, "data");
const INDEX_FILE = path.join(DATA_DIR, "myspike_cu_index.json");
const META_FILE = path.join(DATA_DIR, "myspike_cu_index.meta.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadCuIndex() {
  ensureDataDir();
  if (!fs.existsSync(INDEX_FILE)) return [];
  return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
}

function saveCuIndex(items) {
  ensureDataDir();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(items, null, 2), "utf8");
}

function loadCuMeta() {
  ensureDataDir();
  if (!fs.existsSync(META_FILE)) {
    return { lastPage: 0, totalCU: 0, updatedAt: null, note: "empty" };
  }
  return JSON.parse(fs.readFileSync(META_FILE, "utf8"));
}

function saveCuMeta(meta) {
  ensureDataDir();
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), "utf8");
}

function norm(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function absUrl(href) {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return "https://www.myspike.my" + href;
  if (href.startsWith("index.php")) return "https://www.myspike.my/" + href;
  return "https://www.myspike.my/" + href.replace(/^\.\//, "");
}

async function fetchHtml(url) {
  const res = await axios.get(url, {
    timeout: 30000,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; iNOSSBot/1.0)",
      "Accept-Language": "ms-MY,ms;q=0.9,en;q=0.8",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  return String(res.data || "");
}

// NOSS list page -> extract CPC ids
async function fetchNossListPage(page = 1) {
  const url = `https://www.myspike.my/index.php?r=umum-noss%2Findex-noss&page=${Number(page) || 1}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const cpIds = new Set();
  $("a[href*='r=umum-noss%2Findex-cp']").each((_, a) => {
    const href = $(a).attr("href") || "";
    const full = absUrl(href);
    const m = full.match(/[?&]id=(\d+)/);
    if (m) cpIds.add(String(m[1]));
  });

  return { url, cpIds: Array.from(cpIds) };
}

// CPC page -> extract JD links
async function fetchJdLinksFromCpId(cpId) {
  const url = `https://www.myspike.my/index.php?r=umum-noss%2Findex-cp&id=${cpId}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const readFieldFromTable = (labelRegex) => {
    let val = "";
    $("tr").each((_, tr) => {
      const tds = $(tr).find("td,th");
      if (tds.length < 2) return;
      const left = norm($(tds[0]).text());
      const right = norm($(tds[1]).text());
      if (labelRegex.test(left) && right) val = right;
    });
    return val;
  };

  const nossCode = readFieldFromTable(/Kod\s*NOSS/i);
  const nossTitle = readFieldFromTable(/Nama\s*NOSS/i);

  const jdLinks = new Map(); // jdId -> {jdId, jdUrl, anchorText}
  $("a[href]").each((_, a) => {
    const hrefRaw = $(a).attr("href") || "";
    const full = absUrl(hrefRaw);

    const m =
      full.match(/r=umum-noss(?:%2F|\/)view&?id=(\d+)/i) ||
      full.match(/[?&]id=(\d+)/);

    if (!m) return;
    if (!/umum-noss(?:%2F|\/)view/i.test(full)) return;

    const jdId = String(m[1]);
    const anchorText = norm($(a).text());
    if (!jdLinks.has(jdId)) {
      jdLinks.set(jdId, { jdId, jdUrl: full, anchorText: anchorText || "" });
    }
  });

  return {
    cpId: String(cpId),
    url,
    nossCode,
    nossTitle,
    jdLinks: Array.from(jdLinks.values()),
  };
}

// JD page -> extract Kod CU + Tajuk CU + Penerangan CU
async function fetchCuFromJd(jdId) {
  const url = `https://www.myspike.my/index.php?r=umum-noss%2Fview&id=${jdId}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const out = {
    jdId: String(jdId),
    jdUrl: url,
    cuCode: "",
    cuTitle: "",
    cuDesc: "",
    programName: "",
    nossCode: "",
    source: "myspike",
  };

  const readField = (labelRegex) => {
    let val = "";
    $("tr").each((_, tr) => {
      const tds = $(tr).find("td,th");
      if (tds.length < 2) return;

      const left = norm($(tds[0]).text());
      if (!labelRegex.test(left)) return;

      const rightCell = $(tds[1]);

      const li = rightCell.find("li");
      if (li.length) {
        const parts = [];
        li.each((__, x) => {
          const t = norm($(x).text());
          if (t) parts.push(t);
        });
        if (parts.length) {
          val = parts.join(" | ");
          return;
        }
      }

      const right = norm(rightCell.text());
      if (right) val = right;
    });

    return val;
  };

  out.cuCode = readField(/Kod\s*CU|CU\s*Code/i);
  out.cuTitle = readField(/Tajuk\s*CU|CU\s*Title/i);
  out.cuDesc = readField(/Penerangan\s*CU|CU\s*Description/i);

  out.programName = readField(/Nama\s*Program|Program\s*Name/i);
  const nossMaybe = readField(/Kod\s*NOSS|NOSS\s*Code/i);
  out.nossCode = nossMaybe || out.nossCode;

  if (!out.cuCode) {
    const bodyText = norm($("body").text());
    const m =
      bodyText.match(/([A-Z]{2,4}-\d{3,4}-\d:\d{4}-C\d{2})/i) ||
      bodyText.match(/([A-Z]{2,4}-\d{3,4}-\d:\d{4}-C\d)/i);
    if (m) out.cuCode = norm(m[1]);
  }

  if (!out.cuTitle) {
    out.cuTitle = norm($("h1").first().text()) || norm($("title").text());
  }

  out.cuCode = norm(out.cuCode);
  out.cuTitle = norm(out.cuTitle);
  out.cuDesc = norm(out.cuDesc);

  return out;
}

// Status index
app.get("/api/myspike/index/status", (req, res) => {
  const meta = loadCuMeta();
  res.json({ ok: true, meta });
});

// Build index batch
app.post("/api/myspike/index/build", async (req, res) => {
  try {
    const fromPage = Number(req.body?.fromPage || 1);
    const toPage = Number(req.body?.toPage || fromPage);

    let index = loadCuIndex();
    const meta = loadCuMeta();

    let added = 0;
    for (let p = fromPage; p <= toPage; p++) {
      const { cpIds } = await fetchNossListPage(p);

      for (const cpId of cpIds) {
        const cp = await fetchJdLinksFromCpId(cpId);

        for (const jd of cp.jdLinks) {
          const cu = await fetchCuFromJd(jd.jdId);

          if (!cu.cuTitle) continue;

          const exists = index.some((x) => String(x.cuCode) === String(cu.cuCode));
          if (exists) continue;

          index.push({
            ...cu,
            cpId: cp.cpId,
            cpUrl: cp.url,
            nossCode_fromCPC: cp.nossCode,
            nossTitle_fromCPC: cp.nossTitle,
            indexedAt: new Date().toISOString(),
          });
          added++;
        }
      }

      meta.lastPage = Math.max(meta.lastPage || 0, p);
    }

    meta.totalCU = index.length;
    meta.updatedAt = new Date().toISOString();
    meta.note = "REAL CU INDEX (from JD)";

    saveCuIndex(index);
    saveCuMeta(meta);

    res.json({ ok: true, fromPage, toPage, added, meta });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Search CU dalam index (real)
app.post("/api/myspike/cu/search", (req, res) => {
  try {
    const q = norm(req.body?.q || "").toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(req.body?.limit || 50)));

    const index = loadCuIndex();
    if (!q) return res.json({ ok: true, q, totalIndexed: index.length, hits: [] });

    const hits = index
      .map((cu) => {
        const hay = `${cu.cuCode} ${cu.cuTitle} ${cu.cuDesc}`.toLowerCase();
        const score =
          (String(cu.cuTitle || "").toLowerCase().includes(q) ? 3 : 0) +
          (String(cu.cuDesc || "").toLowerCase().includes(q) ? 2 : 0) +
          (String(cu.cuCode || "").toLowerCase().includes(q) ? 1 : 0) +
          (hay.includes(q) ? 1 : 0);
        return { cu, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.cu);

    return res.json({ ok: true, q, totalIndexed: index.length, hits });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ======================================================
 * 5) MySPIKE Comparator (REAL AI)
 * ====================================================== */

function cosineSimilarity(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
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
  if (score >= 0.7) return "LOW";
  return "NONE";
}

function buildCuText(cu) {
  const title = String(cu.cuTitle || cu.title || "").trim();
  const code = String(cu.cuCode || cu.code || "").trim();
  const acts = Array.isArray(cu.activities) ? cu.activities : [];
  const actTitles = acts
    .map((a) => String(a.waTitle || a.title || "").trim())
    .filter(Boolean)
    .join("; ");
  return `CU ${code}: ${title}\nAktiviti: ${actTitles}`.trim();
}

function buildMyspikeCuText(item) {
  const title = String(item.cuTitle || "").trim();
  const code = String(item.cuCode || "").trim();
  const desc = String(item.cuDesc || "").trim();
  return `MySPIKE CU ${code}: ${title}\nHuraian: ${desc}`.trim();
}

// In-memory embeddings cache (MVP)
let MYSPIKE_CU_ITEMS = null;
let MYSPIKE_CU_EMB = null;
let MYSPIKE_CU_LOADED_AT = null;

async function ensureMyspikeCuEmbeddings({ model = "text-embedding-3-small" } = {}) {
  const items = loadCuIndex();
  if (!items.length) {
    MYSPIKE_CU_ITEMS = [];
    MYSPIKE_CU_EMB = [];
    MYSPIKE_CU_LOADED_AT = new Date().toISOString();
    return;
  }

  if (MYSPIKE_CU_ITEMS && MYSPIKE_CU_EMB && MYSPIKE_CU_ITEMS.length === items.length) return;

  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY belum diset");

  const inputs = items.map(buildMyspikeCuText);

  const batchSize = 200;
  const allEmb = [];
  for (let i = 0; i < inputs.length; i += batchSize) {
    const batch = inputs.slice(i, i + batchSize);
    const emb = await client.embeddings.create({ model, input: batch });
    for (const d of emb.data) allEmb.push(d.embedding);
  }

  MYSPIKE_CU_ITEMS = items;
  MYSPIKE_CU_EMB = allEmb;
  MYSPIKE_CU_LOADED_AT = new Date().toISOString();
}

/**
 * POST /api/s2/compare
 */
app.post("/api/s2/compare", async (req, res) => {
  try {
    const { sessionId, cus, options, meta } = req.body || {};
    const list = Array.isArray(cus) ? cus : [];

    if (!list.length) {
      return res.status(400).json({ error: "cus kosong. Sila hantar sekurang-kurangnya 1 CU." });
    }

    const thresholdAda = Number(options?.thresholdAda ?? 0.78);
    const topK = Math.max(1, Math.min(10, Number(options?.topK ?? 3)));

    await ensureMyspikeCuEmbeddings({ model: "text-embedding-3-small" });

    const myItems = MYSPIKE_CU_ITEMS || [];
    const myEmb = MYSPIKE_CU_EMB || [];

    if (!myItems.length) {
      return res.status(400).json({
        error: "Index MySPIKE CU masih kosong. Sila bina index dulu: POST /api/myspike/index/build",
      });
    }

    const cuTexts = list.map(buildCuText);
    const cuEmbRes = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: cuTexts,
    });
    const cuEmb = cuEmbRes.data.map((d) => d.embedding);

    const results = list.map((cu, idx) => {
      const vec = cuEmb[idx];

      const scored = myItems.map((item, j) => {
        const score = cosineSimilarity(vec, myEmb[j]);
        return { cuCode: item.cuCode, cuTitle: item.cuTitle, score: Number(score.toFixed(4)) };
      });

      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, topK);

      const best = top[0] ? top[0].score : 0;
      const conf = confidenceLabel(best);
      const status = best >= thresholdAda ? "ADA" : "TIADA";

      return {
        input: {
          cuCode: cu.cuCode || "",
          cuTitle: cu.cuTitle || cu.title || "",
          activitiesCount: Array.isArray(cu.activities) ? cu.activities.length : 0,
        },
        decision: { status, bestScore: best, confidence: conf, thresholdAda },
        matches: top,
      };
    });

    return res.json({
      ok: true,
      sessionId: sessionId || meta?.sessionId || "unknown",
      meta: meta || {},
      myspike: {
        source: "REAL_INDEX",
        loadedAt: MYSPIKE_CU_LOADED_AT,
        totalCandidates: myItems.length,
        embeddingModel: "text-embedding-3-small",
      },
      summary: {
        totalCU: results.length,
        ada: results.filter((r) => r.decision.status === "ADA").length,
        tiada: results.filter((r) => r.decision.status === "TIADA").length,
      },
      results,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("S2 compare error:", e);
    return res.status(500).json({
      error: "Gagal buat perbandingan MySPIKE",
      detail: String(e?.message || e),
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

    return res.json({ ok: true, embedding_dim: r.data?.[0]?.embedding?.length || null });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e?.message || "OpenAI debug error",
      detail: e?.response?.data || null,
    });
  }
});

/* =========================
 * SERVER START (PALING BAWAH)
 * ========================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("🚀 Server listening on", PORT);
});
