#!/usr/bin/env node

const { spawn } = require("child_process");
const path = require("path");

const FAST_REFRESH_PATTERN = /Could not Fast Refresh/;
const ERROR_THRESHOLD = 2;
const ERROR_WINDOW_MS = 5000;
const RESTART_DEBOUNCE_MS = 3000;
const MAX_RAPID_RESTARTS = 5;
const RAPID_RESTART_WINDOW_MS = 60000;

const port = process.env.FRONTEND_PORT || "3000";
const frontendDir = path.join(__dirname, "..", "frontend");
const env = {
  ...process.env,
  VITE_OPEN: process.env.VITE_OPEN || "false",
};

let currentChild = null;
let isRestarting = false;
let restartTimer = null;
let errorTimestamps = [];
let restartHistory = [];

function checkForHmrFailure(output) {
  if (!FAST_REFRESH_PATTERN.test(output)) return;

  const now = Date.now();
  errorTimestamps.push(now);
  errorTimestamps = errorTimestamps.filter((ts) => now - ts < ERROR_WINDOW_MS);

  if (errorTimestamps.length >= ERROR_THRESHOLD && !isRestarting) {
    scheduleRestart();
  }
}

function scheduleRestart() {
  if (restartTimer) return;

  const now = Date.now();
  restartHistory.push(now);
  restartHistory = restartHistory.filter(
    (ts) => now - ts < RAPID_RESTART_WINDOW_MS
  );

  if (restartHistory.length > MAX_RAPID_RESTARTS) {
    console.error(
      "\x1b[33m[vite-auto-restart]\x1b[0m Too many restarts in a short period. " +
        "Auto-restart disabled. Please restart manually."
    );
    return;
  }

  console.log(
    `\x1b[33m[vite-auto-restart]\x1b[0m HMR failure detected, restarting Vite in ${RESTART_DEBOUNCE_MS / 1000}s...`
  );

  restartTimer = setTimeout(() => {
    restartTimer = null;
    performRestart();
  }, RESTART_DEBOUNCE_MS);
}

function performRestart() {
  isRestarting = true;
  errorTimestamps = [];

  const killTarget = currentChild;
  if (!killTarget) {
    finishRestart();
    return;
  }

  const onExit = () => finishRestart();

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(killTarget.pid), "/T", "/F"], {
      stdio: "ignore",
    }).on("exit", onExit);
  } else {
    killTarget.on("exit", onExit);
    killTarget.kill("SIGTERM");
    setTimeout(() => {
      try {
        killTarget.kill("SIGKILL");
      } catch {}
    }, 2000);
  }
}

function finishRestart() {
  console.log(
    "\x1b[33m[vite-auto-restart]\x1b[0m Restarting Vite dev server..."
  );
  isRestarting = false;
  startVite();
}

function startVite() {
  const child = spawn("pnpm", ["run", "dev", "--", "--port", port, "--host"], {
    cwd: frontendDir,
    env,
    stdio: ["inherit", "pipe", "pipe"],
    shell: true,
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    checkForHmrFailure(chunk.toString());
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    checkForHmrFailure(chunk.toString());
  });

  child.on("exit", (code) => {
    if (!isRestarting) {
      process.exit(code ?? 0);
    }
  });

  currentChild = child;
}

startVite();

process.on("SIGINT", () => {
  if (restartTimer) clearTimeout(restartTimer);
  if (currentChild) currentChild.kill("SIGINT");
});

process.on("SIGTERM", () => {
  if (restartTimer) clearTimeout(restartTimer);
  if (currentChild) currentChild.kill("SIGTERM");
});
