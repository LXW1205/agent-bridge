#!/usr/bin/env node
// agent-bridge MCP server: delegate a task to any installed agent CLI
// (agy, claude, codex) and report which harnesses are available.
//
// Tools: consult, harnesses, quota
//
// Legacy mode (buildServer({ legacy: true })) keeps the previous tool names
// pinned to agy so the existing OpenCode config and `agy mcp add` entry keep
// working unchanged; agy-bridge.mjs is such a shim.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createMcpServer } from "./lib/mcp.mjs";
import { fuelSummary, fuelSummaryText } from "./lib/dashboard.mjs";
import { AGY_CONV_DIR } from "./lib/config.mjs";
import { latestTurnText } from "./lib/agy-conversations.mjs";
import { HARNESSES } from "./lib/harness.mjs";

const MIN_REMAINING = Number(process.env.AGY_MIN_REMAINING ?? 20);
const MAX_OUTPUT_CHARS = 20_000;
const NEGATIVE_TTL = 30_000; // how long a "not installed" verdict is trusted
const resolved = new Map(); // harness name -> { path, at }: positives cached, negatives retried

const DEFAULT_HARNESS = HARNESSES[process.env.AGENT_BRIDGE_DEFAULT_HARNESS]
  ? process.env.AGENT_BRIDGE_DEFAULT_HARNESS
  : "agy";

/* ---------------- binary discovery ---------------- */

async function resolveBinary(adapter) {
  const now = Date.now();
  const hit = resolved.get(adapter.name);
  // A found binary stays cached; a missing one is re-probed, so installing
  // the CLI later is picked up without restarting this server process.
  if (hit && (typeof hit.path === "string" || now - hit.at < NEGATIVE_TTL)) {
    return hit.path;
  }
  const candidates = [
    ...new Set([process.env[adapter.binEnv], ...adapter.defaultBins].filter(Boolean)),
  ];
  for (const c of candidates) {
    if (await probe(c, adapter.probeArgs)) {
      resolved.set(adapter.name, { path: c, at: now });
      return c;
    }
  }
  resolved.set(adapter.name, { path: null, at: now });
  return null;
}

function probe(bin, args) {
  return new Promise((resolve) => {
    // --help is always valid and cheap; no reliable version flag exists on all
    // three CLIs, and a missing binary is the only verdict that matters here.
    execFile(bin, args, { timeout: 8000 }, (err) => {
      resolve(!(err && err.code === "ENOENT"));
    });
  });
}

/* ---------------- running a harness ---------------- */

function run(bin, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(
      bin,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (err.killed ? -1 : (err.code ?? 1)) : 0,
          timedOut: !!(err && err.killed),
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          durMs: Date.now() - started,
        });
      }
    );
  });
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "\n…[truncated by bridge]" : s;
}

/* ---------------- quota ---------------- */

async function quotaBlock(adapter) {
  const bin = await resolveBinary(adapter);
  const head = bin
    ? `${adapter.name}: found at ${bin}`
    : `${adapter.name}: NOT installed (${adapter.install.short})`;
  return `${head}\nfuel (from agent-dashboard):\n${fuelSummaryText()}`;
}

async function quotaText() {
  const blocks = [];
  for (const adapter of Object.values(HARNESSES)) {
    blocks.push(
      adapter.hasFuel
        ? await quotaBlock(adapter)
        : `${adapter.name}: no quota source is configured for this harness`
    );
  }
  return blocks.join("\n\n");
}

/* ---------------- consult ---------------- */

async function consult(args, pinned) {
  const query = String(args.query ?? "").trim();
  if (!query) return { isError: true, text: "query is required" };

  const name = pinned ?? args.harness ?? DEFAULT_HARNESS;
  const adapter = HARNESSES[name];
  if (!adapter) return { isError: true, text: `unknown harness: ${name}` };

  const cwd = args.directory ? path.resolve(args.directory) : process.cwd();
  if (!fs.existsSync(cwd)) {
    return { isError: true, text: `directory not found: ${cwd}` };
  }

  const bin = await resolveBinary(adapter);
  if (!bin) return { isError: true, text: adapter.install.long };

  // Fuel gate (agy only): the whole point of routing through Antigravity is
  // free quota; refuse to quietly spend the last of it.
  let fuel = { available: false };
  if (adapter.hasFuel) {
    fuel = fuelSummary();
    if (
      !args.allow_low_quota &&
      fuel.available &&
      fuel.lowestRemaining != null &&
      fuel.lowestRemaining < MIN_REMAINING
    ) {
      return {
        isError: true,
        text:
          `Refusing to delegate: Antigravity fuel is low (${fuel.lowestRemaining}% remaining, ` +
          `threshold ${MIN_REMAINING}%).\n${fuelSummaryText()}\n\n` +
          "Either wait for the reset, drop the heavy work onto a non-Antigravity model, or " +
          "pass allow_low_quota=true to override.",
      };
    }
  }

  const cmdArgs = adapter.buildArgs({
    query,
    model: args.model,
    effort: args.effort,
    cwd,
    addDirs: args.add_dir ?? [],
    skipPermissions: !!args.skip_permissions,
  });

  const timeoutMs = Math.min(900, Math.max(10, Number(args.timeout_sec) || 300)) * 1000;
  const res = await run(bin, cmdArgs, cwd, timeoutMs);

  const parsed = adapter.parse(res.stdout);
  let text = parsed.text;
  let source = parsed.parsed ? "stdout-json" : "stdout-text";
  let fallbackNote = "";

  if (!text && name === "agy") {
    // Upstream issue #76 can leave stdout empty; agy still records the
    // exchange, so read the newest conversation's final answer.
    const conv = latestTurnText();
    if (conv.text) {
      text = conv.text;
      source = "conversation-store";
    } else {
      fallbackNote = `\nConversation fallback: ${conv.reason}`;
    }
  }

  if (!text) {
    const quota = /RESOURCE_EXHAUSTED|429/.test(res.stderr + res.stdout)
      ? "\nThe backend reported RESOURCE_EXHAUSTED (quota exhausted for this account/model)."
      : "";
    const denied = (parsed.denied ?? [])
      .map((d) => d.action || d.display_name || String(d))
      .filter(Boolean);
    const permissionNote = denied.length
      ? `\nDenied in headless mode: ${denied.join(", ")}. ` +
        `The turn ran but the tool call was auto-denied by ${name}'s permission layer, ` +
        `so nothing was written. Retry with skip_permissions=true (trusted task), ` +
        `or grant a write rule for ${cwd}/ in ${name}'s settings.`
      : "";
    return {
      isError: true,
      text:
        `${name} produced no readable output (exit ${res.code}${res.timedOut ? ", timed out" : ""}).` +
        quota +
        permissionNote +
        `\nstderr: ${res.stderr.trim().slice(0, 400) || "(empty)"}` +
        (name === "agy" ? `\nChecked stdout and ${AGY_CONV_DIR}.` : "\nChecked stdout.") +
        fallbackNote,
    };
  }

  const meta =
    `\n\n[bridge] harness=${name} exit=${res.code} dur=${(res.durMs / 1000).toFixed(1)}s ` +
    `source=${source}` +
    `${res.timedOut ? " TIMED-OUT" : ""}` +
    (fuel.available && fuel.lowestRemaining != null
      ? ` | antigravity fuel before call: lowest ${fuel.lowestRemaining}%`
      : "");
  return truncate(text, MAX_OUTPUT_CHARS) + meta;
}

/* ---------------- tool definitions ---------------- */

function consultSchema({ withHarness, legacy }) {
  // Legacy mode keeps the original agy-only wording so the registered tool
  // looks exactly as it did before the refactor.
  const target = legacy ? "agy" : "the harness";
  const properties = {
    query: { type: "string", description: `The task or question, sent verbatim to ${target}.` },
    directory: { type: "string", description: `Working directory for ${target} (default: current).` },
    add_dir: {
      type: "array",
      items: { type: "string" },
      description: `Extra directories ${target} may read (repeatable --add-dir).`,
    },
    model: { type: "string", description: "Pin a model slug (e.g. gemini-3.8-flash-medium)." },
    effort: {
      type: "string",
      enum: ["low", "medium", "high", "xhigh", "max"],
      description: legacy
        ? "Reasoning effort."
        : "Reasoning effort (agy only; ignored for claude and codex).",
    },
    timeout_sec: { type: "number", description: "Hard timeout, default 300, max 900." },
    skip_permissions: {
      type: "boolean",
      description: legacy
        ? "Pass --dangerously-skip-permissions: agy auto-approves shell commands and file " +
          "edits. Only for tasks you trust, in a directory you can afford to have changed."
        : "Let the harness run without prompting for approval (agy: --dangerously-skip-permissions; " +
          "claude: bypassPermissions; codex: sandbox danger-full-access). Only for tasks you trust, " +
          "in a directory you can afford to have changed.",
    },
    allow_low_quota: {
      type: "boolean",
      description: legacy
        ? "Proceed even when tracked remaining quota is below the threshold."
        : "Proceed even when tracked remaining quota is below the threshold (agy only).",
    },
  };
  if (withHarness) {
    properties.harness = {
      type: "string",
      enum: ["agy", "claude", "codex"],
      description: `Which CLI to delegate to (default: ${DEFAULT_HARNESS}).`,
    };
  }
  return { type: "object", properties, required: ["query"] };
}

function consultTool({ name, description, withHarness, pinned, legacy = false }) {
  return {
    name,
    description,
    inputSchema: consultSchema({ withHarness, legacy }),
    run: (args) => consult(args, pinned),
  };
}

function quotaTool({ name, description, legacy }) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: {} },
    run: () => (legacy ? quotaBlock(HARNESSES.agy) : quotaText()),
  };
}

function harnessesTool() {
  return {
    name: "harnesses",
    description:
      "List the agent CLIs this bridge can delegate to, with the resolved binary path for each " +
      "and whether it has a tracked fuel budget. Never throws, even when nothing is installed.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const rows = await Promise.all(
        Object.values(HARNESSES).map(async (a) => {
          let bin = null;
          try {
            bin = await resolveBinary(a);
          } catch {
            /* a broken probe must not take the list down */
          }
          return {
            name: a.name,
            label: a.label,
            bin: bin ?? "not installed",
            fuel: a.hasFuel ? "fuel gate: yes" : "fuel gate: no",
          };
        })
      );
      const width = Math.max(...rows.map((r) => r.name.length));
      return rows
        .map(
          (r) =>
            `${r.name.padEnd(width)}  ${r.label.padEnd(15)}  ${r.bin.padEnd(34)}  ${r.fuel}`
        )
        .join("\n");
    },
  };
}

/* ---------------- server ---------------- */

export function buildServer({ legacy = false } = {}) {
  const tools = legacy
    ? [
        quotaTool({
          name: "antigravity_quota",
          description:
            "Show the current Antigravity quota (per account, per model, with reset times) and whether " +
            "the agy CLI is available. Call this before delegating a heavy task.",
          legacy: true,
        }),
        consultTool({
          name: "antigravity_consult",
          description:
            "Delegate a task to the Antigravity CLI (agy) running on the Gemini Enterprise seat and " +
            "return its answer. Use it for heavy agentic jobs where the seat's quota is free, and " +
            "keep working in OpenCode meanwhile. The call is refused when tracked quota is low, unless " +
            "allow_low_quota is set.",
          withHarness: false,
          pinned: "agy",
          legacy: true,
        }),
      ]
    : [
        consultTool({
          name: "consult",
          description:
            "Delegate a task to an agent CLI (agy, claude or codex) and return its answer. Use it " +
            "for heavy jobs on another harness's quota while you keep working here. For agy the call " +
            "is refused when tracked Antigravity fuel is low, unless allow_low_quota is set.",
          withHarness: true,
        }),
        harnessesTool(),
        quotaTool({
          name: "quota",
          description:
            "Show which harnesses are installed and, for agy, the current Antigravity quota " +
            "(per account, per model, with reset times). Call this before delegating a heavy task.",
          legacy: false,
        }),
      ];

  return createMcpServer({ name: "agent-bridge", version: "0.2.0", tools });
}

// Only auto-start when run directly; agy-bridge.mjs imports buildServer.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildServer({ legacy: false }).run();
}
