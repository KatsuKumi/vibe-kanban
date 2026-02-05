#!/usr/bin/env node

const { spawn } = require("child_process");
const path = require("path");

const port = process.env.FRONTEND_PORT || "3000";
const frontendDir = path.join(__dirname, "..", "frontend");

const env = {
  ...process.env,
  VITE_OPEN: process.env.VITE_OPEN || "false",
};

const child = spawn("pnpm", ["run", "dev", "--", "--port", port, "--host"], {
  cwd: frontendDir,
  env,
  stdio: "inherit",
  shell: true,
});

child.on("exit", (code) => process.exit(code ?? 0));
