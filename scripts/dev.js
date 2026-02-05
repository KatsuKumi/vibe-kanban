#!/usr/bin/env node

const concurrently = require("concurrently");
const { getPorts } = require("./setup-dev-environment");

async function main() {
  const ports = await getPorts();

  process.env.FRONTEND_PORT = String(ports.frontend);
  process.env.BACKEND_PORT = String(ports.backend);
  process.env.VK_ALLOWED_ORIGINS = `http://localhost:${ports.frontend}`;
  process.env.VITE_VK_SHARED_API_BASE = process.env.VK_SHARED_API_BASE || "";

  const isQa = process.argv.includes("--qa");
  const backendCommand = isQa
    ? "pnpm run backend:dev:watch -- --qa"
    : "pnpm run backend:dev:watch";

  const { result } = concurrently([
    { command: backendCommand, name: "backend" },
    { command: "pnpm run frontend:dev", name: "frontend" },
  ]);

  await result;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
