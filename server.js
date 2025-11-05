"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const http = require("http");
const NodeMediaServer = require("node-media-server");
const { Server: SocketIOServer } = require("socket.io");

// ---------- CONFIG ----------
const HTTP_PORT = process.env.WEB_PORT || 3000;
const RTMP_PORT = process.env.RTMP_PORT || 1935;
const INPUT_APP = "input";
const OUTPUT_APP = "live";
const STREAM_KEY = "stream";
const HLS_DIR = path.join(__dirname, "hls");

// ---------- PREP ----------
if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name]) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return "127.0.0.1";
}
const SERVER_IP = getLocalIP();

// ---------- NODE MEDIA SERVER ----------
const nmsConfig = {
  rtmp: {
    port: RTMP_PORT,
    chunk_size: 4096,
    gop_cache: false,
  },
  http: { port: 8000, allow_origin: "*" },
  logType: 3,
};
const nms = new NodeMediaServer(nmsConfig);

// ---------- EXPRESS + SOCKET.IO ----------
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: "*" } });

app.use(
  "/live",
  express.static(HLS_DIR, {
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    },
  })
);

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "viewer.html"));
});

app.get("/api/info", (req, res) => {
  res.json({
    ip: SERVER_IP,
    rtmpIngest: `rtmp://${SERVER_IP}:${RTMP_PORT}/${INPUT_APP}/${STREAM_KEY}`,
    hls: `http://${SERVER_IP}:${HTTP_PORT}/live/stream.m3u8`,
  });
});

const clients = new Set();
io.on("connection", (socket) => {
  clients.add(socket);
  io.emit("viewerCount", clients.size);
  socket.on("disconnect", () => {
    clients.delete(socket);
    io.emit("viewerCount", clients.size);
  });
});

// ---------- FFMPEG ----------
let ffmpegProc = null;

function startFFmpeg() {
  if (ffmpegProc) return;

  const input = `rtmp://127.0.0.1:${RTMP_PORT}/${INPUT_APP}/${STREAM_KEY}`;
  const output = path.join(HLS_DIR, "stream.m3u8");

  const args = [
    "-fflags", "+genpts+discardcorrupt",
    "-flags", "low_delay",
    "-rtbufsize", "100M",
    "-i", input,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-x264-params", "keyint=30:min-keyint=30:scenecut=0",
    "-g", "30",
    "-c:a", "aac",
    "-ar", "44100",
    "-b:a", "128k",
    "-f", "hls",
    "-hls_time", "1",
    "-hls_list_size", "5",
    "-hls_flags", "delete_segments+append_list+omit_endlist+program_date_time",
    "-hls_segment_type", "mpegts",
    "-hls_delete_threshold", "1",
    "-hls_allow_cache", "0",
    "-hls_segment_filename", path.join(HLS_DIR, "seg_%03d.ts"),
    output,
  ];

  ffmpegProc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  console.log(`[FFmpeg] Started (PID: ${ffmpegProc.pid})`);

  ffmpegProc.stderr.on("data", (data) => {
    const s = data.toString();
    if (s.includes("frame=")) process.stdout.write(".");
  });

  ffmpegProc.on("exit", (code, signal) => {
    console.log(`\n[FFmpeg] Exited (${code || signal})`);
    ffmpegProc = null;
  });
}

// ---------- STREAM EVENTS ----------
nms.on("prePublish", (id, streamPath) => {
  console.log(`[NMS prePublish] ${streamPath}`);
  if (streamPath === `/${INPUT_APP}/${STREAM_KEY}`) startFFmpeg();
});

nms.on("donePublish", (id, streamPath) => {
  console.log(`[NMS donePublish] ${streamPath}`);
});

// ---------- START ----------
(async () => {
  nms.run();
  server.listen(HTTP_PORT, "0.0.0.0", () => {
    console.log(`✅ Viewer:      http://${SERVER_IP}:${HTTP_PORT}/`);
    console.log(`✅ RTMP Ingest: rtmp://${SERVER_IP}:${RTMP_PORT}/${INPUT_APP}/${STREAM_KEY}`);
    console.log(`✅ HLS Stream:  http://${SERVER_IP}:${HTTP_PORT}/live/stream.m3u8`);
  });
})();
