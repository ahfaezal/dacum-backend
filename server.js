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
 * LALUAN B: MySPIKE Comparator (CP -> JD -> WA)
 * WA di MySPIKE: "Objektif Pembelajaran" (senarai 1..n)
 * WS/PC tidak dipaparkan dalam MySPIKE untuk kes ini.
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

// Extract "id" param dari URL (untuk JD pun sama)
function extractAnyId(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get("id");
  } catch {
    const m = String(url).match(/id=(\d+)/);
    return m ? m[1] : null;
  }
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

    // Kekalkan juga kalau href relative tanpa domain tapi ada "r=umum-noss%2Fview"
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
 * Return: items[] setiap CP ada wa gabungan + pecahan ikut JD
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
 *   dacumWA: ["...", "..."],   // WA dari DACUM (sementara: hantar dari frontend)
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

    const dacumWA = Array.isArray(req.body?.dacumWA) ? req.body.dacumWA : [];
    const threshold =
      typeof req.body?.threshold === "number" ? req.body.threshold : 0.45;

    if (!dacumWA.length) {
      return res.status(400).json({
        error:
          "dacumWA is required (array). Buat sementara, hantar dari frontend dahulu.",
      });
    }

    // Build parsed MySPIKE from CP->JD->WA (guna cache parse-wa cacheKey)
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

/**
 * =========================
 * Socket.IO basic events
 * =========================
 */
io.on("connection", (socket) => {
  socket.on("disconnect", () => {});
});

// Port
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("DACUM Backend running on port", PORT);
});
