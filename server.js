const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();

// CORS + JSON body
app.use(cors({ origin: "*" }));
app.use(express.json());

// Create HTTP server + Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// In-memory storage (MVP)
// sessions = { [sessionId]: [ { id, name, activity, time } ] }
const sessions = {};

// Simple root route for quick test
app.get("/", (req, res) => {
  res.send("DACUM Backend OK");
});

/**
 * GET cards for a session
 * Frontend calls: GET `${API_BASE}/cards/${session}`
 */
app.get("/cards/:session", (req, res) => {
  const session = req.params.session;
  res.json(sessions[session] || []);
});

/**
 * POST a new card to a session (MATCH FRONTEND)
 * Frontend calls: POST `${API_BASE}/cards/${session}`
 * Body: { name, activity }
 */
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
    time: new Date().toISOString()
  };

  sessions[session].push(card);

  // Notify all clients in the same session room
  io.to(session).emit("new-card", card);

  return res.json({ success: true, card });
});

/**
 * OPTIONAL: Keep /submit endpoint for compatibility (if you ever use it)
 * POST /submit
 * Body: { session, name, activity }
 */
app.post("/submit", (req, res) => {
  const { session, name, activity } = req.body || {};

  if (!session || !name || !activity) {
    return res.status(400).json({
      success: false,
      error: "session, name & activity required"
    });
  }

  if (!sessions[session]) sessions[session] = [];

  const card = {
    id: Date.now(),
    name: String(name).trim(),
    activity: String(activity).trim(),
    time: new Date().toISOString()
  };

  sessions[session].push(card);
  io.to(session).emit("new-card", card);

  res.json({ success: true, card });
});

/**
 * ====== FASA 2: CLUSTER DACUM TASKS (MVP v1) ======
 * Endpoint:
 *   POST /cluster/:session
 *
 * Output:
 *   {
 *     session: "dacum-demo",
 *     clusters: [
 *       { title: "...", tasks: ["...", "..."] }
 *     ]
 *   }
 *
 * Nota:
 * - Ini clustering ringkas (rule-based) untuk mula susun aktiviti.
 * - Lepas ini kita boleh upgrade kepada AI clustering.
 */
app.post("/cluster/:session", (req, res) => {
  const session = req.params.session;
  const cards = sessions[session] || [];

  if (!cards.length) {
    return res.status(400).json({ success: false, error: "No cards to cluster" });
  }

  // Grouping rule-based (boleh tambah rules ikut bidang)
  const groups = {};

  for (const c of cards) {
    const text = (c.activity || "").toLowerCase();

    let key = "Lain-lain";

    // Rules contoh (boleh ubah ikut NOSS Pengurusan Masjid)
    if (text.includes("jadual") || text.includes("schedule")) key = "Pengurusan Jadual";
    else if (text.includes("imam")) key = "Pengurusan Imam";
    else if (text.includes("bilal")) key = "Pengurusan Bilal";
    else if (text.includes("kariah") || text.includes("jemaah")) key = "Pengurusan Kariah/Jemaah";
    else if (text.includes("kewangan") || text.includes("akaun") || text.includes("bayaran")) key = "Pengurusan Kewangan";
    else if (text.includes("program") || text.includes("aktiviti") || text.includes("majlis")) key = "Pengurusan Program";
    else if (text.includes("aset") || text.includes("inventori") || text.includes("peralatan")) key = "Pengurusan Aset/Inventori";
    else if (text.includes("penyelenggaraan") || text.includes("maintenance")) key = "Penyelenggaraan";

    if (!groups[key]) groups[key] = [];
    groups[key].push(c.activity);
  }

  const clusters = Object.keys(groups).map((title) => ({
    title,
    tasks: groups[title]
  }));

  return res.json({ success: true, session, totalCards: cards.length, clusters });
});

// Socket events
io.on("connection", (socket) => {
  socket.on("join", (session) => {
    if (session) socket.join(session);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("DACUM Backend running on port", PORT);
});
