"use strict";
const path = require("path");
const fs = require("fs");
const { createLogger, format, transports } = require("winston");
require("winston-daily-rotate-file");

const LOGS_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

const logFormat = format.printf(({ timestamp, level, message }) => {
  return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
});

function makeTransport(name) {
  return new transports.DailyRotateFile({
    filename: path.join(LOGS_DIR, `${name}-%DATE%.log`),
    datePattern: "YYYY-MM-DD",
    maxSize: "10m",
    maxFiles: "14d",
    zippedArchive: true,
  });
}

const logger = createLogger({
  level: "info",
  format: format.combine(format.timestamp(), logFormat),
  transports: [
    makeTransport("app"),
    makeTransport("ffmpeg"),
    makeTransport("viewer"),
    makeTransport("network"),
    new transports.Console({
      format: format.combine(format.colorize(), format.timestamp(), logFormat),
    }),
  ],
});

module.exports = logger;
