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
 * FASA 3: CP BUILDER (LOCKED CONTRACT v1.0)
 * - CP ikut bahasa CPC (BM/EN)
 * - CU & WA mesti exact match dari CPC (/api/cpc/:sessionId)
 * - Min: CU>=3 WA, WA>=3 WS, WS=1 PC (VOC)
 * - WS lengkap mula→akhir (validator basic)
 * ====================================================== */

// ------------------------------
// CP In-Memory Store (boleh tukar DB kemudian)
// ------------------------------
const cpStore = {}; 
// shape: cpStore[sessionId][cuId] = { latestVersion: "v1", versions: [{version, cp}] }

function _ensureCpBucket(sessionId) {
  if (!cpStore[sessionId]) cpStore[sessionId] = {};
  return cpStore[sessionId];
}

function _getLatestCp(sessionId, cuId) {
  const bucket = cpStore?.[sessionId]?.[cuId];
  if (!bucket || !bucket.versions?.length) return null;
  return bucket.versions[bucket.versions.length - 1];
}

function _saveCpVersion(sessionId, cuId, cp, { bumpVersion = false } = {}) {
  const bucket = _ensureCpBucket(sessionId);
  if (!bucket[cuId]) bucket[cuId] = { latestVersion: null, versions: [] };

  const cur = bucket[cuId];
  let nextV = "v1";
  if (cur.versions.length) {
    const lastV = cur.versions[cur.versions.length - 1].version || "v1";
    const n = Number(String(lastV).replace(/^v/i, "")) || 1;
    nextV = bumpVersion ? `v${n + 1}` : lastV; // save working overwrite uses same version
  }

  // overwrite if same version (WORKING save)
  const idx = cur.versions.findIndex((x) => x.version === nextV);
  const payload = { version: nextV, cp };

  if (idx >= 0) cur.versions[idx] = payload;
  else cur.versions.push(payload);

  cur.latestVersion = nextV;
  return nextV;
}

// ------------------------------
// CPC fetch helper (source of truth)
// ------------------------------
async function fetchCpcFinal(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) throw new Error("sessionId kosong");

  // NOTE: endpoint sedia ada (confirmed dari Network)
  const url = `https://dacum-backend.onrender.com/api/cpc/${encodeURIComponent(sid)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Gagal fetch CPC (${r.status})`);
  const json = await r.json();
  return json;
}

// ------------------------------
// Bahasa: ikut CPC (BM/EN)
// ------------------------------
function detectLanguageFromCpc(cpc) {
  const raw =
    String(cpc?.language || cpc?.bahasa || cpc?.lang || cpc?.meta?.language || "").trim();

  if (/^ms|bm|malay|bahasa/i.test(raw)) return "MS";
  if (/^en|english/i.test(raw)) return "EN";

  // fallback infer dari teks CU/WA
  const sample =
    String(cpc?.terasTitle || "") +
    " " +
    String(cpc?.teras || "") +
    " " +
    JSON.stringify(cpc?.cus || cpc?.data?.cus || cpc?.cpc?.cus || "").slice(0, 400);

  // heuristik ringkas
  if (/\b(dan|urus|pengurusan|penilaian|penyediaan|laksana|rancang|analisis|sediakan|jana)\b/i.test(sample))
    return "MS";

  return "EN";
}

// ------------------------------
// Normalizer: extract CU list dari CPC JSON (tahan variasi)
// ------------------------------
function extractCusFromCpc(cpc) {
  const cus =
    cpc?.cus ||
    cpc?.data?.cus ||
    cpc?.cpc?.cus ||
    cpc?.result?.cus ||
    [];

  if (!Array.isArray(cus)) return [];
  return cus;
}

function findCuInCpc(cpc, cuId) {
  const cus = extractCusFromCpc(cpc);
  const target = String(cuId || "").trim().toLowerCase();
  return cus.find((c) => String(c?.cuId || c?.id || "").trim().toLowerCase() === target) || null;
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
// Generator: WS + PC (VOC) ikut WA title (EN/MS)
// ------------------------------
function makePcText({ lang, verb, object, qualifier }) {
  if (lang === "MS") {
    // BM: pasif hasil (lebih regulator-friendly)
    const q = qualifier ? ` ${qualifier}` : "";
    return `${object} ${verb}${q}.`.replace(/\s+/g, " ").trim();
  }
  // EN
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

  // fallback generic
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
    cpId: null, // filled on lock
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
        const verb = tpl.verb;
        const object = tpl.object;
        const qualifier = tpl.qualifier;

        return {
          wsId: `${wa.waId || `WA${i + 1}`}-S${idx + 1}`,
          wsNo,
          wsText: tpl.ws,
          pc: {
            pcId: `${wa.waId || `WA${i + 1}`}-P${idx + 1}`,
            pcNo: wsNo,
            verb,
            object,
            qualifier,
            pcText: makePcText({ lang, verb, object, qualifier }),
          },
        };
      });

      return {
        waId: wa.waId || `C${i + 1}-W01`,
        waCode: wa.waCode || wa.waId || "",
        waTitle: wa.waTitle || "",
        workSteps,
      };
    }),
    validation: {
      minRulesPassed: false,
      vocPassed: false,
      completenessPassed: false,
      issues: [],
    },
    audit: {
      createdAt: new Date().toISOString(),
      createdBy: "AI",
      updatedAt: new Date().toISOString(),
      updatedBy: ["AI"],
      lockedAt: null,
      lockedBy: null,
    },
  };

  return cp;
}

// ------------------------------
// Validator: Min + VOC + Completeness (basic)
// ------------------------------
function validateCp(cp, { cpc, cuFromCpc } = {}) {
  const issues = [];

  // 1) CPC exact match (CU/WA)
  if (cpc && cuFromCpc) {
    const expectedCuTitle = String(cuFromCpc?.cuTitle || cuFromCpc?.title || "").trim();
    const actualCuTitle = String(cp?.cu?.cuTitle || "").trim();
    if (expectedCuTitle && actualCuTitle && expectedCuTitle !== actualCuTitle) {
      issues.push({ level: "ERROR", code: "CPC_MISMATCH_CU_TITLE", msg: "Tajuk CU tidak sama seperti CPC (exact match wajib)." });
    }

    const expectedWA = extractWaFromCu(cuFromCpc).map((w) => String(w.waTitle || "").trim());
    const actualWA = (cp?.workActivities || []).map((w) => String(w.waTitle || "").trim());

    // Semak semua WA CP wujud dalam CPC & sama
    for (const t of actualWA) {
      if (t && !expectedWA.includes(t)) {
        issues.push({ level: "ERROR", code: "CPC_MISMATCH_WA_TITLE", msg: `Tajuk WA tidak sama seperti CPC: "${t}"` });
      }
    }
  }

  // 2) Minimum rules
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

  // 3) VOC
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

  // 4) Completeness (basic): WS mesti ada sekurang-kurangnya 3 step dan ada unsur "semak/verify" & "rekod/simpan/submit"
  let completenessPassed = true;
  for (const wa of cp?.workActivities || []) {
    const text = (wa?.workSteps || []).map((s) => String(s?.wsText || "")).join(" ").toLowerCase();
    const hasCheck = /(review|verify|validate|audit|semak|sahkan|validasi|pengesahan)/i.test(text);
    const hasRecord = /(record|document|file|submit|report|rekod|dokumen|fail|serah|lapor|pemfailan)/i.test(text);

    if (!hasCheck || !hasRecord) {
      completenessPassed = false;
      issues.push({
        level: "WARNING",
        code: "WS_INCOMPLETE",
        msg: `WA "${wa?.waTitle || wa?.waId}" mungkin belum lengkap (tiada elemen semakan/pengesahan atau rekod/serahan).`,
      });
    }
  }

  return {
    minRulesPassed,
    vocPassed,
    completenessPassed,
    issues,
  };
}

// ------------------------------
// API: CP Draft / Get / Save / Validate / Lock
// ------------------------------
app.post("/api/cp/draft", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    const cuId = String(req.body?.cuId || "").trim();
    if (!sessionId || !cuId) return res.status(400).json({ error: "sessionId dan cuId wajib." });

    const cpc = await fetchCpcFinal(sessionId);
    const cuFromCpc = findCuInCpc(cpc, cuId);
    if (!cuFromCpc) return res.status(404).json({ error: "CU tidak ditemui dalam CPC." });

    // Generate draft
    const cp = generateCpDraft({ sessionId, cpc, cu: cuFromCpc });

    // Validate
    const validation = validateCp(cp, { cpc, cuFromCpc });
    cp.validation = validation;

    // Save as v1 (draft)
    _saveCpVersion(sessionId, cuId, cp, { bumpVersion: true });

    return res.json(cp);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.get("/api/cp/:sessionId/:cuId", (req, res) => {
  const sessionId = String(req.params.sessionId || "").trim();
  const cuId = String(req.params.cuId || "").trim();
  const version = String(req.query?.version || "latest").trim();

    const versionQ = String(req.query?.version || "latest").trim();

    const bucket = cpStore?.[sessionId]?.[cuId];
    if (!bucket) {
      return res.status(404).json({ error: "CP belum wujud. Jana draft dahulu." });
    }

    const versions = Array.isArray(bucket.versions) ? bucket.versions : [];
    if (!versions.length) {
      return res.status(404).json({ error: "CP belum wujud. Jana draft dahulu." });
    }

    if (versionQ === "latest") {
      const latest = versions.reduce((a, b) =>
        Number(b.version) > Number(a.version) ? b : a
      );
      return res.json(latest);
    }

    const vNum = Number(versionQ);
    if (!Number.isFinite(vNum) || vNum <= 0) {
      return res.status(400).json({ error: "version tidak sah. Guna ?version=latest atau nombor." });
    }

    const found = versions.find((x) => Number(x.version) === vNum);
    if (!found) {
      return res.status(404).json({ error: "Versi CP tidak ditemui." });
    }

    return res.json(found);
    });

app.put("/api/cp/:sessionId/:cuId", async (req, res) => {
  try {
    const sessionId = String(req.params.sessionId || "").trim();
    const cuId = String(req.params.cuId || "").trim();
    const cp = req.body;

    if (!cp || typeof cp !== "object") return res.status(400).json({ error: "Body CP JSON diperlukan." });

    // Re-validate vs CPC
    const cpc = await fetchCpcFinal(sessionId);
    const cuFromCpc = findCuInCpc(cpc, cuId);
    if (!cuFromCpc) return res.status(404).json({ error: "CU tidak ditemui dalam CPC." });

    const validation = validateCp(cp, { cpc, cuFromCpc });
    cp.validation = validation;
    cp.audit = cp.audit || {};
    cp.audit.updatedAt = new Date().toISOString();
    cp.audit.updatedBy = Array.isArray(cp.audit.updatedBy) ? cp.audit.updatedBy : [];
    if (!cp.audit.updatedBy.includes("FACILITATOR")) cp.audit.updatedBy.push("FACILITATOR");

    // Save working to latest version (overwrite same)
    const ver = _saveCpVersion(sessionId, cuId, cp, { bumpVersion: false });

    return res.json({ ok: true, version: ver, validation });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.post("/api/cp/validate", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    const cuId = String(req.body?.cuId || "").trim();
    const cp = req.body?.cp;

    if (!sessionId || !cuId || !cp) return res.status(400).json({ error: "sessionId, cuId, dan cp wajib." });

    const cpc = await fetchCpcFinal(sessionId);
    const cuFromCpc = findCuInCpc(cpc, cuId);
    if (!cuFromCpc) return res.status(404).json({ error: "CU tidak ditemui dalam CPC." });

    const validation = validateCp(cp, { cpc, cuFromCpc });
    return res.json(validation);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.post("/api/cp/lock", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    const cuId = String(req.body?.cuId || "").trim();
    const lockedBy = String(req.body?.lockedBy || "PANEL").trim();

    const latest = _getLatestCp(sessionId, cuId);
    if (!latest) return res.status(404).json({ error: "CP belum wujud. Jana draft dahulu." });

    const cpc = await fetchCpcFinal(sessionId);
    const cuFromCpc = findCuInCpc(cpc, cuId);
    if (!cuFromCpc) return res.status(404).json({ error: "CU tidak ditemui dalam CPC." });

    // Re-validate sebelum lock
    const cp = latest.cp;
    const validation = validateCp(cp, { cpc, cuFromCpc });
    cp.validation = validation;

    const hasError = (validation.issues || []).some((x) => x.level === "ERROR");
    if (hasError) {
      return res.status(400).json({ error: "Tak boleh LOCK kerana ada ERROR pada validation.", validation });
    }

    cp.status = "LOCKED";
    cp.audit = cp.audit || {};
    cp.audit.lockedAt = new Date().toISOString();
    cp.audit.lockedBy = lockedBy;

    // bump version untuk lock (v2, v3...)
    const ver = _saveCpVersion(sessionId, cuId, cp, { bumpVersion: true });
    cp.cpId = `${sessionId}-${cuId}-${ver}`;

    return res.json({ ok: true, cpId: cp.cpId, version: ver, validation });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// export JSON (docx/pdf kemudian)
app.get("/api/cp/export/:sessionId/:cuId", (req, res) => {
  const sessionId = String(req.params.sessionId || "").trim();
  const cuId = String(req.params.cuId || "").trim();
  const format = String(req.query?.format || "json").trim().toLowerCase();

  const latest = _getLatestCp(sessionId, cuId);
  if (!latest) return res.status(404).json({ error: "CP belum wujud." });

  if (format !== "json") return res.status(400).json({ error: "Buat masa ini hanya format=json disokong." });

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.send(JSON.stringify(latest.cp, null, 2));
});

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

      // ✅ Bahasa NOSS (ditetapkan fasilitator)
      lang: "MS",          // "MS" | "EN"
      langLocked: false,   // lock bila Agreed
      lockedAt: null,
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

/* ======================================================
 * 3A) CP STORE (FASA 3)
 * ====================================================== */
// cpStore[sessionId][cuId] = { latestVersion: number, lockedVersion?: number, versions: { [v]: cpDoc } }

/**
 * Optional tetapi sangat membantu:
 * Jika anda ada cpcStore sedia ada, pastikan ia boleh dicapai:
 * globalThis.cpcStore = cpcStore;
 * globalThis.sessions = sessions;
 */

/** util */
function nowISO() {
  return new Date().toISOString();
}

function normalizeLang(cpc) {
  const lang = (cpc?.language || cpc?.bahasa || cpc?.lang || cpc?.data?.language || "").toString().trim();
  return lang || "auto";
}

/**
 * Ambil CPC ikut sessionId.
 * - (A) guna globalThis.cpcStore jika ada
 * - (B) fallback: jika CPC disimpan dalam sessions[sessionId].cpc
 * - Jika tiada, throw
 */
function getCpcOrThrow(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) throw new Error("sessionId kosong");

  // A) cpcStore (disyorkan)
  if (globalThis.cpcStore && globalThis.cpcStore[sid]) return globalThis.cpcStore[sid];

  // B) fallback jika anda simpan di sessions
  if (globalThis.sessions && globalThis.sessions[sid] && globalThis.sessions[sid].cpc) {
    return globalThis.sessions[sid].cpc;
  }

  // C) jika dalam kod anda ada variable cpcStore (tanpa globalThis), anda boleh set:
  // globalThis.cpcStore = cpcStore;  <-- tambah 1 line sahaja

  throw new Error(`CPC tidak dijumpai untuk session: ${sid}. Pastikan /api/cpc/${sid} berfungsi dan cpcStore di-expose ke globalThis.`);
}

/**
 * Extract CU list dari CPC (kalis peluru)
 */
function extractCuList(cpc) {
  if (!cpc) return [];
  if (Array.isArray(cpc.cus)) return cpc.cus;
  if (Array.isArray(cpc.units)) return cpc.units;
  if (Array.isArray(cpc.competencyUnits)) return cpc.competencyUnits;

  if (cpc.data) {
    if (Array.isArray(cpc.data.cus)) return cpc.data.cus;
    if (Array.isArray(cpc.data.units)) return cpc.data.units;
    if (Array.isArray(cpc.data.competencyUnits)) return cpc.data.competencyUnits;
  }

  const terases = cpc.terases || cpc.terasList || cpc.teras || cpc.data?.terases || [];
  const out = [];
  for (const t of terases) {
    const cuList = t.cus || t.cuList || t.units || t.competencyUnits || [];
    for (const cu of cuList) out.push(cu);
  }
  return out;
}

function getCuId(cu, idx) {
  return cu?.cuId || cu?.id || cu?.code || `C${String(idx + 1).padStart(2, "0")}`;
}
function getCuTitle(cu) {
  return cu?.cuTitle || cu?.title || cu?.name || cu?.cuName || "";
}
function extractWaListFromCu(cu) {
  return cu?.activities || cu?.waList || cu?.workActivities || cu?.was || cu?.wa || [];
}
function getWaId(wa, idx) {
  return wa?.waId || wa?.id || wa?.code || `W${String(idx + 1).padStart(2, "0")}`;
}
function getWaTitle(wa) {
  return wa?.waTitle || wa?.title || wa?.name || wa?.text || "";
}

/**
 * Jana WS+PC minimum (3 steps) per WA.
 * - PC ikut format Verb + Object + Qualifier (VOQ)
 * - Flow lengkap: mula → proses → akhir
 */
function generateWsPcForWa({ lang, cuTitle, waTitle, waId }) {
  const L = String(lang || "").toUpperCase();

  // heuristik ringkas berdasarkan kata kunci WA (EN)
  const t = String(waTitle || "").toLowerCase();

  const isAnalyze = t.includes("analy");
  const isPlan = t.includes("plan");
  const isPerform = t.includes("perform") || t.includes("implement") || t.includes("execute");
  const isEvaluate = t.includes("evaluat") || t.includes("review") || t.includes("assess");
  const isPrepare = t.includes("prepare") || t.includes("generate") || t.includes("report");

  // Template EN
  const EN = () => {
    if (isAnalyze) {
      return [
        {
          wsText: `Identify required information and scope for ${waTitle}.`,
          pcText: `Identify required information and scope for ${waTitle} according to organizational requirements.`,
        },
        {
          wsText: `Review related policies, procedures, and references for ${waTitle}.`,
          pcText: `Review related policies, procedures, and references to ensure ${waTitle} is compliant with guidelines.`,
        },
        {
          wsText: `Confirm findings and document key requirements for follow-up action.`,
          pcText: `Confirm findings and document key requirements in a complete and traceable manner for follow-up action.`,
        },
      ];
    }
    if (isPlan) {
      return [
        {
          wsText: `Define objectives, resources, and timeline for ${waTitle}.`,
          pcText: `Define objectives, resources, and timeline for ${waTitle} according to organizational constraints.`,
        },
        {
          wsText: `Prepare required documents, tools, and approvals to support ${waTitle}.`,
          pcText: `Prepare required documents, tools, and approvals to support ${waTitle} before execution.`,
        },
        {
          wsText: `Finalize the plan and communicate responsibilities to relevant parties.`,
          pcText: `Finalize the plan and communicate responsibilities clearly to ensure ${waTitle} can be executed effectively.`,
        },
      ];
    }
    if (isPerform) {
      return [
        {
          wsText: `Prepare inputs and supporting documents before performing ${waTitle}.`,
          pcText: `Prepare inputs and supporting documents to ensure ${waTitle} can be performed accurately.`,
        },
        {
          wsText: `Execute tasks for ${waTitle} according to procedures and sequence.`,
          pcText: `Execute tasks according to procedures and sequence to complete ${waTitle} within required standards.`,
        },
        {
          wsText: `Record results and store evidence for ${waTitle}.`,
          pcText: `Record results and store evidence in the designated system to ensure ${waTitle} is traceable and auditable.`,
        },
      ];
    }
    if (isEvaluate) {
      return [
        {
          wsText: `Collect relevant data and outputs related to ${waTitle}.`,
          pcText: `Collect relevant data and outputs to evaluate ${waTitle} against agreed criteria.`,
        },
        {
          wsText: `Assess performance, accuracy, and compliance for ${waTitle}.`,
          pcText: `Assess performance, accuracy, and compliance to ensure ${waTitle} meets organizational standards.`,
        },
        {
          wsText: `Document findings and recommend corrective actions if required.`,
          pcText: `Document findings and recommend corrective actions in a clear and actionable manner for improvement.`,
        },
      ];
    }
    if (isPrepare) {
      return [
        {
          wsText: `Gather required records and data for ${waTitle}.`,
          pcText: `Gather required records and data to prepare ${waTitle} in accordance with reporting requirements.`,
        },
        {
          wsText: `Compile and format information to produce the ${waTitle}.`,
          pcText: `Compile and format information to produce the ${waTitle} accurately and consistently.`,
        },
        {
          wsText: `Review, approve, and submit the ${waTitle} to the designated party.`,
          pcText: `Review, approve, and submit the ${waTitle} within the required timeline and distribution procedure.`,
        },
      ];
    }

    // default EN
    return [
      {
        wsText: `Prepare requirements and inputs for ${waTitle}.`,
        pcText: `Prepare requirements and inputs according to procedures to support ${waTitle}.`,
      },
      {
        wsText: `Carry out activities to complete ${waTitle}.`,
        pcText: `Carry out activities according to sequence and standards to complete ${waTitle}.`,
      },
      {
        wsText: `Finalize outputs and record documentation for ${waTitle}.`,
        pcText: `Finalize outputs and record documentation to ensure ${waTitle} is complete, traceable, and auditable.`,
      },
    ];
  };

  // Template BM (jika nanti CPC BM)
  const BM = () => {
    return [
      {
        wsText: `Kenal pasti keperluan dan input bagi ${waTitle}.`,
        pcText: `Kenal pasti keperluan dan input bagi ${waTitle} mengikut prosedur dan keperluan organisasi.`,
      },
      {
        wsText: `Laksanakan aktiviti untuk melengkapkan ${waTitle} mengikut turutan kerja.`,
        pcText: `Laksanakan aktiviti mengikut turutan dan piawaian bagi memastikan ${waTitle} disiapkan dengan betul.`,
      },
      {
        wsText: `Rekod hasil kerja dan simpan dokumen sokongan berkaitan ${waTitle}.`,
        pcText: `Rekod hasil kerja dan simpan dokumen sokongan dalam sistem yang ditetapkan supaya ${waTitle} boleh dijejaki dan diaudit.`,
      },
    ];
  };

  const steps = (L === "BM" || L === "MS" || L === "MY") ? BM() : EN();

  // Bentuk final: wsId + pcId
  return steps.map((s, idx) => {
    const n = String(idx + 1).padStart(2, "0");
    return {
      wsId: `${waId}-S${n}`,
      wsText: s.wsText,
      pcId: `${waId}-P${n}`,
      pcText: s.pcText,
    };
  });
}

/**
 * Validasi minimum (ikut LOCK Prof)
 */
function validateCpDraft(cpDoc) {
  const errors = [];
  const waList = cpDoc?.workActivities || [];

  // WA min 3 (jika CPC ada >=3 — dalam data Office-v3 ada 5)
  if (waList.length < 3) errors.push("WA kurang daripada 3 (minimum).");

  // WS min 3 setiap WA, dan 1 PC setiap WS
  for (const wa of waList) {
    const steps = wa?.workSteps || [];
    if (steps.length < 3) errors.push(`WS kurang daripada 3 untuk WA ${wa.waId}.`);
    for (const st of steps) {
      if (!String(st.pcText || "").trim()) errors.push(`PC tiada untuk WS ${st.wsId}.`);
    }
  }

  return {
    minWaOk: waList.length >= 3,
    minWsOk: waList.every((w) => (w.workSteps || []).length >= 3),
    pcPerWsOk: waList.every((w) => (w.workSteps || []).every((s) => String(s.pcText || "").trim())),
    // pcVoqOk & flowOk boleh diperkemas kemudian (Phase validate)
    pcVoqOk: true,
    flowOk: true,
    errors,
  };
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

app.get("/api/session/config/:sessionId", (req, res) => {
  const sid = String(req.params.sessionId || "").trim();
  const s = ensureSession(sid);

  if (!s) {
    return res.status(400).json({ ok: false, error: "sessionId tidak sah" });
  }

  return res.json({
    ok: true,
    sessionId: sid,
    lang: String(s.lang || "MS").toUpperCase(),   // MS | EN
    langLocked: !!s.langLocked,
    lockedAt: s.lockedAt || null,
  });
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

app.post("/api/session/config/:sessionId", (req, res) => {
  const sid = String(req.params.sessionId || "").trim();
  const s = ensureSession(sid);
  if (!s) return res.status(400).json({ ok: false, error: "sessionId tidak sah" });

  if (s.langLocked) {
    return res.status(400).json({ ok: false, error: "Bahasa sudah dikunci selepas Agreed." });
  }

  const lang = String(req.body?.lang || "").toUpperCase().trim();
  if (!["MS", "EN"].includes(lang)) {
    return res.status(400).json({ ok: false, error: "lang mesti 'MS' atau 'EN'." });
  }

  s.lang = lang;
  s.updatedAt = new Date().toISOString();

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
  s.lockedAt = new Date().toISOString();
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
 * 3B) CP DRAFT GENERATOR
 * ====================================================== */

// POST /api/cp/draft
// Body: { sessionId: "Office-v3", cuId: "C01" }


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

/**
 * GET /api/cpc/:sessionId
 * Hasilkan CPC (TERAS → CU → WA) daripada data session
 */
app.get("/api/cpc/:sessionId", (req, res) => {
  const sessionId = String(req.params.sessionId || "").trim();
  if (!sessionId) {
    return res.status(400).json({ error: "sessionId diperlukan" });
  }

  const s = ensureSession(sessionId);
  if (!s) {
    return res.status(404).json({ error: "Session tidak ditemui" });
  }

  const cards = getSessionCards(sessionId);

// bina CU → WA (ikut struktur card sebenar: cuTitle + activity/name)
const cuMap = {};
cards.forEach((c, idx) => {
  const cuTitle = String(c.cuTitle || "").trim();
  const waTitle = String(c.activity || c.name || c.title || "").trim();

  if (!cuTitle || !waTitle) return;

  if (!cuMap[cuTitle]) {
    cuMap[cuTitle] = {
      cuCode: "",     // akan diisi semula
      cuTitle,
      wa: [],
    };
  }

  // elak duplicate WA (berdasarkan tajuk)
  const exists = cuMap[cuTitle].wa.some(
    (w) => w.waTitle.toLowerCase() === waTitle.toLowerCase()
  );
  if (!exists) {
    cuMap[cuTitle].wa.push({
      waCode: "",
      waTitle,
    });
  }
});

// kemaskan kod CU & WA ikut format JPK (C01-W01)
const units = Object.values(cuMap).map((u, i) => ({
  ...u,
  cuCode: `C${String(i + 1).padStart(2, "0")}`,
  wa: u.wa.map((w, j) => ({
    ...w,
    waCode: `W${String(j + 1).padStart(2, "0")}`,
  })),
}));

  return res.json({
    sessionId,
    lang: String(s.lang || "MS").toUpperCase(),
    generatedAt: new Date().toISOString(),

    // struktur CPC
    teras: [
      {
        terasCode: "T01",
        terasTitle: s.terasTitle || "Pengurusan & Pengimarahan Masjid",
      },
    ],
    units,
  });
});

// REAL cluster RUN (OpenAI) — ikut bahasa session (MS/EN) + auto-lock
app.post("/api/cluster/run", async (req, res) => {
  try {
    const sid = String(req.body?.sessionId || "").trim();
    if (!sid) return res.status(400).json({ error: "sessionId diperlukan" });

    // Pastikan session wujud
    const s = ensureSession(sid);
    if (!s) return res.status(400).json({ error: "sessionId tidak sah" });

    const items = getSessionCards(sid);
    if (items.length < 5) {
      return res.status(400).json({ error: "Terlalu sedikit kad untuk clustering (min 5)" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY belum diset" });
    }

    const cards = items
      .map((c) => ({ id: c.id, activity: getCardText(c) }))
      .filter((c) => c.activity);

    if (cards.length < 5) {
      return res.status(400).json({ error: "Terlalu sedikit kad yang ada teks (min 5)" });
    }

    // =========================
    // Bahasa outcome ikut tetapan fasilitator
    // =========================
    const lang = String(s.lang || "MS").toUpperCase(); // "MS" | "EN"

    // Auto-lock bila run cluster (kalau belum lock)
    // (selari dgn rule: selepas outcome, bahasa mesti konsisten)
    if (!s.langLocked) {
      s.langLocked = true;
      s.lockedAt = new Date().toISOString();
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

    // Result simpan
    const result = {
      ok: true,
      sessionId: sid,
      lang,
      langLocked: !!s.langLocked,
      lockedAt: s.lockedAt || null,
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
