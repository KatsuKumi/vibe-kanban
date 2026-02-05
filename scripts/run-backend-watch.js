#!/usr/bin/env node

const { spawn } = require("child_process");
const path = require("path");
const os = require("os");

const cargoDir = path.join(os.homedir(), ".cargo", "bin");
const cargoWatch = path.join(cargoDir, "cargo-watch");

const env = {
  ...process.env,
  PATH: `${cargoDir}${path.delimiter}${process.env.PATH}`,
  DISABLE_WORKTREE_CLEANUP: "1",
  RUST_LOG: process.env.RUST_LOG || "debug",
};

const isQa = process.argv.includes("--qa");
const runCommand = isQa ? "run --bin server --features qa-mode" : "run --bin server";

const child = spawn(
  cargoWatch,
  ["watch", "-w", "crates", "-x", runCommand],
  { env, stdio: "inherit" }
);

child.on("exit", (code) => process.exit(code ?? 0));
