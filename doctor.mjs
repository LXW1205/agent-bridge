#!/usr/bin/env node
// Environment report: which agent CLIs are installed, the exact MCP
// registration command for each, and where the memory store lives.
// Read-only by design: it never writes config, never runs the printed
// commands, and never prints environment variable values.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { MEMORY_DB } from "./lib/config.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVERS = {
  memory: path.join(ROOT, "memory-server.mjs"),
  bridge: path.join(ROOT, "consult-server.mjs"),
};
const HARNESS_BINS = ["opencode", "agy", "claude", "codex"];

// PATH lookup without executing anything.
function which(bin) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const full = path.join(dir, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function version(bin) {
  try {
    const out = execFileSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = out.trim().split("\n")[0];
    return line ? `(${line})` : "(version unknown)";
  } catch {
    return "(no --version flag)";
  }
}

// Each harness has its own `mcp add` syntax; the node binary is always this one.
function registration(harness, name, script) {
  const cmd = `${process.execPath} ${script}`;
  switch (harness) {
    case "opencode":
      return `opencode mcp add ${name} -- ${cmd}`;
    case "agy":
      return `agy mcp add ${name} --type stdio -- ${cmd}`;
    case "claude":
      return `claude mcp add ${name} -- ${cmd}`;
    case "codex":
      return `codex mcp add ${name} -- ${cmd}`;
    default:
      return "";
  }
}

function memorySummary() {
  if (!fs.existsSync(MEMORY_DB)) return `${MEMORY_DB} (not created yet)`;
  let count = "unreadable";
  // Count against a copy: opening the live WAL database, even read-only,
  // rewrites its -shm index, and this report must leave data/ untouched.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-doctor-"));
  try {
    for (const suffix of ["", "-wal"]) {
      const src = MEMORY_DB + suffix;
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, "memory.db" + suffix));
    }
    const db = new DatabaseSync(path.join(tmp, "memory.db"), { readOnly: true });
    try {
      count = db.prepare("SELECT COUNT(*) c FROM memories").get().c;
    } finally {
      db.close();
    }
  } catch {
    /* a fresh or locked file is reported as unreadable, never fatal */
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return `${MEMORY_DB} (${count} entries)`;
}

console.log("agent-bridge doctor\n");

const installed = [];
for (const bin of HARNESS_BINS) {
  const full = which(bin);
  if (!full) {
    console.log(`${bin.padEnd(9)} not installed`);
    continue;
  }
  installed.push(bin);
  console.log(`${bin.padEnd(9)} ${full}  ${version(full)}`);
}

console.log("\nregistration commands (copy-paste; paths are absolute):");
if (!installed.length) {
  console.log("  no agent CLIs found on PATH");
}
for (const bin of installed) {
  console.log(`\n# ${bin}`);
  for (const [name, script] of Object.entries(SERVERS)) {
    console.log(`  ${registration(bin, name, script)}`);
  }
}

console.log(`\nmemory store: ${memorySummary()}`);
console.log("\nThis report is read-only: no config was written and no command was run.");
