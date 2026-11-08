#!/usr/bin/env node
// Smoke tests: start each MCP server over stdio, assert the JSON-RPC handshake
// and tools/list, and round-trip a note through the memory server against a
// throwaway database. No network, no real agent CLIs are invoked.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 15_000;

const init = (id) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  },
});
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const listTools = (id) => ({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
const callTool = (id, name, args) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

// Write every frame, then resolve once all expected reply ids have arrived.
function talk(script, messages, expectedIds, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, script)], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses = new Map();
    let buf = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // skip anything that is not a protocol frame
        }
        if (msg.id != null) responses.set(msg.id, msg);
        if (expectedIds.every((id) => responses.has(id))) {
          clearTimeout(timer);
          child.kill();
          resolve(responses);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      if (expectedIds.every((id) => responses.has(id))) return;
      clearTimeout(timer);
      reject(
        new Error(
          `exited ${code} before all replies; stderr: ${stderr.trim().slice(0, 300) || "(empty)"}`
        )
      );
    });

    for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function toolNames(response) {
  return (response.result?.tools ?? []).map((t) => t.name).sort().join(",");
}

function textOf(response) {
  return response.result?.content?.[0]?.text ?? "";
}

let failed = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`PASS ${label}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${label}: ${e?.message ?? e}`);
  }
}

await check("consult-server: handshake + tools/list", async () => {
  const r = await talk("consult-server.mjs", [init(1), initialized, listTools(2)], [1, 2]);
  assert(r.get(1).result?.serverInfo?.name === "agent-bridge", "server name is not agent-bridge");
  assert(
    toolNames(r.get(2)) === "consult,harnesses,quota",
    `unexpected tools: ${toolNames(r.get(2))}`
  );
});

await check("agy-bridge: legacy tool names", async () => {
  const r = await talk("agy-bridge.mjs", [init(1), initialized, listTools(2)], [1, 2]);
  assert(
    toolNames(r.get(2)) === "antigravity_consult,antigravity_quota",
    `unexpected tools: ${toolNames(r.get(2))}`
  );
});

await check("memory-server: handshake + tools/list", async () => {
  const r = await talk("memory-server.mjs", [init(1), initialized, listTools(2)], [1, 2]);
  assert(
    toolNames(r.get(2)) === "forget,recall,remember",
    `unexpected tools: ${toolNames(r.get(2))}`
  );
});

await check("memory-server: remember then recall", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-smoke-"));
  try {
    const r = await talk(
      "memory-server.mjs",
      [
        init(1),
        initialized,
        callTool(2, "remember", { text: "smoke test note about zanzibar" }),
        callTool(3, "recall", { query: "zanzibar" }),
      ],
      [1, 2, 3],
      { MEMORY_DB_PATH: path.join(dir, "memory.db") }
    );
    const saved = textOf(r.get(2));
    assert(/^saved memory #\d+/.test(saved), `remember reply: ${saved}`);
    const found = textOf(r.get(3));
    assert(found.includes("zanzibar"), `recall did not return the note: ${found}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
