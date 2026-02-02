"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const resolveSignalingUrl = () => {
  const envUrl = process.env.NEXT_PUBLIC_SIGNALING_URL;
  if (envUrl) return envUrl;
  if (typeof window === "undefined") return "";
  const origin = window.location.origin;
  if (origin.includes("localhost:3000")) return "http://localhost:3001";
  return origin;
};

const SIGNALING_URL = resolveSignalingUrl();
const buildIceServers = () => {
  const servers = [];
  const stunUrl = process.env.NEXT_PUBLIC_STUN_URL || "";
  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL || "";
  const turnUser = process.env.NEXT_PUBLIC_TURN_USERNAME || "";
  const turnPass = process.env.NEXT_PUBLIC_TURN_PASSWORD || "";

  if (stunUrl) {
    servers.push({ urls: stunUrl });
  }

  if (turnUrl && turnUser && turnPass) {
    servers.push({ urls: turnUrl, username: turnUser, credential: turnPass });
  }

  return servers;
};

const ICE_CONFIG = {
  iceServers: buildIceServers()
};

function useStableRef(value) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

export default function HomePage() {
  const [socket, setSocket] = useState(null);
  const [roomId, setRoomId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [joined, setJoined] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [pendingUsers, setPendingUsers] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(true);
  const [screenSharing, setScreenSharing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [screenShareIds, setScreenShareIds] = useState([]);
  const [activeStagePeerId, setActiveStagePeerId] = useState(null);

  const localVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const lastVideoOffRef = useRef(true);
  const recorderRef = useRef(null);
  const recordedChunksRef = useRef([]);

  const peersRef = useRef(new Map());
  const peerMetaRef = useRef(new Map());
  const [remoteStreams, setRemoteStreams] = useState([]);

  const nameRef = useStableRef(displayName);

  useEffect(() => {
    const s = io(SIGNALING_URL, { transports: ["websocket"] });
    setSocket(s);

    return () => {
      s.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!socket) return;

    socket.on("room-joined", async ({ hostId }) => {
      setJoined(true);
      setWaiting(false);
      setIsHost(socket.id === hostId);
      await ensureLocalStream();
    });

    socket.on("waiting", () => {
      setWaiting(true);
    });

    socket.on("pending-list", ({ pending }) => {
      setPendingUsers(pending || []);
    });

    socket.on("participants", ({ participants }) => {
      setParticipants(participants || []);
    });

    socket.on("approved", async ({ hostId }) => {
      setJoined(true);
      setWaiting(false);
      setIsHost(socket.id === hostId);
      await ensureLocalStream();
    });

    socket.on("existing-peers", async ({ peers }) => {
      await ensureLocalStream();
      (peers || []).forEach(({ peerId }) => {
        if (peerId && peerId !== socket.id) {
          createOffer(peerId);
        }
      });
    });

    socket.on("host-changed", ({ hostId }) => {
      setIsHost(socket.id === hostId);
    });

    socket.on("peer-joined", ({ peerId }) => {
      if (!peerId || peerId === socket.id) return;
      if (!peersRef.current.get(peerId)) {
        createPeerConnection(peerId);
      }
    });

    socket.on("peer-left", ({ peerId }) => {
      removePeer(peerId);
    });

    socket.on("signal", async ({ from, type, data }) => {
      if (type === "offer") {
        await handleOffer(from, data);
      }
      if (type === "answer") {
        await handleAnswer(from, data);
      }
      if (type === "ice-candidate") {
        await handleCandidate(from, data);
      }
    });

    socket.on("chat", ({ name, message, at }) => {
      setChatMessages((prev) => [...prev, { name, message, at }]);
    });

    socket.on("screen-share", ({ peerId, active }) => {
      setScreenShareIds((prev) => {
        const set = new Set(prev);
        if (active) set.add(peerId);
        else set.delete(peerId);
        return Array.from(set);
      });
      setActiveStagePeerId((current) => {
        if (!active && current === peerId) return null;
        return current;
      });
    });

    return () => {
      socket.off("room-joined");
      socket.off("waiting");
      socket.off("pending-list");
      socket.off("existing-peers");
      socket.off("participants");
      socket.off("approved");
      socket.off("host-changed");
      socket.off("peer-joined");
      socket.off("peer-left");
      socket.off("signal");
      socket.off("chat");
      socket.off("screen-share");
    };
  }, [socket]);

  useEffect(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }, [muted]);

  useEffect(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    if (videoOff) {
      stream.getVideoTracks().forEach((track) => {
        track.stop();
        stream.removeTrack(track);
      });
      peersRef.current.forEach((pc) => {
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
        if (sender) sender.replaceTrack(null);
      });
      peersRef.current.forEach((_, peerId) => createOffer(peerId));
    } else {
      navigator.mediaDevices.getUserMedia({ video: true }).then((camStream) => {
        const camTrack = camStream.getVideoTracks()[0];
        stream.addTrack(camTrack);
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
        peersRef.current.forEach((pc, peerId) => {
          const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
          if (sender) {
            sender.replaceTrack(camTrack);
          } else {
            pc.addTrack(camTrack, stream);
            createOffer(peerId);
          }
        });
        peersRef.current.forEach((_, peerId) => createOffer(peerId));
      });
    }
  }, [videoOff]);

  useEffect(() => {
    if (!socket || !joined) return;
    if (screenSharing) return;
    socket.emit("screen-share", { roomId, peerId: socket.id, active: false });
  }, [screenSharing, socket, joined, roomId]);

  const ensureLocalStream = async () => {
    if (localStreamRef.current) return localStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: !videoOff
    });
    localStreamRef.current = stream;
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }
    return stream;
  };

  const createPeerConnection = (peerId) => {
    const pc = new RTCPeerConnection(ICE_CONFIG);
    const stream = localStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("signal", {
          to: peerId,
          type: "ice-candidate",
          data: event.candidate
        });
      }
    };

    pc.ontrack = (event) => {
      setRemoteStreams((prev) => {
        const exists = prev.find((item) => item.peerId === peerId);
        if (exists) return prev;
        return [...prev, { peerId, stream: event.streams[0] }];
      });
    };

    pc.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        removePeer(peerId);
      }
    };

    peersRef.current.set(peerId, pc);
    peerMetaRef.current.set(peerId, {
      makingOffer: false,
      ignoreOffer: false,
      polite: socket?.id > peerId
    });
    return pc;
  };

  const createOffer = async (peerId) => {
    const pc = peersRef.current.get(peerId) || createPeerConnection(peerId);
    const meta = peerMetaRef.current.get(peerId);
    try {
      meta.makingOffer = true;
      const offer = await pc.createOffer();
      if (pc.signalingState !== "stable") return;
      await pc.setLocalDescription(offer);
      socket.emit("signal", { to: peerId, type: "offer", data: offer });
    } finally {
      meta.makingOffer = false;
    }
  };

  const handleOffer = async (peerId, offer) => {
    const pc = peersRef.current.get(peerId) || createPeerConnection(peerId);
    const meta = peerMetaRef.current.get(peerId);
    const offerCollision =
      pc.signalingState !== "stable" || meta.makingOffer;
    meta.ignoreOffer = !meta.polite && offerCollision;
    if (meta.ignoreOffer) return;
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("signal", { to: peerId, type: "answer", data: answer });
  };

  const handleAnswer = async (peerId, answer) => {
    const pc = peersRef.current.get(peerId);
    if (!pc) return;
    if (pc.signalingState === "stable") return;
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  };

  const handleCandidate = async (peerId, candidate) => {
    const pc = peersRef.current.get(peerId);
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error("Failed to add ICE candidate", err);
    }
  };

  const removePeer = (peerId) => {
    const pc = peersRef.current.get(peerId);
    if (pc) pc.close();
    peersRef.current.delete(peerId);
    peerMetaRef.current.delete(peerId);
    setRemoteStreams((prev) => prev.filter((item) => item.peerId !== peerId));
  };

  const joinRoom = () => {
    if (!socket || !roomId || !displayName) return;
    socket.emit("join-room", { roomId, name: displayName });
  };

  const approveUser = (peerId) => {
    socket.emit("host-approve", { roomId, peerId });
  };

  const leaveRoom = () => {
    socket.emit("leave-room", { roomId });
    peersRef.current.forEach((pc) => pc.close());
    peersRef.current.clear();
    setRemoteStreams([]);
    setJoined(false);
    setWaiting(false);
    setIsHost(false);
    setParticipants([]);
    setScreenShareIds([]);
    setActiveStagePeerId(null);
  };

  const sendChat = (e) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    socket.emit("chat", { roomId, name: nameRef.current, message: chatInput });
    setChatInput("");
  };

  const toggleScreenShare = async () => {
    if (screenSharing) {
      await stopScreenShare();
      return;
    }
    lastVideoOffRef.current = videoOff;
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false
    });
    const screenTrack = screenStream.getVideoTracks()[0];
    screenTrack.onended = () => stopScreenShare();
    replaceVideoTrack(screenTrack);
    setScreenSharing(true);
    socket.emit("screen-share", { roomId, peerId: socket.id, active: true });
  };

  const stopScreenShare = async () => {
    if (lastVideoOffRef.current) {
      setVideoOff(true);
      replaceVideoTrack(null);
    } else {
      const camStream = await navigator.mediaDevices.getUserMedia({
        video: true
      });
      const camTrack = camStream.getVideoTracks()[0];
      replaceVideoTrack(camTrack);
      setVideoOff(false);
    }
    setScreenSharing(false);
    socket.emit("screen-share", { roomId, peerId: socket.id, active: false });
    setActiveStagePeerId((current) => (current === socket.id ? null : current));
  };

  const replaceVideoTrack = (newTrack) => {
    const stream = localStreamRef.current;
    if (!stream) return;
    stream.getVideoTracks().forEach((track) => stream.removeTrack(track));
    if (newTrack) stream.addTrack(newTrack);
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }

    peersRef.current.forEach((pc, peerId) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) {
        sender.replaceTrack(newTrack);
      } else if (newTrack) {
        pc.addTrack(newTrack, stream);
        createOffer(peerId);
      }
    });
    peersRef.current.forEach((_, peerId) => createOffer(peerId));
  };

  const toggleRecording = () => {
    if (recording) {
      recorderRef.current.stop();
      setRecording(false);
      return;
    }
    const stream = localStreamRef.current;
    if (!stream) return;
    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;
    recordedChunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) recordedChunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `meet-datasiber-${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);
    };
    recorder.start();
    setRecording(true);
  };

  const roomStatus = useMemo(() => {
    if (waiting) return "Menunggu persetujuan host";
    if (joined) return isHost ? "Host" : "Bergabung";
    return "Belum bergabung";
  }, [waiting, joined, isHost]);

  const nameById = useMemo(() => {
    const map = new Map();
    participants.forEach((user) => {
      map.set(user.peerId, user.name);
    });
    return map;
  }, [participants]);

  const allTiles = useMemo(() => {
    const tiles = [
      {
        peerId: socket?.id || "local",
        label: `${displayName} (Kamu)`,
        stream: localStreamRef.current,
        isLocal: true,
        isScreenShare: screenSharing
      }
    ];
    remoteStreams.forEach(({ peerId, stream }) => {
      tiles.push({
        peerId,
        label: nameById.get(peerId) || "Peserta",
        stream,
        isLocal: false,
        isScreenShare: screenShareIds.includes(peerId)
      });
    });
    return tiles;
  }, [socket?.id, displayName, remoteStreams, nameById, screenSharing, screenShareIds]);

  const stageTile = useMemo(() => {
    if (!activeStagePeerId) return null;
    return allTiles.find((tile) => tile.peerId === activeStagePeerId) || null;
  }, [activeStagePeerId, allTiles]);

  const stripTiles = useMemo(() => {
    if (!stageTile) return allTiles;
    return allTiles.filter((tile) => tile.peerId !== stageTile.peerId);
  }, [allTiles, stageTile]);

  return (
    <main>
      <header className="fade-in">
        <div className="brand">
          <div className="logo" />
          <div>
            <h1>Meet Datasiber</h1>
            <p style={{ color: "var(--muted)", fontSize: 13 }}>
              Ruang rapat video aman untuk timmu
            </p>
          </div>
        </div>
        <span className="badge">{roomStatus}</span>
      </header>

      {!joined && !waiting ? (
        <section className="card fade-in" style={{ maxWidth: 520 }}>
          <h2>Masuk Ruang</h2>
          <p style={{ color: "var(--muted)", marginTop: 6 }}>
            Host akan menerima permintaan jika ruang sudah ada.
          </p>
          <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
            <input
              className="input"
              placeholder="Nama kamu"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <input
              className="input"
              placeholder="ID ruang (contoh: datasiber-team)"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
            />
            <button className="btn btn-accent" onClick={joinRoom}>
              Bergabung
            </button>
          </div>
        </section>
      ) : null}

      {waiting ? (
        <section className="card fade-in">
          <h2>Menunggu Host</h2>
          <p style={{ color: "var(--muted)", marginTop: 6 }}>
            Permintaan kamu sedang dicek oleh host.
          </p>
        </section>
      ) : null}

      {joined ? (
        <section className="room-grid fade-in">
          <div className="card video-card">
            <div className="video-body">
              {stageTile ? (
                <div className="stage-layout">
                  <div className="stage-main">
                    <div className={`video-tile stage ${stageTile.isScreenShare ? "screen-share" : ""}`}>
                      <video
                        autoPlay
                        playsInline
                        muted={stageTile.isLocal}
                        ref={(el) => {
                          if (!el) return;
                          if (stageTile.isLocal) {
                            el.srcObject = localStreamRef.current;
                          } else {
                            el.srcObject = stageTile.stream;
                          }
                        }}
                      />
                      <span className="video-label">{stageTile.label}</span>
                      <button
                        className="icon-btn"
                        onClick={() => setActiveStagePeerId(null)}
                        title="Keluar layar penuh"
                      >
                        ⤢
                      </button>
                    </div>
                  </div>
                  <div className="stage-strip">
                    {stripTiles.map((tile) => (
                      <div
                        className={`video-tile mini ${tile.isScreenShare ? "screen-share" : ""}`}
                        key={tile.peerId}
                      >
                        <video
                          autoPlay
                          playsInline
                          muted={tile.isLocal}
                          ref={(el) => {
                            if (!el) return;
                            if (tile.isLocal) {
                              el.srcObject = localStreamRef.current;
                            } else {
                              el.srcObject = tile.stream;
                            }
                          }}
                        />
                        <span className="video-label">{tile.label}</span>
                        <button
                          className="icon-btn"
                          onClick={() => setActiveStagePeerId(tile.peerId)}
                          title="Layar penuh"
                        >
                          ⤢
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="video-grid">
                  {allTiles.map((tile) => (
                    <div
                      className={`video-tile ${tile.isScreenShare ? "screen-share" : ""}`}
                      key={tile.peerId}
                    >
                      <video
                        autoPlay
                        playsInline
                        muted={tile.isLocal}
                        ref={(el) => {
                          if (!el) return;
                          if (tile.isLocal) {
                            el.srcObject = localStreamRef.current;
                          } else {
                            el.srcObject = tile.stream;
                          }
                        }}
                      />
                      <span className="video-label">{tile.label}</span>
                      <button
                        className="icon-btn"
                        onClick={() => setActiveStagePeerId(tile.peerId)}
                        title="Layar penuh"
                      >
                        ⤢
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <aside className="card sidebar">
            <div>
              <h3>Peserta</h3>
              <p style={{ color: "var(--muted)", fontSize: 13 }}>
                Ruang: {roomId}
              </p>
            </div>
            <div className="panel">
              <div className="participants-list">
                {participants.length === 0 ? (
                  <div className="notice">Belum ada peserta.</div>
                ) : (
                  participants.map((user) => (
                    <div className="participant-item" key={user.peerId}>
                      <span>
                        {user.name}
                        {user.peerId === socket?.id ? " (Kamu)" : ""}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="panel chat-panel">
              <div className="chat-list">
                {chatMessages.length === 0 ? (
                  <div className="notice">Belum ada pesan.</div>
                ) : (
                  chatMessages.map((item, idx) => (
                    <div className="chat-item" key={`${item.at}-${idx}`}>
                      <strong>{item.name}</strong>: {item.message}
                    </div>
                  ))
                )}
              </div>
              <form onSubmit={sendChat} style={{ display: "grid", gap: 8 }}>
                <input
                  className="input"
                  placeholder="Tulis pesan..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                />
                <button className="btn" type="submit">
                  Kirim
                </button>
              </form>
            </div>
            {isHost && pendingUsers.length > 0 ? (
              <div>
                <h4 style={{ marginBottom: 8 }}>Waiting Room</h4>
                <div style={{ display: "grid", gap: 8 }}>
                  {pendingUsers.map((user) => (
                    <div className="card" key={user.peerId}>
                      <div style={{ marginBottom: 6 }}>{user.name}</div>
                      <button className="btn btn-accent" onClick={() => approveUser(user.peerId)}>
                        Terima
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </aside>
        </section>
      ) : null}

      {joined ? (
        <footer className="controls fade-in">
          <button className="btn" onClick={() => setMuted((m) => !m)}>
            {muted ? "Unmute" : "Mute"}
          </button>
          <button className="btn" onClick={() => setVideoOff((v) => !v)}>
            {videoOff ? "Video On" : "Video Off"}
          </button>
          <button className="btn" onClick={toggleScreenShare}>
            {screenSharing ? "Stop Share" : "Share Screen"}
          </button>
          <button className="btn" onClick={toggleRecording}>
            {recording ? "Stop Rec" : "Record"}
          </button>
          <button className="btn btn-danger" onClick={leaveRoom}>
            Keluar
          </button>
        </footer>
      ) : null}
    </main>
  );
}
