const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const sessions = {};

app.post("/submit", (req, res) => {
  const { session, name, activity } = req.body;
  if (!sessions[session]) sessions[session] = [];

  const card = {
    id: Date.now(),
    name,
    activity,
    time: new Date().toISOString()
  };

  sessions[session].push(card);
  io.to(session).emit("new-card", card);

  res.json({ success: true });
});

app.get("/cards/:session", (req, res) => {
  res.json(sessions[req.params.session] || []);
});

io.on("connection", (socket) => {
  socket.on("join", (session) => {
    socket.join(session);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("DACUM Backend running on port", PORT);
});
