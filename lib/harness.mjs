// Harness adapters: one entry per agent CLI the bridge can delegate to.
// Each adapter knows how to find its binary, build argv and read the answer,
// so consult-server.mjs needs no per-backend branches.
import os from "node:os";
import path from "node:path";
import { AGY_BIN } from "./config.mjs";

/* ---------------- output parsing ---------------- */

// Walk arbitrary JSON (event streams, objects, arrays) and take the last
// non-empty text, which is normally the final assistant message.
function extractText(v, depth = 0) {
  if (depth > 8 || v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return "";
  if (Array.isArray(v)) {
    for (let i = v.length - 1; i >= 0; i--) {
      const t = extractText(v[i], depth + 1);
      if (t) return t;
    }
    return "";
  }
  if (typeof v === "object") {
    for (const k of [
      "response", "text", "result", "content", "message", "answer",
      "output", "data", "parts", "candidates", "steps", "events", "items",
    ]) {
      if (k in v) {
        const t = extractText(v[k], depth + 1);
        if (t) return t;
      }
    }
    for (const val of Object.values(v)) {
      const t = extractText(val, depth + 1);
      if (t) return t;
    }
  }
  return "";
}

function parseAgyOutput(stdout) {
  const s = (stdout ?? "").trim();
  if (!s) return { text: "", parsed: false, denied: [] };
  try {
    const j = JSON.parse(s);
    // Print mode returns {response, denied_actions?}. An empty response with
    // denied_actions means the turn completed without doing the work, and the
    // generic walker would otherwise return conversation_id as the "answer".
    if (j && typeof j === "object" && !Array.isArray(j)) {
      const denied = Array.isArray(j.denied_actions) ? j.denied_actions : [];
      if (typeof j.response === "string") {
        return { text: j.response.trim(), parsed: true, denied };
      }
      return { text: extractText(j), parsed: true, denied };
    }
    return { text: extractText(j), parsed: true, denied: [] };
  } catch {
    return { text: s, parsed: false, denied: [] };
  }
}

// claude wraps its answer in JSON ({"result": "..."}); codex prints the final
// message as plain text. Try JSON first, otherwise treat stdout as the answer.
function parseJsonOrText(stdout) {
  const s = (stdout ?? "").trim();
  if (!s) return { text: "", parsed: false, denied: [] };
  try {
    const j = JSON.parse(s);
    if (j && typeof j === "object" && !Array.isArray(j)) {
      const denied = Array.isArray(j.denied_actions) ? j.denied_actions : [];
      if (typeof j.result === "string") return { text: j.result.trim(), parsed: true, denied };
      if (Array.isArray(j.content)) return { text: extractText(j.content), parsed: true, denied };
      return { text: extractText(j), parsed: true, denied };
    }
    return { text: extractText(j), parsed: true, denied: [] };
  } catch {
    return { text: s, parsed: false, denied: [] };
  }
}

/* ---------------- adapters ---------------- */

const home = os.homedir();

export const HARNESSES = {
  agy: {
    name: "agy",
    label: "Antigravity CLI",
    binEnv: "AGY_BIN",
    defaultBins: [
      AGY_BIN,
      "agy",
      path.join(home, ".local/bin/agy"),
      path.join(home, ".local/share/nodejs/bin/agy"),
    ].filter(Boolean),
    probeArgs: ["--help"],
    hasFuel: true,
    install: {
      short: "install the Antigravity CLI and sign in with the seat account",
      long:
        "Antigravity CLI (agy) not found, so nothing can be delegated yet.\n" +
        "Install the Antigravity CLI, sign in with your Gemini Enterprise seat account, " +
        "then retry. If the binary lives somewhere unusual, set AGY_BIN to its full path " +
        "on this MCP server's environment.",
    },
    buildArgs({ query, model, effort, cwd, addDirs = [], skipPermissions }) {
      const argv = ["-p", query, "--output-format", "json"];
      if (model) argv.push("--model", String(model));
      if (effort) argv.push("--effort", String(effort));
      for (const d of addDirs) argv.push("--add-dir", String(d));
      if (skipPermissions) argv.push("--dangerously-skip-permissions");
      else {
        // Headless agy auto-denies writes it cannot prompt for. Grant writes
        // inside the delegated working directory only (rules are exact-match
        // strings; a trailing slash covers a directory).
        const scope = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
        argv.push(
          "--settings",
          JSON.stringify({ permissions: { allow: [`write_file(${scope})`] } })
        );
      }
      return argv;
    },
    parse: parseAgyOutput,
  },

  // claude is NOT installed on the machine this repo was written on, so this
  // adapter is unexercised. The argv follows the documented Claude Code CLI
  // flags; there is no --effort flag, so effort is ignored here.
  claude: {
    name: "claude",
    label: "Claude Code",
    binEnv: "CLAUDE_BIN",
    defaultBins: ["claude", path.join(home, ".local/bin/claude")],
    probeArgs: ["--help"],
    hasFuel: false,
    install: {
      short: "install the Claude Code CLI and sign in",
      long:
        "Claude Code (claude) not found, so nothing can be delegated yet.\n" +
        "Install Claude Code (npm i -g @anthropic-ai/claude-code), sign in, then retry. " +
        "If the binary lives somewhere unusual, set CLAUDE_BIN to its full path on this " +
        "MCP server's environment.",
    },
    buildArgs({ query, model, addDirs = [], skipPermissions }) {
      const argv = ["--print", "--output-format", "json"];
      if (model) argv.push("--model", String(model));
      for (const d of addDirs) argv.push("--add-dir", String(d));
      argv.push("--permission-mode", skipPermissions ? "bypassPermissions" : "acceptEdits");
      argv.push(query);
      return argv;
    },
    parse: parseJsonOrText,
  },

  // codex is NOT installed on the machine this repo was written on, so this
  // adapter is unexercised. Note: on codex -p means --profile, never print.
  codex: {
    name: "codex",
    label: "Codex CLI",
    binEnv: "CODEX_BIN",
    defaultBins: ["codex", path.join(home, ".local/bin/codex")],
    probeArgs: ["--help"],
    hasFuel: false,
    install: {
      short: "install the Codex CLI and sign in",
      long:
        "Codex CLI (codex) not found, so nothing can be delegated yet.\n" +
        "Install Codex (npm i -g @openai/codex), sign in, then retry. If the binary lives " +
        "somewhere unusual, set CODEX_BIN to its full path on this MCP server's environment.",
    },
    buildArgs({ query, model, cwd, addDirs = [], skipPermissions }) {
      const argv = ["exec", query];
      if (model) argv.push("--model", String(model));
      if (cwd) argv.push("--cd", cwd);
      for (const d of addDirs) argv.push("--add-dir", String(d));
      argv.push("--skip-git-repo-check");
      argv.push("--sandbox", skipPermissions ? "danger-full-access" : "workspace-write");
      return argv;
    },
    parse: parseJsonOrText,
  },
};
