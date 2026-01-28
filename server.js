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
const crypto = require("crypto");

// ===== OpenAI SDK v4 =====
const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== S3 (AWS SDK v3) =====
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");

const S3_BUCKET_INOSS = process.env.S3_BUCKET_INOSS;
const AWS_REGION = process.env.AWS_REGION || "ap-southeast-1";
const S3_PREFIX_INOSS = process.env.S3_PREFIX || "inoss/sessions";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: mustEnv("AWS_ACCESS_KEY_ID"),
    secretAccessKey: mustEnv("AWS_SECRET_ACCESS_KEY"),
  },
});

function sanitizeSessionId(sid) {
  // kekalkan ringkas & selamat untuk S3 key
  return String(sid || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "");
}

// stream -> string helper
async function streamToString(stream) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

async function s3GetJson(key, fallback) {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: S3_BUCKET_INOSS, Key: key })
    );
    const text = await streamToString(res.Body);
    return JSON.parse(text);
  } catch (e) {
    // fail belum wujud = normal (NoSuchKey / 404)
    const code = e?.name || e?.Code;
    if (code === "NoSuchKey" || code === "NotFound") return fallback;
    // kadang AWS letak statusCode
    if (e?.$metadata?.httpStatusCode === 404) return fallback;
    throw e;
  }
}

async function s3PutJson(key, obj) {
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET_INOSS,
      Key: key,
      Body: JSON.stringify(obj, null, 2),
      ContentType: "application/json; charset=utf-8",
    })
  );
}

/* =========================
 * APP + MIDDLEWARE
 * ========================= */
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

/* ======================================================
 * LIVEBOARD (S3) — ikut SESSION
 * GET  /api/liveboard/:sessionId
 * POST /api/liveboard/:sessionId
 * ====================================================== */

const S3_PREFIX = process.env.S3_PREFIX || "inoss/sessions";

function s3KeyLiveboard(sessionId) {
  const sid = sanitizeSessionId(sessionId); // guna function sedia ada
  if (!sid) return "";
  return `${S3_PREFIX}/${sid}/liveboard.json`;
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

async function s3Exists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET_INOSS, Key: key }));
    return true;
  } catch (e) {
    return false;
  }
}

async function s3GetJson(key) {
  const out = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET_INOSS, Key: key }));
  const text = await streamToString(out.Body);
  return JSON.parse(text || "{}");
}

async function s3PutJson(key, data) {
  const body = JSON.stringify(data ?? {}, null, 2);
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET_INOSS,
      Key: key,
      Body: body,
      ContentType: "application/json",
      CacheControl: "no-store",
    })
  );
  return true;
}

// GET: load liveboard.json ikut session
app.get("/api/liveboard/:sessionId", async (req, res) => {
  try {
    const sidRaw = String(req.params.sessionId || "").trim();
    if (!sidRaw) return res.status(400).json({ ok: false, error: "sessionId tidak sah" });

    if (!S3_BUCKET_INOSS) {
      return res.status(500).json({ ok: false, error: "S3_BUCKET_INOSS belum diset" });
    }

    const key = s3KeyLiveboard(sidRaw);
    if (!key) return res.status(400).json({ ok: false, error: "S3 key tidak sah" });

    const exists = await s3Exists(key);
    if (!exists) {
      return res.json({
        ok: true,
        sessionId: sidRaw,
        source: "default",
        data: { sessionId: sidRaw, cards: [], version: 1, lastUpdatedAt: null },
      });
    }

    const data = await s3GetJson(key);
    return res.json({ ok: true, sessionId: sidRaw, source: "s3", data });
  } catch (err) {
    console.error("GET /api/liveboard error:", err);
    return res.status(500).json({ ok: false, error: "Gagal load LiveBoard dari S3" });
  }
});

// POST: save liveboard.json ikut session
app.post("/api/liveboard/:sessionId", async (req, res) => {
  try {
    const sidRaw = String(req.params.sessionId || "").trim();
    if (!sidRaw) return res.status(400).json({ ok: false, error: "sessionId tidak sah" });

    if (!S3_BUCKET_INOSS) {
      return res.status(500).json({ ok: false, error: "S3_BUCKET_INOSS belum diset" });
    }

    const key = s3KeyLiveboard(sidRaw);
    if (!key) return res.status(400).json({ ok: false, error: "S3 key tidak sah" });

    const incoming = req.body?.data ?? req.body ?? {};
    const dataToSave = {
      ...incoming,
      sessionId: sidRaw,
      version: Number(incoming?.version || 1),
      lastUpdatedAt: new Date().toISOString(),
    };

    await s3PutJson(key, dataToSave);
    return res.json({ ok: true, sessionId: sidRaw, saved: true, key });
  } catch (err) {
    console.error("POST /api/liveboard error:", err);
    return res.status(500).json({ ok: false, error: "Gagal simpan LiveBoard ke S3" });
  }
});

// ======================================================
// LIVEBOARD (S3) — APPEND CARD (Panel Input)
// POST /api/liveboard/:sessionId/append
// body: { panelName, activity }
// ======================================================
app.post("/api/liveboard/:sessionId/append", async (req, res) => {
  try {
    const sessionIdRaw = String(req.params.sessionId || "").trim();
    if (!sessionIdRaw) {
      return res.status(400).json({ ok: false, error: "sessionId tidak sah" });
    }

    if (!S3_BUCKET_INOSS) {
      return res.status(500).json({ ok: false, error: "S3_BUCKET_INOSS belum diset" });
    }

    const panelName = String(req.body?.panelName || req.body?.name || "").trim();
    const activity = String(req.body?.activity || req.body?.text || "").trim();

    if (!panelName) return res.status(400).json({ ok: false, error: "Nama panel diperlukan" });
    if (!activity) return res.status(400).json({ ok: false, error: "Aktiviti kerja diperlukan" });

    const key = s3KeyLiveboard(sessionIdRaw);
    if (!key) return res.status(400).json({ ok: false, error: "S3 key tidak sah" });

    // Load liveboard semasa (jika tiada, mula dengan default)
    let board = { sessionId: sessionIdRaw, cards: [], version: 1, lastUpdatedAt: null };
    const exists = await s3Exists(key);
    if (exists) {
      try {
        board = await s3GetJson(key);
      } catch {
        // kalau JSON rosak, fallback ke default
        board = { sessionId: sessionIdRaw, cards: [], version: 1, lastUpdatedAt: null };
      }
    }

    const cards = Array.isArray(board.cards) ? board.cards : [];

    const now = new Date();
    const newCard = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(now.getTime()) + "-" + Math.random().toString(16).slice(2),
      activity,            // LiveBoard render guna c.activity || c.name
      panelName,
      time: now.toISOString(),      // optional, LiveBoard display sebelah kanan
      createdAt: now.toISOString(), // untuk audit
      source: "panel",
    };

    // Append + kemas kini meta
    const nextBoard = {
      ...board,
      sessionId: sessionIdRaw,
      cards: [...cards, newCard],
      version: Number(board?.version || 1),
      lastUpdatedAt: now.toISOString(),
    };

    await s3PutJson(key, nextBoard);

    return res.json({
      ok: true,
      sessionId: sessionIdRaw,
      appended: true,
      card: newCard,
      totalCards: nextBoard.cards.length,
    });
  } catch (err) {
    console.error("POST /api/liveboard/:sessionId/append error:", err);
    return res.status(500).json({ ok: false, error: "Gagal append kad ke LiveBoard (S3)" });
  }
});

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

/**
 * POST /api/panel/submit
 * body: { sessionId, panelName, text }
 */
app.post("/api/panel/submit", async (req, res) => {
  try {
    const sessionIdRaw = req.body?.sessionId;
    const panelName = String(req.body?.panelName || "").trim();
    const text = String(req.body?.text || "").trim();

    const sessionId = sanitizeSessionId(sessionIdRaw);

    if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId tidak sah" });
    if (!panelName) return res.status(400).json({ ok: false, error: "nama panel wajib" });
    if (!text) return res.status(400).json({ ok: false, error: "input aktiviti kerja wajib" });

    if (!S3_BUCKET_INOSS) {
      return res.status(500).json({ ok: false, error: "S3_BUCKET_INOSS belum diset" });
    }

    const key = `sessions/${sessionId}/panel_inputs.json`;

    // ambil data sedia ada, append, simpan balik
    const existing = await s3GetJson(key, { sessionId, items: [] });

    const item = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      sessionId,
      panelName,
      text,
      createdAt: new Date().toISOString(),
    };

    existing.sessionId = sessionId;
    existing.items = Array.isArray(existing.items) ? existing.items : [];
    existing.items.push(item);

    await s3PutJson(key, existing);

    return res.json({ ok: true, saved: item });
  } catch (e) {
    console.error("panel submit s3 error:", e);
    return res.status(500).json({ ok: false, error: "Gagal simpan ke S3" });
  }
});

/**
 * GET /api/panel/list/:sessionId
 */
app.get("/api/panel/list/:sessionId", async (req, res) => {
  try {
    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId tidak sah" });
    if (!S3_BUCKET_INOSS) {
      return res.status(500).json({ ok: false, error: "S3_BUCKET_INOSS belum diset" });
    }

    const key = `sessions/${sessionId}/panel_inputs.json`;
    const data = await s3GetJson(key, { sessionId, items: [] });

    return res.json({ ok: true, sessionId, items: data.items || [] });
  } catch (e) {
    console.error("panel list s3 error:", e);
    return res.status(500).json({ ok: false, error: "Gagal baca dari S3" });
  }
});

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


/**
 * Sync cards daripada LiveBoard (S3) -> sessions[sid].cards (memory)
 * Tujuan: Cluster Page perlu nampak kad yang panel masukkan di Live Board.
 * NOTE: LiveBoard sekarang simpan di S3 (liveboard.json). Cluster sebelum ini baca dari memory sahaja.
 */
async function syncSessionCardsFromS3(sessionId) {
  try {
    const sid = String(sessionId || "").trim();
    if (!sid) return { ok: false, reason: "no_session" };

    // kalau env S3 tak set, skip (kekal guna memory)
    if (!S3_BUCKET_INOSS) return { ok: false, reason: "no_s3_bucket" };

    const key = s3KeyLiveboard(sid);
    if (!key) return { ok: false, reason: "bad_key" };

    // jika file tak wujud lagi, skip
    const exists = await s3Exists(key);
    if (!exists) return { ok: false, reason: "no_liveboard_file" };

    const board = await s3GetJson(key);
    const list = Array.isArray(board?.cards) ? board.cards : [];
    if (!list.length) return { ok: true, imported: 0 };

    // convert bentuk kad S3 -> bentuk kad memory yang digunakan oleh clustering/CPC
    const mapped = list
      .map((c, idx) => {
        const activity = String(
          c?.activity || c?.text || c?.name || c?.title || c?.waTitle || ""
        ).trim();
        if (!activity) return null;
        const id = c?.id ?? `${Date.now()}-${idx}`;
        return {
          id,
          name: String(c?.panelName || c?.name || "Panel").trim(),
          activity,
          time: String(c?.time || c?.createdAt || c?.timestamp || nowISO()),
          // simpan asal untuk audit/debug
          _src: "s3-liveboard",
        };
      })
      .filter(Boolean);

    // merge: elak duplicate ikut id
    const s = ensureSession(sid);
    const existing = Array.isArray(s.cards) ? s.cards : [];
    const seen = new Set(existing.map((c) => String(c.id)));
    const merged = [...existing];

    for (const c of mapped) {
      const keyId = String(c.id);
      if (seen.has(keyId)) continue;
      merged.push(c);
      seen.add(keyId);
    }

    setSessionCards(sid, merged);
    return { ok: true, imported: mapped.length, total: merged.length };
  } catch (e) {
    console.warn("syncSessionCardsFromS3 failed:", e?.message || e);
    return { ok: false, reason: "error", detail: String(e?.message || e) };
  }
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

/* ======================================================
 * SESSION UNLOCK (Fasilitator sahaja)
 * ====================================================== */
app.post("/api/session/unlock/:sessionId", (req, res) => {
  const sid = String(req.params.sessionId || "").trim();
  const s = ensureSession(sid);
  if (!s) return res.status(400).json({ ok: false, error: "sessionId tidak sah" });

  // buka kunci
  s.langLocked = false;
  s.lockedAt = null;
  s.updatedAt = nowISO();

  return res.json({
    ok: true,
    sessionId: sid,
    lang: String(s.lang || "MS").toUpperCase(),
    langLocked: false,
    unlockedAt: s.updatedAt,
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
      return res.status(400).json({ ok: false, error: "sessionId / cuCode tidak sah" });
    }
    if (!waList.length) {
      return res.status(400).json({ ok: false, error: "waList kosong (tiada WA)" });
    }

    // ===============================
    // EN -> MS (rules ringan, stabil)
    // ===============================
    function cleanFirstPerson(s = "") {
      return String(s)
        .replace(/\b(I|We|Our|Ours|Me|My)\b/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    }

    function msPastify(pcEn = "") {
      let s = cleanFirstPerson(pcEn);

      s = s
        .replace(/\bhas been identified\b/gi, "telah dikenalpasti")
        .replace(/\bhave been identified\b/gi, "telah dikenalpasti")
        .replace(/\bwas identified\b/gi, "telah dikenalpasti")
        .replace(/\bwere identified\b/gi, "telah dikenalpasti")

        .replace(/\bhas been recorded\b/gi, "telah direkodkan")
        .replace(/\bhave been recorded\b/gi, "telah direkodkan")
        .replace(/\bwas recorded\b/gi, "telah direkodkan")
        .replace(/\bwere recorded\b/gi, "telah direkodkan")

        .replace(/\bhas been analysed\b/gi, "telah dianalisis")
        .replace(/\bhave been analysed\b/gi, "telah dianalisis")
        .replace(/\bwas analysed\b/gi, "telah dianalisis")
        .replace(/\bwere analysed\b/gi, "telah dianalisis")
        .replace(/\bhas been analyzed\b/gi, "telah dianalisis")
        .replace(/\bhave been analyzed\b/gi, "telah dianalisis")
        .replace(/\bwas analyzed\b/gi, "telah dianalisis")
        .replace(/\bwere analyzed\b/gi, "telah dianalisis")

        .replace(/\bhas been prepared\b/gi, "telah disediakan")
        .replace(/\bhave been prepared\b/gi, "telah disediakan")
        .replace(/\bwas prepared\b/gi, "telah disediakan")
        .replace(/\bwere prepared\b/gi, "telah disediakan")

        .replace(/\bhas been conducted\b/gi, "telah dilaksanakan")
        .replace(/\bhave been conducted\b/gi, "telah dilaksanakan")
        .replace(/\bwas conducted\b/gi, "telah dilaksanakan")
        .replace(/\bwere conducted\b/gi, "telah dilaksanakan")

        .replace(/\bhas been verified\b/gi, "telah disahkan")
        .replace(/\bhave been verified\b/gi, "telah disahkan")
        .replace(/\bwas verified\b/gi, "telah disahkan")
        .replace(/\bwere verified\b/gi, "telah disahkan")

        .replace(/\bhas been reviewed\b/gi, "telah disemak")
        .replace(/\bhave been reviewed\b/gi, "telah disemak")
        .replace(/\bwas reviewed\b/gi, "telah disemak")
        .replace(/\bwere reviewed\b/gi, "telah disemak");

      s = s
        .replace(/\bin accordance with\b/gi, "berdasarkan")
        .replace(/\bas per\b/gi, "mengikut")
        .replace(/\baccording to\b/gi, "berdasarkan")
        .replace(/\bin the (system|systems) specified\b/gi, "dalam sistem yang ditetapkan")
        .replace(/\bin the specified system\b/gi, "dalam sistem yang ditetapkan");

      s = s.replace(/\s{2,}/g, " ").trim();
      if (s && !/[.!?]$/.test(s)) s += ".";
      return s;
    }

    // ----------------------------
    // Fallback generator (no AI)
    // ----------------------------
    function fallbackSeed(waTitle, idx) {
      const base = [
        {
          ws: "Kenal pasti keperluan dan persediaan awal.",
          pc: "Keperluan dan persediaan awal telah dikenalpasti berdasarkan keperluan operasi.",
        },
        {
          ws: "Sediakan peralatan dan bahan mengikut SOP.",
          pc: "Peralatan dan bahan telah disediakan mengikut prosedur operasi standard yang ditetapkan.",
        },
        {
          ws: "Laksanakan langkah kerja mengikut turutan.",
          pc: "Langkah kerja telah dilaksanakan mengikut turutan yang ditetapkan dengan tepat.",
        },
        {
          ws: "Semak hasil kerja dan buat pembetulan jika perlu.",
          pc: "Hasil kerja telah disemak dan pembetulan dibuat bagi memastikan pematuhan keperluan.",
        },
        {
          ws: "Rekod dan laporkan pelaksanaan.",
          pc: "Pelaksanaan kerja telah direkod dan dilaporkan mengikut sistem pelaporan yang ditetapkan.",
        },
      ].slice(0, wsPerWa);

      return {
        waId: "",
        waTitle: waTitle || `WA${idx + 1}`,
        workSteps: base.map((item, i) => ({
          wsId: "",
          wsNo: `${idx + 1}.${i + 1}`,
          wsText: item.ws,
          pc: {
            verb: "",
            object: "",
            qualifier: "",
            pcText: item.pc, // ✅ past tense, outcome-based
          },
        })),
      };
    }

    // ----------------------------
    // AI call (optional)
    // ----------------------------
    const prompt = {
      role: "user",
      content: `
Anda penulis standard kerja NOSS. Hasilkan WS dan PC (past tense, outcome-based) dalam Bahasa Malaysia.
Pastikan PC menunjukkan hasil WS, bukan arahan.

CU: ${cuCode} — ${cuTitle}
WA List:
${waList.map((x, i) => `${i + 1}) ${x}`).join("\n")}

Pulangkan JSON SAHAJA dengan format:
{
  "workActivities": [
    {
      "waTitle": "...",
      "workSteps": [
        { "wsNo":"1.1", "wsText":"...", "pc":{ "verb":"...", "object":"...", "qualifier":"...", "pcText":"..." } }
      ]
    }
  ]
}
Tiada teks lain selain JSON.
`.trim(),
    };

    // Jika tiada API key, terus fallback (supaya deploy tak fail)
    if (!process.env.OPENAI_API_KEY) {
      const workActivities = waList.map((waTitle, idx) => fallbackSeed(waTitle, idx));
      return res.json({ ok: true, mode: "fallback_no_key", workActivities });
    }

const out = await client.chat.completions.create({
  model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  temperature: 0.3,
  response_format: { type: "json_object" },
  messages: [
    { role: "system", content: "JSON sahaja." },
    prompt,
  ],
});

const raw = out?.choices?.[0]?.message?.content || "{}";

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  const workActivities = waList.map((waTitle, idx) => fallbackSeed(waTitle, idx));
  return res.json({ ok: true, mode: "fallback_bad_json", note: raw, workActivities });
}
    
    const workActivities = Array.isArray(parsed?.workActivities) ? parsed.workActivities : [];

    // Post-process: pastify pcText (kalau AI bagi EN / bukan past tense)
    const normalized = workActivities.map((wa, waIdx) => ({
      waId: "",
      waTitle: String(wa?.waTitle || waList[waIdx] || `WA${waIdx + 1}`).trim(),
      workSteps: Array.isArray(wa?.workSteps)
        ? wa.workSteps.slice(0, wsPerWa).map((ws, i) => {
            const pcTextRaw = String(ws?.pc?.pcText || "").trim();
            // jika nampak english passive, convert; kalau sudah BM elok, biar
            const pcText = /has been|have been|was |were |in accordance with|according to/i.test(pcTextRaw)
              ? msPastify(pcTextRaw)
              : (pcTextRaw && !/[.!?]$/.test(pcTextRaw) ? pcTextRaw + "." : pcTextRaw);

            return {
              wsId: "",
              wsNo: ws?.wsNo || `${waIdx + 1}.${i + 1}`,
              wsText: String(ws?.wsText || "").trim(),
              pc: {
                verb: String(ws?.pc?.verb || "").trim(),
                object: String(ws?.pc?.object || "").trim(),
                qualifier: String(ws?.pc?.qualifier || "").trim(),
                pcText: pcText || fallbackSeed("", waIdx).workSteps[i]?.pc?.pcText || "",
              },
            };
          })
        : fallbackSeed("", waIdx).workSteps,
    }));

    return res.json({ ok: true, mode: "ai", workActivities: normalized });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});


// ===============================
// EN -> MS (rules ringan, stabil)
// ===============================
function cleanFirstPerson(s = "") {
  return String(s)
    .replace(/\b(I|We|Our|Ours|Me|My)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function msPastify(pcEn = "") {
  let s = cleanFirstPerson(pcEn);

  // Core passive patterns
  s = s
    .replace(/\bhas been identified\b/gi, "telah dikenalpasti")
    .replace(/\bhave been identified\b/gi, "telah dikenalpasti")
    .replace(/\bwas identified\b/gi, "telah dikenalpasti")
    .replace(/\bwere identified\b/gi, "telah dikenalpasti")

    .replace(/\bhas been recorded\b/gi, "telah direkodkan")
    .replace(/\bhave been recorded\b/gi, "telah direkodkan")
    .replace(/\bwas recorded\b/gi, "telah direkodkan")
    .replace(/\bwere recorded\b/gi, "telah direkodkan")

    .replace(/\bhas been analysed\b/gi, "telah dianalisis")
    .replace(/\bhave been analysed\b/gi, "telah dianalisis")
    .replace(/\bwas analysed\b/gi, "telah dianalisis")
    .replace(/\bwere analysed\b/gi, "telah dianalisis")
    .replace(/\bhas been analyzed\b/gi, "telah dianalisis")
    .replace(/\bhave been analyzed\b/gi, "telah dianalisis")
    .replace(/\bwas analyzed\b/gi, "telah dianalisis")
    .replace(/\bwere analyzed\b/gi, "telah dianalisis")

    .replace(/\bhas been prepared\b/gi, "telah disediakan")
    .replace(/\bhave been prepared\b/gi, "telah disediakan")
    .replace(/\bwas prepared\b/gi, "telah disediakan")
    .replace(/\bwere prepared\b/gi, "telah disediakan")

    .replace(/\bhas been conducted\b/gi, "telah dilaksanakan")
    .replace(/\bhave been conducted\b/gi, "telah dilaksanakan")
    .replace(/\bwas conducted\b/gi, "telah dilaksanakan")
    .replace(/\bwere conducted\b/gi, "telah dilaksanakan")

    .replace(/\bhas been verified\b/gi, "telah disahkan")
    .replace(/\bhave been verified\b/gi, "telah disahkan")
    .replace(/\bwas verified\b/gi, "telah disahkan")
    .replace(/\bwere verified\b/gi, "telah disahkan")

    .replace(/\bhas been reviewed\b/gi, "telah disemak")
    .replace(/\bhave been reviewed\b/gi, "telah disemak")
    .replace(/\bwas reviewed\b/gi, "telah disemak")
    .replace(/\bwere reviewed\b/gi, "telah disemak");

  // Common phrases (optional, boleh tambah ikut domain)
  s = s
    .replace(/\bin accordance with\b/gi, "berdasarkan")
    .replace(/\bas per\b/gi, "mengikut")
    .replace(/\baccording to\b/gi, "berdasarkan")
    .replace(/\bin the (system|systems) specified\b/gi, "dalam sistem yang ditetapkan")
    .replace(/\bin the specified system\b/gi, "dalam sistem yang ditetapkan");

  // Kemas ayat
  s = s.replace(/\s{2,}/g, " ").trim();
  // Pastikan ada noktah
  if (s && !/[.!?]$/.test(s)) s += ".";
  return s;
}

// WS English (imperative) -> WS BM (imperatif) — rules ringan
function msImperative(wsEn = "") {
  let s = cleanFirstPerson(wsEn);

  // verb awal ayat (simple mapping)
  s = s
    .replace(/^\s*Identify\b/i, "Kenal pasti")
    .replace(/^\s*Record\b/i, "Rekod")
    .replace(/^\s*Analyze\b/i, "Analisis")
    .replace(/^\s*Analyse\b/i, "Analisis")
    .replace(/^\s*Prepare\b/i, "Sediakan")
    .replace(/^\s*Review\b/i, "Semak")
    .replace(/^\s*Verify\b/i, "Sahkan")
    .replace(/^\s*Conduct\b/i, "Laksanakan")
    .replace(/^\s*Compile\b/i, "Kumpulkan")
    .replace(/^\s*Summarize\b/i, "Sediakan ringkasan")
    .replace(/^\s*Plan\b/i, "Rancang")
    .replace(/^\s*Implement\b/i, "Laksanakan");

  s = s.replace(/\s{2,}/g, " ").trim();
  if (s && !/[.!?]$/.test(s)) s += ".";
  return s || wsEn;
}

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

    // ✅ penting: tarik kad terbaru dari LiveBoard (S3) jika ada
    await syncSessionCardsFromS3(sid);

    const items = getSessionCards(sid);
    if (items.length < 5) return res.status(400).json({ error: "Terlalu sedikit kad untuk clustering (min 5)" });

    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY belum diset" });

    const cards = items.map((c) => ({ id: c.id, activity: getCardText(c) })).filter((c) => c.activity);
    const validIds = new Set(cards.map((c) => String(c.id).trim()));

    const normId = (v) => {
      if (v === null || v === undefined) return "";
      const s = String(v).trim();
      if (s === "null" || s === "undefined") return "";
      return s;
    };

    const sanitizeIds = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .map(normId)
        .filter((id) => id && validIds.has(id));

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
  "clusters":[{"title":"...","cardIds":["<ID>","<ID>"]}],
  "unassigned":[]
}

IMPORTANT:
- Each cardId MUST be EXACTLY one of the IDs shown in parentheses before each activity.
- cardIds MUST be strings, do NOT invent new IDs, do NOT convert IDs to numbers.

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

/**
 * ===============================
 * RULE ENGINE: Performance Criteria (PC)
 * Regulator / JPK Style
 * ===============================
 */
function buildPcMS({ wsText = "", context = {} }) {
  const t = wsText.toLowerCase();

  // Default qualifier (paling selamat)
  let qualifier = "mengikut tatacara yang ditetapkan";

  // RULE: waktu solat
  if (t.includes("waktu solat")) {
    qualifier = "berdasarkan jadual waktu solat";
  }

  // RULE: wuduk
  else if (t.includes("wuduk")) {
    qualifier = "mengikut tatacara wuduk yang ditetapkan";
  }

  // RULE: pakaian imam
  else if (t.includes("pakaian")) {
    qualifier = "berdasarkan ketetapan yang ditetapkan";
  }

  // RULE: saf / jemaah
  else if (t.includes("saf") || t.includes("jemaah")) {
    qualifier = "mengikut susunan saf solat berjemaah";
  }

  // RULE: arahan / penyampaian
  else if (t.includes("arahan") || t.includes("sampaikan")) {
    qualifier = "disampaikan kepada jemaah dengan jelas";
  }

  // RULE: pelaksanaan solat
  else if (t.includes("laksana") || t.includes("imamkan")) {
    qualifier = "mengikut tatacara solat yang ditetapkan";
  }

  // RULE: wirid / doa
  else if (t.includes("wirid") || t.includes("doa")) {
    qualifier = "mengikut doa yang ditetapkan";
  }

  // Tentukan verb pasif
  let verb = "dilaksanakan";
  if (t.includes("kenal pasti")) verb = "ditentukan";
  else if (t.includes("ambil")) verb = "diambil";
  else if (t.includes("pakai")) verb = "dipakai";
  else if (t.includes("ambil tempat")) verb = "dikenal pasti";
  else if (t.includes("sampaikan")) verb = "disampaikan";
  else if (t.includes("baca")) verb = "dibaca";
  else if (t.includes("laksana") || t.includes("imamkan")) verb = "dilaksanakan";

  // Object = buang kata kerja depan
  const object = wsText
    .replace(/^kenal pasti/i, "")
    .replace(/^ambil/i, "")
    .replace(/^pakai/i, "")
    .replace(/^ambil tempat/i, "")
    .replace(/^sampaikan/i, "")
    .replace(/^laksana/i, "")
    .replace(/^imamkan/i, "")
    .replace(/^baca/i, "")
    .trim();

  return {
    verb,
    object,
    qualifier,
    pcText: `${object} telah ${verb} ${qualifier}.`
      .replace(/\s+/g, " ")
      .trim(),
  };
}

function padWorkStepsToMin({
  lang,
  wa,
  waIndex,
  workSteps,
  minWS = 3,
}) {
  const out = Array.isArray(workSteps) ? [...workSteps] : [];
  const missing = Math.max(0, minWS - out.length);
  if (!missing) return out;

  // WS tambahan yang selamat & generik (regulator-friendly)
  const extraMs = [
    "Semak pematuhan dokumen/rekod yang disediakan.",
    "Failkan dan kemas kini rekod dalam sistem yang ditetapkan.",
  ];
  const extraEn = [
    "Verify outputs and compliance against requirements.",
    "File and update records in the designated system.",
  ];

  const extras = lang === "MS" ? extraMs : extraEn;

  for (let k = 0; k < missing; k++) {
    const idx = out.length; // indeks baru dalam array
    const wsNo = `${waIndex + 1}.${idx + 1}`;
    const wsText = extras[Math.min(k, extras.length - 1)];

    let pcAuto;
    if (lang === "MS") {
      pcAuto = buildPcMS({ wsText });
    } else {
      // fallback EN (VOC kosong pun ok, tapi lebih baik isi)
      const verb = "verified";
      const object = "Outputs and compliance";
      const qualifier = "against requirements and procedures";
      pcAuto = {
        verb,
        object,
        qualifier,
        pcText: makePcText({ lang: "EN", verb, object, qualifier }),
      };
    }

    out.push({
      wsId: `${wa?.waId || `WA${waIndex + 1}`}-S${idx + 1}`,
      wsNo,
      wsText,
      pc: {
        pcId: `${wa?.waId || `WA${waIndex + 1}`}-P${idx + 1}`,
        pcNo: wsNo,
        verb: pcAuto.verb,
        object: pcAuto.object,
        qualifier: pcAuto.qualifier,
        pcText: pcAuto.pcText,
      },
    });
  }

  return out;
}

/**
 * AI-Assisted CP Draft (Paparan 2)
 * - CU & WA LOCKED ikut CPC
 * - min 3 WS per WA
 * - 1 PC per WS (ayat "Telah ..." + measurable)
 */
async function generateCpDraft({ sessionId, cpc, cu, ai = {} }) {
  const nowIso = new Date().toISOString();

  const cuCode = String(cu?.cuCode || cu?.cuId || cu?.id || cu?.code || "").trim().toLowerCase();
  const cuTitle = String(cu?.cuTitle || cu?.title || cu?.name || "").trim();

  const wsMin = Math.max(3, Number(ai?.wsMin || 3));
  const pcPerWs = Math.max(1, Number(ai?.pcPerWs || 1)); // kita lock 1
  const language = String(ai?.language || "MS").toUpperCase();

  const waArr = Array.isArray(cu?.wa) ? cu.wa : (Array.isArray(cu?.was) ? cu.was : []);
  const waItemsLocked = waArr
    .map((w) => ({
      waCode: String(w?.waCode || w?.waId || w?.id || w?.code || "").trim().toLowerCase(),
      waTitle: String(w?.waTitle || w?.title || w?.name || "").trim(),
    }))
    .filter((w) => w.waCode && w.waTitle);

  // helper: jadikan wsCode "1.1, 1.2..." ikut WA index
  const makeWsCode = (waIndex1, wsIndex1) => `${waIndex1}.${wsIndex1}`;

  // ====== AI call wrapper ======
  async function callLLM(prompt) {
    // Jika anda sudah ada openai client dalam server.js, gunakan.
    // Contoh umum:
    // const resp = await openai.responses.create({ model: "gpt-4.1-mini", input: prompt });
    // const text = resp.output_text;
    //
    // Jika tiada openai, return null untuk fallback template.
    try {
      if (!globalThis.openai) return null; // <-- anda boleh tukar ke variable openai sebenar
      const resp = await globalThis.openai.responses.create({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        input: prompt,
      });
      const text = resp?.output_text || "";
      return String(text || "").trim();
    } catch (e) {
      console.error("LLM error:", e?.message || e);
      return null;
    }
  }

  // ====== Prompt builder (MS, measurable, past tense) ======
  function buildPrompt({ cuTitle, waTitle, wsMin }) {
    return `
Anda ialah pembangun National Occupational Skills Standard (NOSS) Malaysia.

COMPETENCY UNIT (CU):
${cuTitle}

WORK ACTIVITY (WA):
${waTitle}

TUGAS:
1) Jana minimum ${wsMin} WORK STEP (WS) untuk melengkapkan proses kerja WA ini.
2) Setiap WS mesti bermula dengan kata kerja tindakan (contoh: Semak, Rekod, Sedia, Laksana, Sahkan, Susun, Laporkan).
3) Untuk setiap WS, jana 1 PERFORMANCE CRITERIA (PC).
4) PC mesti dalam ayat PAST TENSE (mula dengan "Telah ...") dan BOLEH DIUKUR berdasarkan bukti seperti rekod, dokumen, prosedur, borang, jadual, laporan, semakan, pengesahan.
5) Jangan ulang ayat WA sebagai WS.
6) Jangan guna perkataan kabur seperti "dengan baik", "sewajarnya", "secukupnya".

FORMAT OUTPUT (JSON SAHAJA, tanpa teks lain):
{
  "ws": [
    { "wsTitle": "...", "pc": "Telah ..." }
  ]
}
`.trim();
  }

  // ====== parse JSON safely ======
  function tryParseJson(text) {
    if (!text) return null;
    const t = String(text).trim();

    // kadang model balas dengan ```json ... ```
    const m = t.match(/```json([\s\S]*?)```/i);
    const raw = m ? m[1].trim() : t;

    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  // ====== fallback template jika AI gagal ======
  function fallbackWsPc(waTitle, wsMin) {
    // Template generik tetapi masih ikut rules (boleh ubah nanti)
    const base = [
      {
        wsTitle: `Semak keperluan kerja bagi "${waTitle}" berdasarkan SOP/rekod berkaitan.`,
        pc: `Keperluan kerja telah disemak dan direkodkan berdasarkan SOP/rekod yang berkaitan.`,
      },
      {
        wsTitle: `Sediakan dokumen/borang/jadual pelaksanaan untuk "${waTitle}".`,
        pc: `Dokumen/borang/jadual pelaksanaan telah disediakan lengkap dan boleh disemak.`,
      },
      {
        wsTitle: `Laksanakan "${waTitle}" dan rekodkan pelaksanaan serta bukti kerja.`,
        pc: `Pelaksanaan kerja telah direkodkan bersama bukti seperti laporan/rekod/borang yang berkaitan.`,
      },
      {
        wsTitle: `Semak hasil pelaksanaan "${waTitle}" dan buat tindakan susulan jika perlu.`,
        pc: `Hasil pelaksanaan telah disemak dan tindakan susulan telah direkodkan jika diperlukan.`,
      },
    ];
    return base.slice(0, Math.max(3, wsMin));
  }

  // ====== generate waItems with AI ======
  const waItems = [];

  for (let i = 0; i < waItemsLocked.length; i++) {
    const waIndex1 = i + 1;
    const wa = waItemsLocked[i];

    let wsRows = null;

    // call AI
    const prompt = buildPrompt({ cuTitle, waTitle: wa.waTitle, wsMin });
    const llmText = await callLLM(prompt);
    const parsed = tryParseJson(llmText);

    if (parsed && Array.isArray(parsed.ws) && parsed.ws.length) {
      wsRows = parsed.ws
        .map((x) => ({
          wsTitle: String(x?.wsTitle || "").trim(),
          pc: String(x?.pc || "").trim(),
        }))
        .filter((x) => x.wsTitle && x.pc);

      // enforce min ws
      if (wsRows.length < wsMin) {
        const extra = fallbackWsPc(wa.waTitle, wsMin - wsRows.length).map((x) => ({
          wsTitle: x.wsTitle,
          pc: x.pc,
        }));
        wsRows = wsRows.concat(extra).slice(0, wsMin);
      }
    } else {
      // fallback
      wsRows = fallbackWsPc(wa.waTitle, wsMin);
    }

    // enforce pcPerWs=1 (lock)
    const ws = wsRows.slice(0, wsMin).map((row, j) => {
      const wsIndex1 = j + 1;
      const wsCode = makeWsCode(waIndex1, wsIndex1);

      // ensure PC starts with "Telah"
      let pc = String(row.pc || "").trim();
      if (pc && !/^telah\b/i.test(pc)) pc = `Telah ${pc.replace(/^\s+/, "")}`;

      return {
        wsCode,
        wsTitle: String(row.wsTitle || "").trim() || "xxx",
        pc: pc || "Telah xxx",
      };
    });

    waItems.push({
      waCode: wa.waCode,
      waTitle: wa.waTitle,
      ws,
    });
  }

  // Output draft yang boleh terus render Paparan 2
  return {
    ok: true,
    kind: "cpDraft",
    sessionId,
    lang: language,
    generatedAt: nowIso,
    cuCode,
    cuTitle,
    waItems,
    rules: {
      waLockedFromCpc: true,
      wsMin,
      pcPerWs,
      pcStyle: "past_tense_ms",
      measurable: true,
    },
  };
}

function validateCp(cp) {
  const issues = [];

  // ---- Detect structure (new vs legacy) ----
  const waItemsNew = Array.isArray(cp?.waItems) ? cp.waItems : null; // NEW (Paparan 2)
  const waItemsLegacy = Array.isArray(cp?.workActivities) ? cp.workActivities : null; // LEGACY

  // Normalize WA list
  const waList = waItemsNew || waItemsLegacy || [];

  const waCount = waList.length;

  // NOTE: WA minimum ikut spec anda.
  // Kalau anda nak "ikut CPC", boleh longgarkan, tapi saya kekalkan requirement asal (>=3).
  if (waCount < 3) {
    issues.push({
      level: "ERROR",
      code: "MIN_WA",
      msg: "Setiap CU mesti ada sekurang-kurangnya 3 WA.",
    });
  }

  let minWsOk = true;
  let onePcOk = true;
  let pastTenseOk = true;

  for (let i = 0; i < waList.length; i++) {
    const wa = waList[i];

    // NEW: wa.ws ; LEGACY: wa.workSteps
    const wsList =
      (Array.isArray(wa?.ws) && wa.ws) ||
      (Array.isArray(wa?.workSteps) && wa.workSteps) ||
      [];

    const waTitle =
      String(wa?.waTitle || wa?.title || wa?.name || wa?.waId || wa?.waCode || `WA#${i + 1}`).trim();

    if (wsList.length < 3) {
      minWsOk = false;
      issues.push({
        level: "ERROR",
        code: "MIN_WS",
        msg: `WA "${waTitle}" mesti ada sekurang-kurangnya 3 WS.`,
      });
    }

    for (let j = 0; j < wsList.length; j++) {
      const step = wsList[j];

      // NEW: step.pc ; LEGACY: step.pc
      const pc = String(step?.pc || step?.performanceCriteria || step?.criteria || "").trim();

      const wsId =
        String(step?.wsCode || step?.wsNo || step?.wsId || `${i + 1}.${j + 1}`).trim();

      if (!pc) {
        onePcOk = false;
        issues.push({
          level: "ERROR",
          code: "MISSING_PC",
          msg: `WS "${wsId}" mesti ada 1 PC.`,
        });
      } else {
        // OPTIONAL (tapi sangat berguna): past tense "Telah ..."
        // Jika anda nak wajib, kekalkan ERROR. Jika nak warning, tukar level ke "WARN".
        if (!/^telah\b/i.test(pc)) {
          pastTenseOk = false;
          issues.push({
            level: "WARN",
            code: "PC_NOT_PAST_TENSE",
            msg: `PC untuk WS "${wsId}" sebaiknya bermula dengan "Telah ..." (ayat past tense yang boleh diukur).`,
          });
        }
      }
    }
  }

  const minRulesPassed = waCount >= 3 && minWsOk && onePcOk;

  return {
    ok: minRulesPassed,
    minRulesPassed,
    issues,
    stats: {
      waCount,
      minWsOk,
      onePcOk,
      pastTenseOk,
      mode: waItemsNew ? "NEW_WAITEMS" : waItemsLegacy ? "LEGACY_WORKACTIVITIES" : "EMPTY",
    },
  };
}

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

    const cp = await generateCpDraft({
      sessionId,
      cpc,
      cu: cuFromCpc,
      ai: req.body?.ai || {},     // ambil rules dari frontend (optional)
    });

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

const myspikeIndexStore = {}; // global / module-level

app.post("/api/myspike/index/build", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "sessionId diperlukan" });
  }

  const cus = getSessionCus(sessionId);
  if (!cus || !cus.length) {
    return res.status(400).json({ ok: false, error: "Tiada CU untuk bina index" });
  }

  // 🔑 bina embedding / index
  const index = await buildMySpikeIndexFromCus(cus);

  // 🔥 SIMPAN DI SINI
  myspikeIndexStore[sessionId] = {
    builtAt: Date.now(),
    count: index.length,
    index
  };

  return res.json({
    ok: true,
    sessionId,
    total: index.length
  });
});
      
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

    const myItems = Array.isArray(MYSPIKE_CU_ITEMS) ? MYSPIKE_CU_ITEMS : [];
    const myEmb = Array.isArray(MYSPIKE_CU_EMB) ? MYSPIKE_CU_EMB : [];

    if (!myItems.length || !myEmb.length || myItems.length !== myEmb.length) {
      return res.status(400).json({
        ok: false,
        error:
          "Index MySPIKE CU masih kosong / tidak lengkap. Sila bina index dulu: POST /api/myspike/index/build",
        debug: {
          items: myItems.length,
          emb: myEmb.length,
          match: myItems.length === myEmb.length,
        },
      });
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

/* ======================================================
 * 3) AI CLUSTER (REAL) - COMPAT ROUTE: /api/cluster/run/:sessionId
 *    (frontend baru cuba endpoint ini dahulu)
 * ====================================================== */
app.post("/api/cluster/run/:sessionId", async (req, res) => {
  try {
    const sid = String(req.params.sessionId || "").trim();
    if (!sid) return res.status(400).json({ error: "sessionId diperlukan" });

    const s = ensureSession(sid);
    if (!s) return res.status(400).json({ error: "sessionId tidak sah" });

    // ✅ penting: tarik kad terbaru dari LiveBoard (S3) jika ada
    await syncSessionCardsFromS3(sid);

    const items = getSessionCards(sid);
    if (items.length < 5) return res.status(400).json({ error: "Terlalu sedikit kad untuk clustering (min 5)" });

    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY belum diset" });

    const cards = items.map((c) => ({ id: c.id, activity: getCardText(c) })).filter((c) => c.activity);
    const validIds = new Set(cards.map((c) => String(c.id).trim()));

    const normId = (v) => {
      if (v === null || v === undefined) return "";
      const s = String(v).trim();
      if (s === "null" || s === "undefined") return "";
      return s;
    };

    const sanitizeIds = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .map(normId)
        .filter((id) => id && validIds.has(id));

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
  "clusters":[{"title":"...","cardIds":["<ID>","<ID>"]}],
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
    console.error("cluster run/:sessionId error:", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

/* =========================
 * SERVER START (PALING BAWAH)/* =========================
 * SERVER START (PALING BAWAH)
 * ========================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("🚀 Server listening on", PORT);
});
