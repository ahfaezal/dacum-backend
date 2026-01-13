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
 * =========================
 * Socket.IO basic events
 * =========================
 */
io.on("connection", (socket) => {
  // Optional: boleh log untuk debug
  // console.log("Socket connected:", socket.id);

  socket.on("disconnect", () => {
    // console.log("Socket disconnected:", socket.id);
  });
});

// Port
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("DACUM Backend running on port", PORT);
});
