import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:3000";

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
app.get("/health", (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ["GET", "POST"],
    credentials: true
  }
});

const rooms = new Map();

const getRoom = (roomId) => rooms.get(roomId);

const ensureRoom = (roomId, hostId) => {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      hostId,
      participants: new Map(),
      pending: new Map()
    });
  }
  return rooms.get(roomId);
};

const listPending = (room) =>
  Array.from(room.pending.entries()).map(([peerId, data]) => ({
    peerId,
    name: data.name
  }));

const listParticipants = (room) =>
  Array.from(room.participants.entries()).map(([peerId, data]) => ({
    peerId,
    name: data.name
  }));

const removeFromRoom = (roomId, socketId) => {
  const room = rooms.get(roomId);
  if (!room) return;
  room.pending.delete(socketId);
  room.participants.delete(socketId);
  if (room.participants.size === 0 && room.pending.size === 0) {
    rooms.delete(roomId);
  }
};

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, name }) => {
    if (!roomId) return;
    const room = ensureRoom(roomId, socket.id);

    if (room.participants.size === 0 && room.hostId === socket.id) {
      room.participants.set(socket.id, { name });
      socket.join(roomId);
      socket.emit("room-joined", { roomId, hostId: room.hostId });
      io.to(roomId).emit("participants", { participants: listParticipants(room) });
      return;
    }

    room.pending.set(socket.id, { name });
    socket.emit("waiting");
    io.to(room.hostId).emit("pending-list", { pending: listPending(room) });
  });

  socket.on("host-approve", ({ roomId, peerId }) => {
    const room = getRoom(roomId);
    if (!room || room.hostId !== socket.id) return;
    const pendingUser = room.pending.get(peerId);
    if (!pendingUser) return;

    room.pending.delete(peerId);
    room.participants.set(peerId, { name: pendingUser.name });
    const peerSocket = io.sockets.sockets.get(peerId);
    if (peerSocket) {
      peerSocket.join(roomId);
      peerSocket.emit("approved", { roomId, hostId: room.hostId });
      peerSocket.emit("existing-peers", {
        peers: listParticipants(room).filter((p) => p.peerId !== peerId)
      });
    }
    socket.emit("pending-list", { pending: listPending(room) });
    io.to(roomId)
      .except(peerId)
      .emit("peer-joined", { peerId, name: pendingUser.name });
    io.to(roomId).emit("participants", { participants: listParticipants(room) });
  });

  socket.on("signal", ({ to, type, data }) => {
    io.to(to).emit("signal", { from: socket.id, type, data });
  });

  socket.on("chat", ({ roomId, name, message }) => {
    if (!roomId || !message) return;
    const at = Date.now();
    io.to(roomId).emit("chat", { name, message, at });
  });

  socket.on("screen-share", ({ roomId, peerId, active }) => {
    if (!roomId || !peerId) return;
    io.to(roomId).emit("screen-share", { peerId, active: !!active });
  });

  socket.on("leave-room", ({ roomId }) => {
    const room = getRoom(roomId);
    if (!room) return;
    removeFromRoom(roomId, socket.id);
    socket.leave(roomId);
    socket.to(roomId).emit("peer-left", { peerId: socket.id });
    io.to(roomId).emit("participants", { participants: listParticipants(room) });
    if (room.hostId === socket.id) {
      const nextHost = Array.from(room.participants.keys())[0];
      if (nextHost) {
        room.hostId = nextHost;
        io.to(roomId).emit("host-changed", { hostId: nextHost });
      }
    }
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.participants.has(socket.id) || room.pending.has(socket.id)) {
        removeFromRoom(roomId, socket.id);
        socket.to(roomId).emit("peer-left", { peerId: socket.id });
        io.to(roomId).emit("participants", { participants: listParticipants(room) });
        if (room.hostId === socket.id) {
          const nextHost = Array.from(room.participants.keys())[0];
          if (nextHost) {
            room.hostId = nextHost;
            io.to(roomId).emit("host-changed", { hostId: nextHost });
          }
        } else {
          io.to(room.hostId).emit("pending-list", { pending: listPending(room) });
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Meet Datasiber signaling server running on :${PORT}`);
});
