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
    name,
    activity,
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
    name,
    activity,
    time: new Date().toISOString()
  };

  sessions[session].push(card);
  io.to(session).emit("new-card", card);

  res.json({ success: true, card });
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
