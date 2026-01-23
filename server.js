/**
 * server.js — iNOSS Backend (FINAL CLEAN + SAFE)
 * Fokus:
 * 1) DACUM Cards + LiveBoard (Socket.IO + REST)
 * 2) AI Clustering (REAL) -> /api/cluster/run + /api/cluster/result/:sessionId + /api/cluster/apply
 * 3) CPC builder -> /api/cpc/:sessionId (returns units + cus alias)
 * 4) CP Builder (LOCKED) -> /api/cp/draft, /api/cp/:sessionId/:cuId, /api/cp/validate, /api/cp/lock, /api/cp/export
 * 5) MySPIKE REAL CU Index (crawl NOSS->CPC->JD)
 * 6) MySPIKE AI Comparator (Embeddings) guna index REAL
 *
 * Prinsip:
 * - server+io dideclare awal (sebelum io digunakan)
 * - server.listen PALING BAWAH (Render friendly)
 * - Elak duplicate endpoint (terutama /api/cp/draft)
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
const sessions = {}; // { [sessionId]: { sessionId, createdAt, updatedAt, cards: [], lang, langLocked, lockedAt, cus?, appliedAt? } }
const clusterStore = {}; // { [sessionId]: last cluster result }

/** util */
function nowISO() {
  return new Date().toISOString();
}
function ensureSession(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return null;

  if (!sessions[sid]) {
    sessions[sid] = {
      sessionId: sid,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      cards: [],
      lang: "MS",        // "MS" | "EN"
      langLocked: false, // lock bila run cluster / agreed
      lockedAt: null,
      terasTitle: "Pengurusan & Pengimarahan Masjid",
      cus: [],           // optional (hasil apply cluster)
      appliedAt: null,
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
  s.updatedAt = nowISO();
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
    time: nowISO(),
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
    const { cu, wa, cuTitle } = req.body || {};

    if (!sid || !id) return res.status(400).json({ success: false, error: "session & id required" });

    const cards = getSessionCards(sid);
    const idx = cards.findIndex((c) => String(c.id) === id);
    if (idx === -1) return res.status(404).json({ success: false, error: "card not found" });

    cards[idx] = {
      ...cards[idx],
      cu: String(cu || cards[idx].cu || "").trim(),
      cuTitle: String(cuTitle || cards[idx].cuTitle || cards[idx].cu || "").trim(),
      wa: String(wa || cards[idx].wa || "").trim(),
      updatedAt: nowISO(),
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
    time: nowISO(),
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
 * 2) SESSION CONFIG (LANG)
 * ====================================================== */
app.get("/api/session/config/:sessionId", (req, res) => {
  const sid = String(req.params.sessionId || "").trim();
  const s = ensureSession(sid);
  if (!s) return res.status(400).json({ ok: false, error: "sessionId tidak sah" });

  return res.json({
    ok: true,
    sessionId: sid,
    lang: String(s.lang || "MS").toUpperCase(),
    langLocked: !!s.langLocked,
    lockedAt: s.lockedAt || null,
  });
});

app.post("/api/session/config/:sessionId", (req, res) => {
  const sid = String(req.params.sessionId || "").trim();
  const s = ensureSession(sid);
  if (!s) return res.status(400).json({ ok: false, error: "sessionId tidak sah" });

  if (s.langLocked) {
    return res.status(400).json({ ok: false, error: "Bahasa sudah dikunci selepas Agreed/Run Cluster." });
  }

  const lang = String(req.body?.lang || "").toUpperCase().trim();
  if (!["MS", "EN"].includes(lang)) return res.status(400).json({ ok: false, error: "lang mesti 'MS' atau 'EN'." });

  s.lang = lang;
  s.updatedAt = nowISO();

  return res.json({
    ok: true,
    sessionId: sid,
    lang: s.lang,
    langLocked: !!s.langLocked,
    lockedAt: s.lockedAt || null,
  });
});

app.post("/api/session/lock/:sessionId", (req, res) => {
  const sid = String(req.params.sessionId || "").trim();
  const s = ensureSession(sid);
  if (!s) return res.status(400).json({ ok: false, error: "sessionId tidak sah" });

  s.langLocked = true;
  s.lockedAt = nowISO();
  s.updatedAt = s.lockedAt;

  return res.json({
    ok: true,
    sessionId: sid,
    lang: String(s.lang || "MS").toUpperCase(),
    langLocked: true,
    lockedAt: s.lockedAt,
  });
});

// ===============================
// SESSION CUS (untuk ClusterPage "Reload CU (cus)")
// ===============================

// versi utama: frontend panggil /api/session/cus/:sessionId
app.get("/api/session/cus/:sessionId", (req, res) => {
  try {
    const sid = String(req.params.sessionId || "").trim();
    const s = ensureSession(sid);
    if (!s) return res.status(400).json({ ok: false, error: "sessionId tidak sah" });

    return res.json({
      ok: true,
      sessionId: sid,
      cus: Array.isArray(s.cus) ? s.cus : [],
      appliedAt: s.appliedAt || null,
      updatedAt: s.updatedAt || null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// alias fallback (kalau ada code lama panggil query ?sessionId=...)
app.get("/api/session/cus", (req, res) => {
  try {
    const sid = String(req.query?.sessionId || "").trim();
    const s = ensureSession(sid);
    if (!s) return res.status(400).json({ ok: false, error: "sessionId tidak sah" });

    return res.json({
      ok: true,
      sessionId: sid,
      cus: Array.isArray(s.cus) ? s.cus : [],
      appliedAt: s.appliedAt || null,
      updatedAt: s.updatedAt || null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ======================================================
// CP AI: Seed Work Steps (WS) + Performance Criteria (PC)
// POST /api/cp/ai/seed-ws
// Body: { sessionId, cuCode, cuTitle, waList: [string], wsPerWa?: number }
// ======================================================
app.post("/api/cp/ai/seed-ws", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    const cuCode = String(req.body?.cuCode || req.body?.cuId || "").trim().toLowerCase();
    const cuTitle = String(req.body?.cuTitle || "").trim();
    const waList = Array.isArray(req.body?.waList) ? req.body.waList : [];
    const wsPerWa = Math.min(7, Math.max(3, Number(req.body?.wsPerWa || 5)));

    if (!sessionId || !cuCode) {
      return res.status(400).json({ error: "sessionId / cuCode tidak sah" });
    }
    if (!waList.length) {
      return res.status(400).json({ error: "waList kosong (tiada WA)" });
    }

    // ---------- Fallback generator (no AI) ----------
    function verbToPassive(verbRaw) {
      const v = String(verbRaw || "").trim().toLowerCase();

      const map = {
        "kenal pasti": "dikenal pasti",
        "rekod": "direkodkan",
        "catat": "dicatat",
        "baca": "dibaca",
        "periksa": "diperiksa",
        "semak": "disemak",
        "sediakan": "disediakan",
        "buat": "dibuat",
        "laksana": "dilaksanakan",
        "analisis": "dianalisis",
        "nilai": "dinilai",
        "siasat": "disiasat",
        "hantar": "dihantar",
        "salur": "disalurkan",
        "buat tindakan": "tindakan diambil",
      };

      if (map[v]) return map[v];
      if (v.startsWith("di")) return v;

      return "dilaksanakan";
    }

    function buildPastPcText(verb, object, qualifier) {
      const obj = String(object || "").trim() || "Aktiviti kerja";
      const qual = String(qualifier || "").trim();
      const passive = verbToPassive(verb);

      let s = `${obj} telah ${passive}`;
      if (qual) s += ` ${qual}`;
      if (!s.endsWith(".")) s += ".";

      return s;
    }

    // ---------- If no OpenAI key, return fallback ----------
    if (!process.env.OPENAI_API_KEY) {
      const workActivities = waList.map((waTitle, idx) => fallbackSeed(waTitle, idx));
      return res.json({
        ok: true,
        mode: "fallback",
        workActivities,
      });
    }

    // ---------- AI mode ----------
    // Jika server.js anda sudah ada OpenAI client, guna yang sedia ada.
    // Kalau belum, anda boleh guna fetch ke OpenAI (tetapi pastikan dependensi tersedia).
    // Di sini saya guna fetch (paling neutral).
    const prompt = {
      role: "user",
      content: `
Anda membantu membina CP (Competency Profile) untuk NOSS.
CU: ${cuTitle} (${cuCode})
Senarai WA:
${waList.map((x, i) => `${i + 1}. ${x}`).join("\n")}

Tugas:
Untuk setiap WA, hasilkan ${wsPerWa} Work Steps (WS) dalam Bahasa Melayu (Malaysia), ringkas tetapi jelas, berbentuk tindakan.
Setiap WS mesti ada:
- wsNo (contoh "1.1")
- wsText
- pc: { verb, object, qualifier, pcText }  (pcText ayat penuh)

Pulangkan JSON SAHAJA dengan format:
{
  "workActivities": [
    {
      "waTitle": "...",
      "workSteps": [
        { "wsNo":"1.1", "wsText":"...", "pc":{"verb":"...","object":"...","qualifier":"...","pcText":"..."} }
      ]
    }
  ]
}
Tiada teks lain selain JSON.
      `.trim(),
    };

    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.3,
        messages: [
          { role: "system", content: "Anda penulis standard kerja NOSS. Jawab dalam BM Malaysia. JSON sahaja." },
          prompt,
        ],
      }),
    });

    if (!aiResp.ok) {
      const t = await aiResp.text().catch(() => "");
      // fallback bila AI fail
      const workActivities = waList.map((waTitle, idx) => fallbackSeed(waTitle, idx));
      return res.json({ ok: true, mode: "fallback_after_ai_fail", note: t, workActivities });
    }

    const aiJson = await aiResp.json();
    const text = aiJson?.choices?.[0]?.message?.content || "";

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // fallback bila AI pulang bukan JSON
      const workActivities = waList.map((waTitle, idx) => fallbackSeed(waTitle, idx));
      return res.json({ ok: true, mode: "fallback_after_bad_json", raw: text, workActivities });
    }

    // normalise output
    const workActivities = (parsed.workActivities || []).map((wa, idx) => ({
      waId: "",
      waTitle: String(wa?.waTitle || waList[idx] || `WA${idx + 1}`),
      workSteps: (wa?.workSteps || []).map((ws, j) => ({
        wsId: "",
        wsNo: String(ws?.wsNo || `${idx + 1}.${j + 1}`),
        wsText: String(ws?.wsText || "").trim(),
        pc: {
          verb: String(ws?.pc?.verb || "").trim(),
          object: String(ws?.pc?.object || "").trim(),
          qualifier: String(ws?.pc?.qualifier || "").trim(),
          pcText: String(ws?.pc?.pcText || "").trim(),
        },
      })),
    }));

    return res.json({ ok: true, mode: "ai", workActivities });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ======================================================
 * 3) AI CLUSTER (PREVIEW + REAL)
 * ====================================================== */

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

  return res.json({ ok: true, sessionId: sid, total, assigned, unassigned, updatedAt: nowISO() });
});

// REAL cluster RUN (OpenAI) — ikut bahasa session (MS/EN) + auto-lock
app.post("/api/cluster/run", async (req, res) => {
  try {
    const sid = String(req.body?.sessionId || "").trim();
    if (!sid) return res.status(400).json({ error: "sessionId diperlukan" });

    const s = ensureSession(sid);
    if (!s) return res.status(400).json({ error: "sessionId tidak sah" });

    const items = getSessionCards(sid);
    if (items.length < 5) return res.status(400).json({ error: "Terlalu sedikit kad untuk clustering (min 5)" });

    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY belum diset" });

    const cards = items.map((c) => ({ id: c.id, activity: getCardText(c) })).filter((c) => c.activity);
    if (cards.length < 5) return res.status(400).json({ error: "Terlalu sedikit kad yang ada teks (min 5)" });

    const lang = String(s.lang || "MS").toUpperCase(); // "MS" | "EN"

    // Auto-lock bila run cluster
    if (!s.langLocked) {
      s.langLocked = true;
      s.lockedAt = nowISO();
      s.updatedAt = s.lockedAt;
    }

    const langRule =
      lang === "EN"
        ? [
            "Cluster titles MUST be in English (EN).",
            "Even if activity text is mixed Malay/English, the cluster title MUST remain English.",
            "Use concise titles (2–6 words).",
          ].join("\n")
        : [
            "Tajuk kluster MESTI dalam Bahasa Melayu (MS).",
            "Walaupun teks aktiviti bercampur BM/EN, tajuk kluster MESTI kekal Bahasa Melayu.",
            "Tajuk ringkas (2–6 perkataan).",
          ].join("\n");

    const prompt = `
You are a DACUM facilitator.
Task: Cluster work activities into logical CU groups.

Output must be JSON ONLY, format:
{
  "clusters":[{"title":"...","cardIds":[1,2,3]}],
  "unassigned":[]
}

Rules:
- Number of clusters: 4 to 12 (as appropriate).
- Each cardId must appear in ONLY ONE cluster.
- If an activity is too general/odd, put it into unassigned.
- ${langRule}

Activities:
${cards.map((c) => `(${c.id}) ${c.activity}`).join("\n")}
`.trim();

    const out = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return JSON only." },
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
      ok: true,
      sessionId: sid,
      lang,
      langLocked: !!s.langLocked,
      lockedAt: s.lockedAt || null,
      generatedAt: nowISO(),
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
      return res.status(400).json({ ok: false, error: "Tiada cluster result. Sila run /api/cluster/run dahulu." });
    }

    const sess = ensureSession(sid);
    const cards = getSessionCards(sid);
    const byId = new Map(cards.map((c) => [String(c.id), c]));

    const cus = last.clusters.map((cl, i) => {
      const cuId = `CU-${String(i + 1).padStart(2, "0")}`;
      const cuTitle = String(cl?.title || `CU ${i + 1}`).trim();

      const cardIds = Array.isArray(cl?.cardIds) ? cl.cardIds : [];
      const activities = cardIds.map((id, j) => {
        const card = byId.get(String(id));
        const waTitle = (card && getCardText(card)) || `Aktiviti ${j + 1}`;
        return { waId: `WA-${String(j + 1).padStart(2, "0")}`, waTitle, cardIds: [id] };
      });

      return { cuId, cuTitle, activities };
    });

    sess.cus = cus;
    sess.appliedAt = nowISO();
    sess.updatedAt = nowISO();

    // tag cards supaya summary assigned jadi betul
    const cuByCardId = new Map();
    cus.forEach((cu) => cu.activities.forEach((wa) => (wa.cardIds || []).forEach((cid) => cuByCardId.set(String(cid), cu.cuTitle))));
    cards.forEach((c) => {
      const t = cuByCardId.get(String(c.id));
      if (t) c.cuTitle = t;
    });

    return res.json({ ok: true, sessionId: sid, cusCount: cus.length, appliedAt: sess.appliedAt, sampleCu: cus[0] || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ======================================================
 * 4) CPC BUILDER
 * ====================================================== */

/** bina CPC daripada cards (source of truth) */
function buildCpcForSession(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) throw new Error("sessionId diperlukan");

  const s = ensureSession(sid);
  if (!s) throw new Error("Session tidak ditemui");

  const cards = getSessionCards(sid);

  // bina CU → WA (ikut struktur card sebenar: cuTitle + activity/name)
  const cuMap = {};
  cards.forEach((c) => {
    const cuTitle = String(c.cuTitle || "").trim();
    const waTitle = String(c.activity || c.name || c.title || "").trim();
    if (!cuTitle || !waTitle) return;

    if (!cuMap[cuTitle]) cuMap[cuTitle] = { cuCode: "", cuTitle, wa: [] };

    const exists = cuMap[cuTitle].wa.some((w) => String(w.waTitle || "").toLowerCase() === waTitle.toLowerCase());
    if (!exists) cuMap[cuTitle].wa.push({ waCode: "", waTitle });
  });

  const units = Object.values(cuMap).map((u, i) => ({
    ...u,
    cuCode: `C${String(i + 1).padStart(2, "0")}`,
    wa: (u.wa || []).map((w, j) => ({ ...w, waCode: `W${String(j + 1).padStart(2, "0")}` })),
  }));

  return {
    sessionId: sid,
    lang: String(s.lang || "MS").toUpperCase(),
    generatedAt: nowISO(),
    teras: [{ terasCode: "T01", terasTitle: s.terasTitle || "Pengurusan & Pengimarahan Masjid" }],
    // penting: compatibility untuk CP Dashboard
    cus: units,
    units,
  };
}

/**
 * GET /api/cpc/:sessionId
 */
app.get("/api/cpc/:sessionId", (req, res) => {
  try {
    const sessionId = String(req.params.sessionId || "").trim();
    if (!sessionId) return res.status(400).json({ error: "sessionId diperlukan" });

    const cpc = buildCpcForSession(sessionId);
    return res.json(cpc);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ======================================================
 * 5) CP BUILDER (LOCKED FASA 3)
 * ====================================================== */

// ------------------------------
// CP In-Memory Store (boleh tukar DB kemudian)
// ------------------------------
const cpStore = {}; 
// shape: cpStore[sessionId][cuKey] = { latestVersion: "v1", versions: [{version, cp}] }

function _ensureCpBucket(sessionId) {
  if (!cpStore[sessionId]) cpStore[sessionId] = {};
  return cpStore[sessionId];
}
function _getLatestCp(sessionId, cuKey) {
  const bucket = cpStore?.[sessionId]?.[cuKey];
  if (!bucket || !bucket.versions?.length) return null;
  return bucket.versions[bucket.versions.length - 1];
}
function _saveCpVersion(sessionId, cuKey, cp, { bumpVersion = false } = {}) {
  const bucket = _ensureCpBucket(sessionId);
  if (!bucket[cuKey]) bucket[cuKey] = { latestVersion: null, versions: [] };

  const cur = bucket[cuKey];
  let nextV = "v1";
  if (cur.versions.length) {
    const lastV = cur.versions[cur.versions.length - 1].version || "v1";
    const n = Number(String(lastV).replace(/^v/i, "")) || 1;
    nextV = bumpVersion ? `v${n + 1}` : lastV;
  }

  const idx = cur.versions.findIndex((x) => x.version === nextV);
  const payload = { version: nextV, cp };
  if (idx >= 0) cur.versions[idx] = payload;
  else cur.versions.push(payload);

  cur.latestVersion = nextV;
  return nextV;
}

// ------------------------------
// Bahasa ikut CPC
// ------------------------------
function detectLanguageFromCpc(cpc) {
  const raw = String(cpc?.language || cpc?.bahasa || cpc?.lang || "").trim();
  if (/^ms|bm|malay|bahasa/i.test(raw)) return "MS";
  if (/^en|english/i.test(raw)) return "EN";
  return String(cpc?.lang || "MS").toUpperCase() === "EN" ? "EN" : "MS";
}

// ------------------------------
// Extract CU dari CPC
// ------------------------------
function extractCusFromCpc(cpc) {
  const cus = cpc?.cus || cpc?.units || cpc?.data?.cus || cpc?.data?.units || [];
  return Array.isArray(cus) ? cus : [];
}

function findCuInCpc(cpc, cuKey) {
  const cus = extractCusFromCpc(cpc);
  const target = String(cuKey || "").trim().toLowerCase();
  if (!target) return null;

  return (
    cus.find((c) => {
      const cuCode = String(c?.cuCode || c?.code || "").trim().toLowerCase(); // "c01"
      const cuId = String(c?.cuId || c?.id || "").trim().toLowerCase();
      const alt = String(c?.cu || c?.cuID || c?.cu_id || "").trim().toLowerCase();
      return cuCode === target || cuId === target || (alt && alt === target);
    }) || null
  );
}

function extractWaFromCu(cu) {
  const wa = cu?.wa || cu?.workActivities || cu?.activities || cu?.was || [];
  if (!Array.isArray(wa)) return [];
  return wa.map((x) => ({
    waId: x?.waId || x?.id || x?.code || "",
    waCode: x?.waCode || x?.code || "",
    waTitle: x?.waTitle || x?.title || x?.name || "",
  }));
}

// ------------------------------
// WS+PC templates (ringkas, regulator-friendly)
// ------------------------------
function makePcText({ lang, verb, object, qualifier }) {
  if (lang === "MS") {
    const q = qualifier ? ` ${qualifier}` : "";
    return `${object} ${verb}${q}.`.replace(/\s+/g, " ").trim();
  }
  const q = qualifier ? ` ${qualifier}` : "";
  return `${object} is ${verb}${q}.`.replace(/\s+/g, " ").trim();
}

function waTemplatesForEN(waTitle) {
  const t = String(waTitle || "").trim().toLowerCase();
  if (t.startsWith("analyze")) {
    return [
      { ws: "Identify applicable standards and requirements.", verb: "identified", object: "Applicable standards and requirements", qualifier: "according to organizational and regulatory guidelines" },
      { ws: "Review current practices and records.", verb: "reviewed", object: "Current practices and records", qualifier: "to determine gaps and risks" },
      { ws: "Document analysis findings.", verb: "documented", object: "Analysis findings", qualifier: "in accordance with documentation procedures" },
    ];
  }
  if (t.startsWith("plan")) {
    return [
      { ws: "Define scope, objectives, and timeline.", verb: "defined", object: "Scope, objectives, and timeline", qualifier: "based on organizational needs" },
      { ws: "Allocate resources and responsibilities.", verb: "allocated", object: "Resources and responsibilities", qualifier: "according to roles and workload" },
      { ws: "Prepare plan documentation for approval.", verb: "prepared", object: "Plan documentation", qualifier: "for review and approval" },
    ];
  }
  if (t.startsWith("perform")) {
    return [
      { ws: "Execute tasks according to the approved plan.", verb: "executed", object: "Tasks", qualifier: "according to the approved plan and procedures" },
      { ws: "Record transactions and supporting evidence.", verb: "recorded", object: "Transactions and supporting evidence", qualifier: "accurately and completely" },
      { ws: "File records in the designated system.", verb: "filed", object: "Records", qualifier: "in the designated filing system for traceability" },
    ];
  }
  if (t.startsWith("evaluate")) {
    return [
      { ws: "Verify outputs against requirements.", verb: "verified", object: "Outputs", qualifier: "against defined requirements and standards" },
      { ws: "Identify nonconformities and improvement actions.", verb: "identified", object: "Nonconformities and improvement actions", qualifier: "based on evaluation results" },
      { ws: "Report evaluation results to relevant parties.", verb: "reported", object: "Evaluation results", qualifier: "to relevant parties for decision making" },
    ];
  }
  if (t.startsWith("prepare") || t.startsWith("generate")) {
    return [
      { ws: "Compile required data and records.", verb: "compiled", object: "Required data and records", qualifier: "from verified sources" },
      { ws: "Produce the report using approved format.", verb: "produced", object: "The report", qualifier: "using the approved template and format" },
      { ws: "Submit report for review and filing.", verb: "submitted", object: "The report", qualifier: "for review, approval, and filing" },
    ];
  }
  return [
    { ws: "Identify requirements and inputs.", verb: "identified", object: "Requirements and inputs", qualifier: "according to relevant guidelines" },
    { ws: "Carry out the work according to procedure.", verb: "performed", object: "Work activities", qualifier: "according to procedure and safety requirements" },
    { ws: "Record and file outputs.", verb: "recorded", object: "Outputs", qualifier: "for traceability and future reference" },
  ];
}

function waTemplatesForMS(waTitle) {
  const t = String(waTitle || "").trim().toLowerCase();
  if (/^analisis|^menganalisis|^kenal pasti/.test(t)) {
    return [
      { ws: "Kenal pasti standard dan keperluan berkaitan.", verb: "ditentukan", object: "Standard dan keperluan berkaitan", qualifier: "berdasarkan garis panduan organisasi dan peraturan" },
      { ws: "Semak amalan dan rekod semasa.", verb: "disemak", object: "Amalan dan rekod semasa", qualifier: "bagi mengenal pasti jurang dan risiko" },
      { ws: "Dokumentasikan dapatan analisis.", verb: "didokumentasikan", object: "Dapatan analisis", qualifier: "mengikut prosedur pendokumenan" },
    ];
  }
  if (/^rancang|^merancang/.test(t)) {
    return [
      { ws: "Tetapkan skop, objektif dan garis masa.", verb: "ditetapkan", object: "Skop, objektif dan garis masa", qualifier: "berdasarkan keperluan organisasi" },
      { ws: "Agihkan sumber dan tanggungjawab.", verb: "diagihkan", object: "Sumber dan tanggungjawab", qualifier: "mengikut peranan dan beban tugas" },
      { ws: "Sediakan dokumen perancangan untuk kelulusan.", verb: "disediakan", object: "Dokumen perancangan", qualifier: "untuk semakan dan kelulusan" },
    ];
  }
  if (/^laksana|^melaksana|^jalankan|^buat/.test(t)) {
    return [
      { ws: "Laksanakan tugasan mengikut pelan yang diluluskan.", verb: "dilaksanakan", object: "Tugasan", qualifier: "mengikut pelan diluluskan dan prosedur kerja" },
      { ws: "Rekod transaksi dan bukti sokongan.", verb: "direkodkan", object: "Transaksi dan bukti sokongan", qualifier: "secara tepat dan lengkap" },
      { ws: "Simpan rekod dalam sistem pemfailan yang ditetapkan.", verb: "disimpan", object: "Rekod", qualifier: "dalam sistem pemfailan bagi tujuan kebolehkesanan" },
    ];
  }
  if (/^nilai|^menilai|^semak/.test(t)) {
    return [
      { ws: "Sahkan output berdasarkan keperluan.", verb: "disahkan", object: "Output", qualifier: "berdasarkan keperluan dan standard ditetapkan" },
      { ws: "Kenal pasti ketakakuran dan tindakan penambahbaikan.", verb: "dikenal pasti", object: "Ketakakuran dan tindakan penambahbaikan", qualifier: "berdasarkan hasil penilaian" },
      { ws: "Laporkan hasil penilaian kepada pihak berkaitan.", verb: "dilaporkan", object: "Hasil penilaian", qualifier: "kepada pihak berkaitan untuk tindakan" },
    ];
  }
  if (/^sediakan|^jana|^hasilkan|^lapor/.test(t)) {
    return [
      { ws: "Kumpulkan data dan rekod yang diperlukan.", verb: "dikumpulkan", object: "Data dan rekod yang diperlukan", qualifier: "daripada sumber yang disahkan" },
      { ws: "Hasilkan laporan mengikut format yang diluluskan.", verb: "dihasilkan", object: "Laporan", qualifier: "mengikut templat dan format diluluskan" },
      { ws: "Serahkan laporan untuk semakan dan pemfailan.", verb: "diserahkan", object: "Laporan", qualifier: "untuk semakan, kelulusan dan pemfailan" },
    ];
  }
  return [
    { ws: "Kenal pasti keperluan dan input kerja.", verb: "dikenal pasti", object: "Keperluan dan input kerja", qualifier: "mengikut garis panduan berkaitan" },
    { ws: "Laksanakan aktiviti mengikut prosedur.", verb: "dilaksanakan", object: "Aktiviti kerja", qualifier: "mengikut prosedur dan keperluan keselamatan" },
    { ws: "Rekod dan failkan output.", verb: "direkodkan", object: "Output", qualifier: "untuk kebolehkesanan dan rujukan" },
  ];
}

function generateCpDraft({ sessionId, cpc, cu }) {
  const lang = detectLanguageFromCpc(cpc); // "EN"|"MS"
  const waList = extractWaFromCu(cu);

  const cp = {
    sessionId,
    cpId: null,
    cpcVersion: String(cpc?.generatedAt || cpc?.exportedAt || cpc?.version || "CPC").trim(),
    status: "DRAFT",
    cu: {
      cuId: cu?.cuId || cu?.id || "",
      cuCode: cu?.cuCode || cu?.code || "",
      cuTitle: cu?.cuTitle || cu?.title || "",
      cuDescription: cu?.cuDescription || cu?.description || "",
    },
    workActivities: waList.map((wa, i) => {
      const templates = lang === "MS" ? waTemplatesForMS(wa.waTitle) : waTemplatesForEN(wa.waTitle);

      const workSteps = templates.map((tpl, idx) => {
        const wsNo = `${i + 1}.${idx + 1}`;
        return {
          wsId: `${wa.waId || `WA${i + 1}`}-S${idx + 1}`,
          wsNo,
          wsText: tpl.ws,
          pc: {
            pcId: `${wa.waId || `WA${i + 1}`}-P${idx + 1}`,
            pcNo: wsNo,
            verb: tpl.verb,
            object: tpl.object,
            qualifier: tpl.qualifier,
            pcText: makePcText({ lang, verb: tpl.verb, object: tpl.object, qualifier: tpl.qualifier }),
          },
        };
      });

      return {
        waId: wa.waId || `W${String(i + 1).padStart(2, "0")}`,
        waCode: wa.waCode || wa.waId || "",
        waTitle: wa.waTitle || "",
        workSteps,
      };
    }),
    validation: { minRulesPassed: false, vocPassed: false, completenessPassed: false, issues: [] },
    audit: { createdAt: nowISO(), createdBy: "AI", updatedAt: nowISO(), updatedBy: ["AI"], lockedAt: null, lockedBy: null },
  };

  return cp;
}

function validateCp(cp) {
  const issues = [];

  const waCount = (cp?.workActivities || []).length;
  if (waCount < 3) issues.push({ level: "ERROR", code: "MIN_WA", msg: "Setiap CU mesti ada sekurang-kurangnya 3 WA." });

  let minWsOk = true;
  let onePcOk = true;

  for (const wa of cp?.workActivities || []) {
    const ws = wa?.workSteps || [];
    if (ws.length < 3) {
      minWsOk = false;
      issues.push({ level: "ERROR", code: "MIN_WS", msg: `WA "${wa?.waTitle || wa?.waId}" mesti ada sekurang-kurangnya 3 WS.` });
    }
    for (const step of ws) {
      if (!step?.pc) {
        onePcOk = false;
        issues.push({ level: "ERROR", code: "MISSING_PC", msg: `WS "${step?.wsNo || step?.wsId}" mesti ada 1 PC.` });
      }
    }
  }

  const minRulesPassed = waCount >= 3 && minWsOk && onePcOk;

  // VOC
  let vocPassed = true;
  for (const wa of cp?.workActivities || []) {
    for (const step of wa?.workSteps || []) {
      const pc = step?.pc || {};
      if (!String(pc?.verb || "").trim() || !String(pc?.object || "").trim() || !String(pc?.qualifier || "").trim()) {
        vocPassed = false;
        issues.push({ level: "ERROR", code: "VOC_FAIL", msg: `PC untuk WS "${step?.wsNo || step?.wsId}" mesti ada Verb+Object+Qualifier.` });
      }
    }
  }

  // Completeness (heuristik)
  let completenessPassed = true;
  for (const wa of cp?.workActivities || []) {
    const text = (wa?.workSteps || []).map((s) => String(s?.wsText || "")).join(" ").toLowerCase();
    const hasCheck = /(review|verify|validate|audit|semak|sahkan|validasi|pengesahan)/i.test(text);
    const hasRecord = /(record|document|file|submit|report|rekod|dokumen|fail|serah|lapor|pemfailan)/i.test(text);
    if (!hasCheck || !hasRecord) {
      completenessPassed = false;
      issues.push({ level: "WARNING", code: "WS_INCOMPLETE", msg: `WA "${wa?.waTitle || wa?.waId}" mungkin belum lengkap (tiada elemen semakan/pengesahan atau rekod/serahan).` });
    }
  }

  return { minRulesPassed, vocPassed, completenessPassed, issues };
}

/**
 * POST /api/cp/draft
 * Accept payload:
 * - { sessionId, cuCode } (preferred)
 * - { sessionId, cuId }
 * - { session, cu } (legacy)
 */
app.post("/api/cp/draft", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || req.body?.session || "").trim();
    const cuCodeRaw = String(req.body?.cuCode || req.body?.cuId || req.body?.cu || "").trim();

    if (!sessionId || !cuCodeRaw) return res.status(400).json({ ok: false, error: "sessionId dan cuCode (atau cu) wajib." });

    const cpc = buildCpcForSession(sessionId);

    // frontend kadang hantar "c01" (lowercase) -> kita normalize
    const cuKey = cuCodeRaw.toLowerCase();
    const cuFromCpc = findCuInCpc(cpc, cuKey);

    if (!cuFromCpc) {
      return res.status(404).json({ ok: false, error: "CU tidak ditemui dalam CPC (cuCode tidak match).", cuKey, hint: "Semak /api/cpc/:sessionId -> pastikan ada cus[].cuCode" });
    }

    const cp = generateCpDraft({ sessionId, cpc, cu: cuFromCpc });
    const validation = validateCp(cp);
    cp.validation = validation;

    const ver = _saveCpVersion(sessionId, cuKey, cp, { bumpVersion: true });

    // compat output: cpDraft + cp
    return res.json({ ok: true, version: ver, cpDraft: cp, cp });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/cp/:sessionId/:cuId", (req, res) => {
  const sessionId = String(req.params.sessionId || "").trim();
  const cuId = String(req.params.cuId || "").trim().toLowerCase();
  const versionQ = String(req.query?.version || "latest").trim();

  const bucket = cpStore?.[sessionId]?.[cuId];
  if (!bucket || !Array.isArray(bucket.versions) || !bucket.versions.length) {
    return res.status(404).json({ error: "CP belum wujud. Jana draft dahulu." });
  }

  const versions = bucket.versions;

  if (versionQ === "latest") {
    return res.json(versions[versions.length - 1]);
  }

  const found = versions.find((x) => String(x.version) === String(versionQ).toLowerCase());
  if (!found) return res.status(404).json({ error: "Versi CP tidak ditemui." });

  return res.json(found);
});

app.put("/api/cp/:sessionId/:cuId", (req, res) => {
  try {
    const sessionId = String(req.params.sessionId || "").trim();
    const cuId = String(req.params.cuId || "").trim().toLowerCase();
    const cp = req.body;

    if (!cp || typeof cp !== "object") return res.status(400).json({ error: "Body CP JSON diperlukan." });

    const validation = validateCp(cp);
    cp.validation = validation;
    cp.audit = cp.audit || {};
    cp.audit.updatedAt = nowISO();
    cp.audit.updatedBy = Array.isArray(cp.audit.updatedBy) ? cp.audit.updatedBy : [];
    if (!cp.audit.updatedBy.includes("FACILITATOR")) cp.audit.updatedBy.push("FACILITATOR");

    const ver = _saveCpVersion(sessionId, cuId, cp, { bumpVersion: false });
    return res.json({ ok: true, version: ver, validation });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/api/cp/validate", (req, res) => {
  try {
    const cp = req.body?.cp;
    if (!cp) return res.status(400).json({ error: "cp wajib." });
    const validation = validateCp(cp);
    return res.json(validation);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/api/cp/lock", (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    const cuId = String(req.body?.cuCode || req.body?.cuId || req.body?.cu || "").trim().toLowerCase();
    const lockedBy = String(req.body?.lockedBy || "PANEL").trim();

    if (!sessionId || !cuId) return res.status(400).json({ error: "sessionId dan cuId/cuCode wajib." });

    const latest = _getLatestCp(sessionId, cuId);
    if (!latest) return res.status(404).json({ error: "CP belum wujud. Jana draft dahulu." });

    const cp = latest.cp;
    const validation = validateCp(cp);
    cp.validation = validation;

    const hasError = (validation.issues || []).some((x) => x.level === "ERROR");
    if (hasError) return res.status(400).json({ error: "Tak boleh LOCK kerana ada ERROR pada validation.", validation });

    cp.status = "LOCKED";
    cp.audit = cp.audit || {};
    cp.audit.lockedAt = nowISO();
    cp.audit.lockedBy = lockedBy;

    const ver = _saveCpVersion(sessionId, cuId, cp, { bumpVersion: true });
    cp.cpId = `${sessionId}-${cuId}-${ver}`;

    return res.json({ ok: true, cpId: cp.cpId, version: ver, validation });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/api/cp/export/:sessionId/:cuId", (req, res) => {
  const sessionId = String(req.params.sessionId || "").trim();
  const cuId = String(req.params.cuId || "").trim().toLowerCase();
  const format = String(req.query?.format || "json").trim().toLowerCase();

  const latest = _getLatestCp(sessionId, cuId);
  if (!latest) return res.status(404).json({ error: "CP belum wujud." });
  if (format !== "json") return res.status(400).json({ error: "Buat masa ini hanya format=json disokong." });

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.send(JSON.stringify(latest.cp, null, 2));
});

/* ======================================================
 * 6) SISTEM 2 Bridge (Seed WA)
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
        time: nowISO(),
      }));

    setSessionCards(sessionId, cards);
    return res.json({ ok: true, sessionId, totalSeeded: cards.length });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ======================================================
 * 7) MySPIKE REAL CU INDEX
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
  if (!fs.existsSync(META_FILE)) return { lastPage: 0, totalCU: 0, updatedAt: null, note: "empty" };
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

  const jdLinks = new Map();
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
    if (!jdLinks.has(jdId)) jdLinks.set(jdId, { jdId, jdUrl: full, anchorText: anchorText || "" });
  });

  return { cpId: String(cpId), url, nossCode, nossTitle, jdLinks: Array.from(jdLinks.values()) };
}
async function fetchCuFromJd(jdId) {
  const url = `https://www.myspike.my/index.php?r=umum-noss%2Fview&id=${jdId}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const out = { jdId: String(jdId), jdUrl: url, cuCode: "", cuTitle: "", cuDesc: "", programName: "", nossCode: "", source: "myspike" };

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
    const m = bodyText.match(/([A-Z]{2,4}-\d{3,4}-\d:\d{4}-C\d{2})/i) || bodyText.match(/([A-Z]{2,4}-\d{3,4}-\d:\d{4}-C\d)/i);
    if (m) out.cuCode = norm(m[1]);
  }
  if (!out.cuTitle) out.cuTitle = norm($("h1").first().text()) || norm($("title").text());

  out.cuCode = norm(out.cuCode);
  out.cuTitle = norm(out.cuTitle);
  out.cuDesc = norm(out.cuDesc);

  return out;
}

app.get("/api/myspike/index/status", (req, res) => {
  const meta = loadCuMeta();
  res.json({ ok: true, meta });
});

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
            indexedAt: nowISO(),
          });
          added++;
        }
      }

      meta.lastPage = Math.max(meta.lastPage || 0, p);
    }

    meta.totalCU = index.length;
    meta.updatedAt = nowISO();
    meta.note = "REAL CU INDEX (from JD)";

    saveCuIndex(index);
    saveCuMeta(meta);

    res.json({ ok: true, fromPage, toPage, added, meta });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

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
 * 8) MySPIKE Comparator (REAL AI)
 * ====================================================== */
function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
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
  const actTitles = acts.map((a) => String(a.waTitle || a.title || "").trim()).filter(Boolean).join("; ");
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
    MYSPIKE_CU_LOADED_AT = nowISO();
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
  MYSPIKE_CU_LOADED_AT = nowISO();
}

app.post("/api/s2/compare", async (req, res) => {
  try {
    const { sessionId, cus, options, meta } = req.body || {};
    const list = Array.isArray(cus) ? cus : [];
    if (!list.length) return res.status(400).json({ error: "cus kosong. Sila hantar sekurang-kurangnya 1 CU." });

    const thresholdAda = Number(options?.thresholdAda ?? 0.78);
    const topK = Math.max(1, Math.min(10, Number(options?.topK ?? 3)));

    await ensureMyspikeCuEmbeddings({ model: "text-embedding-3-small" });

    const myItems = MYSPIKE_CU_ITEMS || [];
    const myEmb = MYSPIKE_CU_EMB || [];
    if (!myItems.length) {
      return res.status(400).json({ error: "Index MySPIKE CU masih kosong. Sila bina index dulu: POST /api/myspike/index/build" });
    }

    const cuTexts = list.map(buildCuText);
    const cuEmbRes = await client.embeddings.create({ model: "text-embedding-3-small", input: cuTexts });
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
        input: { cuCode: cu.cuCode || "", cuTitle: cu.cuTitle || cu.title || "", activitiesCount: Array.isArray(cu.activities) ? cu.activities.length : 0 },
        decision: { status, bestScore: best, confidence: conf, thresholdAda },
        matches: top,
      };
    });

    return res.json({
      ok: true,
      sessionId: sessionId || meta?.sessionId || "unknown",
      meta: meta || {},
      myspike: { source: "REAL_INDEX", loadedAt: MYSPIKE_CU_LOADED_AT, totalCandidates: myItems.length, embeddingModel: "text-embedding-3-small" },
      summary: { totalCU: results.length, ada: results.filter((r) => r.decision.status === "ADA").length, tiada: results.filter((r) => r.decision.status === "TIADA").length },
      results,
      generatedAt: nowISO(),
    });
  } catch (e) {
    console.error("S2 compare error:", e);
    return res.status(500).json({ error: "Gagal buat perbandingan MySPIKE", detail: String(e?.message || e) });
  }
});

/* =========================
 * DEBUG: OpenAI connection
 * ========================= */
app.get("/debug/openai", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ ok: false, message: "OPENAI_API_KEY belum diset" });

    const r = await client.embeddings.create({ model: "text-embedding-3-small", input: "test connection" });
    return res.json({ ok: true, embedding_dim: r.data?.[0]?.embedding?.length || null });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || "OpenAI debug error", detail: e?.response?.data || null });
  }
});

/* =========================
 * SERVER START (PALING BAWAH)
 * ========================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("🚀 Server listening on", PORT);
});
