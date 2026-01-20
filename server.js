/**
 * server.js — iNOSS Backend (CLEAN)
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
 * 3) AI CLUSTER (REAL)
 * ====================================================== */

app.get("/api/cluster/result/:sessionId", (req, res) => {
  const sid = String(req.params.sessionId || "").trim();
  const data = clusterStore[sid];
  if (!data) return res.status(404).json({ error: "Tiada cluster result untuk session ini" });
  return res.json(data);
});

app.get("/api/session/summary/:sessionId", (req, res) => {
  const sid = String(req.params.sessionId || "").trim();
  const items = getSessionCards(sid);

  const isAssigned = (c) => !!(c && (c.cuId || c.cuTitle || c.assignedCuId || c.cu));
  const total = items.length;
  const assigned = items.filter(isAssigned).length;
  const unassigned = total - assigned;

  return res.json({ ok: true, sessionId: sid, total, assigned, unassigned, updatedAt: new Date().toISOString() });
});

// Preview (lite)
app.post("/api/cluster/preview", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    const similarityThreshold = Number(req.body?.similarityThreshold ?? 0.55);
    const minClusterSize = Number(req.body?.minClusterSize ?? 2);

    if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId diperlukan" });

    const cards = getSessionCards(sessionId);
    if (!cards.length) {
      return res.json({ ok: true, sessionId, totalCards: 0, clusters: [], unassigned: [], meta: { note: "Tiada card dalam session." } });
    }

    const items = cards.map((c) => ({ id: c.id, text: getCardText(c) })).filter((x) => x.text);
    if (!items.length) {
      return res.json({ ok: true, sessionId, totalCards: cards.length, clusters: [], unassigned: cards.map((c) => c.id), meta: { note: "Semua card kosong." } });
    }

    function tokenize(t) {
      return String(t).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
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
    try { parsed = JSON.parse(raw); } catch { parsed = null; }

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

/* ======================================================
 * 4) SISTEM 2 Bridge (Seed WA)
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
 * 5) MySPIKE REAL CU INDEX
 * (kekal seperti code Prof)
 * ====================================================== */

// >>>> kekalkan semua fungsi MySPIKE Prof dari sini sampai debug/openai
// (Saya tak ubah bahagian panjang itu — Prof boleh paste semula blok MySPIKE yang Prof dah ada)

// --- PASTE BLOK MYSPIKE PROF DI SINI ---

/* =========================
 * SERVER START (PALING BAWAH)
 * ========================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("🚀 Server listening on", PORT);
});
