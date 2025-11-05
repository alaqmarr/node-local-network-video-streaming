"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const http = require("http");
const NodeMediaServer = require("node-media-server");
const { Server: SocketIOServer } = require("socket.io");
const winston = require("winston");

// ---------- LOGGING SETUP ----------
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Winston logger configuration
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, "error.log"),
      level: "error",
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, "stream.log"),
      level: "info",
      maxsize: 5242880,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, "combined.log"),
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    }),
  ],
});

// Custom console logger with colors
const log = {
  info: (msg) => {
    console.log(`${colors.cyan}[INFO]${colors.reset} ${msg}`);
    logger.info(msg);
  },
  success: (msg) => {
    console.log(`${colors.green}✓ [SUCCESS]${colors.reset} ${msg}`);
    logger.info(`SUCCESS: ${msg}`);
  },
  warn: (msg) => {
    console.log(`${colors.yellow}⚠ [WARN]${colors.reset} ${msg}`);
    logger.warn(msg);
  },
  error: (msg, error = null) => {
    console.log(`${colors.red}✗ [ERROR]${colors.reset} ${msg}`);
    if (error) console.error(error);
    logger.error(msg, error ? { error: error.stack } : {});
  },
  stream: (msg) => {
    console.log(`${colors.magenta}📡 [STREAM]${colors.reset} ${msg}`);
    logger.info(`STREAM: ${msg}`);
  },
  client: (msg) => {
    console.log(`${colors.blue}👤 [CLIENT]${colors.reset} ${msg}`);
    logger.info(`CLIENT: ${msg}`);
  },
  server: (msg) => {
    console.log(`${colors.green}🚀 [SERVER]${colors.reset} ${msg}`);
    logger.info(`SERVER: ${msg}`);
  },
};

// ---------- CONFIG ----------
const HTTP_PORT = process.env.WEB_PORT || 3000;
const RTMP_PORT = process.env.RTMP_PORT || 1935;
const NMS_HTTP_PORT = process.env.NMS_HTTP_PORT || 8000;
const APP_NAME = "live";
const STREAM_KEY = "stream";

// ---------- UTILITY FUNCTIONS ----------
function getLocalIP() {
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const ni of nets[name]) {
        if (ni.family === "IPv4" && !ni.internal) {
          log.info(`Detected local IP: ${ni.address}`);
          return ni.address;
        }
      }
    }
    log.warn("Could not detect local IP, using localhost");
    return "127.0.0.1";
  } catch (error) {
    log.error("Error detecting IP address", error);
    return "127.0.0.1";
  }
}

const SERVER_IP = getLocalIP();

// ---------- NODE MEDIA SERVER (EXTREME LOW LATENCY) ----------
const nmsConfig = {
  rtmp: {
    port: RTMP_PORT,
    chunk_size: 4096, // Reduced from 60000 for lower latency
    gop_cache: false, // Disable GOP cache for immediate frames
    ping: 10, // More frequent pings
    ping_timeout: 20,
  },
  http: {
    port: NMS_HTTP_PORT,
    allow_origin: "*",
    mediaroot: "./media",
  },
  trans: {
    ffmpeg: "/usr/bin/ffmpeg",
    tasks: [
      {
        app: APP_NAME,
        hls: false,
        hlsFlags: "",
        dash: false,
        flv: true,
      },
    ],
  },
  logType: 3,
};

const nms = new NodeMediaServer(nmsConfig);

// Track active streams
const activeStreams = new Set();

// Enhanced NMS event logging
nms.on("preConnect", (id, args) => {
  log.stream(`Client connecting: ${id}`);
});

nms.on("postConnect", (id, args) => {
  log.stream(`Client connected: ${id}`);
});

nms.on("doneConnect", (id, args) => {
  log.stream(`Client disconnected: ${id}`);
});

nms.on("prePublish", (id, StreamPath, args) => {
  log.stream(`Stream publishing started: ${StreamPath}`);
  activeStreams.add(StreamPath);
  
  // Broadcast to all web viewers that stream is live
  io.emit("streamStatus", { live: true, path: StreamPath });
});

nms.on("postPublish", (id, StreamPath, args) => {
  log.success(`Stream is now live: ${StreamPath}`);
});

nms.on("donePublish", (id, StreamPath, args) => {
  log.stream(`Stream ended: ${StreamPath}`);
  activeStreams.delete(StreamPath);
  
  // Notify viewers that stream ended
  io.emit("streamStatus", { live: false, path: StreamPath });
});

nms.on("prePlay", (id, StreamPath, args) => {
  log.stream(`Viewer started watching: ${StreamPath}`);
});

nms.on("postPlay", (id, StreamPath, args) => {
  log.stream(`Viewer connected to: ${StreamPath}`);
});

nms.on("donePlay", (id, StreamPath, args) => {
  log.stream(`Viewer stopped watching: ${StreamPath}`);
});

// ---------- EXPRESS + SOCKET.IO ----------
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
});

// Middleware for request logging
app.use((req, res, next) => {
  log.info(`${req.method} ${req.url} from ${req.ip}`);
  next();
});

// Error handling middleware
app.use((err, req, res, next) => {
  log.error(`Express error: ${err.message}`, err);
  res.status(500).json({ error: "Internal server error" });
});

// Serve flv.js
app.get("/flv.min.js", (req, res) => {
  try {
    res.sendFile(path.join(__dirname, "node_modules/flv.js/dist/flv.min.js"));
  } catch (error) {
    log.error("Error serving flv.js", error);
    res.status(500).send("Error loading player library");
  }
});

// Main viewer page
app.get("/", (req, res) => {
  try {
    res.sendFile(path.join(__dirname, "public", "viewer2.html"));
  } catch (error) {
    log.error("Error serving viewer page", error);
    res.status(500).send("Error loading viewer");
  }
});

// API endpoint for stream info
app.get("/api/info", (req, res) => {
  try {
    const info = {
      ip: SERVER_IP,
      flv: `http://${SERVER_IP}:${NMS_HTTP_PORT}/${APP_NAME}/${STREAM_KEY}.flv`,
      rtmpIngest: `rtmp://${SERVER_IP}:${RTMP_PORT}/${APP_NAME}/${STREAM_KEY}`,
      isLive: activeStreams.has(`/${APP_NAME}/${STREAM_KEY}`),
      viewers: clients.size,
    };
    res.json(info);
  } catch (error) {
    log.error("Error in /api/info", error);
    res.status(500).json({ error: "Failed to get stream info" });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    activeStreams: activeStreams.size,
    viewers: clients.size,
  });
});

// Socket.IO client management
const clients = new Set();

io.on("connection", (socket) => {
  clients.add(socket);
  const clientCount = clients.size;
  
  log.client(`New viewer connected (Total: ${clientCount})`);
  
  // Send current viewer count to all clients
  io.emit("viewerCount", clientCount);
  
  // Send stream status to new client
  socket.emit("streamStatus", {
    live: activeStreams.size > 0,
    path: `/${APP_NAME}/${STREAM_KEY}`,
  });

  socket.on("disconnect", () => {
    clients.delete(socket);
    const remainingClients = clients.size;
    log.client(`Viewer disconnected (Remaining: ${remainingClients})`);
    io.emit("viewerCount", remainingClients);
  });

  socket.on("error", (error) => {
    log.error(`Socket error for client ${socket.id}`, error);
  });
});

// ---------- GRACEFUL SHUTDOWN ----------
process.on("SIGTERM", () => {
  log.warn("SIGTERM received, shutting down gracefully...");
  server.close(() => {
    log.info("HTTP server closed");
    nms.stop();
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  log.warn("SIGINT received, shutting down gracefully...");
  server.close(() => {
    log.info("HTTP server closed");
    nms.stop();
    process.exit(0);
  });
});

process.on("uncaughtException", (error) => {
  log.error("Uncaught Exception", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  log.error("Unhandled Rejection at:", reason);
});

// ---------- START SERVERS ----------
(async () => {
  try {
    log.server("Starting streaming server...");
    
    // Start Node Media Server
    nms.run();
    log.success(`RTMP Server started on port ${RTMP_PORT}`);
    log.success(`HTTP-FLV Server started on port ${NMS_HTTP_PORT}`);
    
    // Start Express server
    server.listen(HTTP_PORT, "0.0.0.0", () => {
      console.log("\n" + "=".repeat(60));
      log.server(`Low-Latency Streaming Server Ready!`);
      console.log("=".repeat(60));
      log.success(`Viewer Interface: http://${SERVER_IP}:${HTTP_PORT}/`);
      log.success(`RTMP Ingest: rtmp://${SERVER_IP}:${RTMP_PORT}/${APP_NAME}/${STREAM_KEY}`);
      log.success(`FLV Stream: http://${SERVER_IP}:${NMS_HTTP_PORT}/${APP_NAME}/${STREAM_KEY}.flv`);
      console.log("=".repeat(60));
      log.info(`Logs directory: ${logsDir}`);
      log.info("Ready to accept streams and viewers");
      console.log("=".repeat(60) + "\n");
    });
  } catch (error) {
    log.error("Failed to start server", error);
    process.exit(1);
  }
})();