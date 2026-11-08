#!/usr/bin/env node
// Shared-memory MCP server. Attach to both agents:
//   OpenCode:     opencode mcp add  (or the config in README)
//   Antigravity:  agy mcp add memory --type stdio -- node <this file>
//
// Tools: memory_remember, memory_recall, memory_forget
import { createMcpServer } from "./lib/mcp.mjs";
import { remember, recall, forget, stats } from "./lib/store.mjs";

const tools = [
  {
    name: "remember",
    description:
      "Save a durable note to the shared memory both agents read (decisions, project facts, " +
      "preferences, task state). Use it after finishing meaningful work so the other agent " +
      "(OpenCode or Antigravity) can pick it up later without re-deriving it.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The note. Be specific and self-contained." },
        agent: { type: "string", description: "Who is writing: 'opencode' or 'antigravity'." },
        scope: { type: "string", description: "Optional project/scope key (e.g. repo name)." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
      },
      required: ["text"],
    },
    run: (args) => {
      const { id, created } = remember(args);
      return `saved memory #${id} at ${new Date(created).toISOString()}`;
    },
  },
  {
    name: "recall",
    description:
      "Search the shared memory. Call this at the start of a task to recover context a previous " +
      "session (in either agent) stored. With no query, returns the most recent notes.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to match in text/tags/scope." },
        tags: { type: "array", items: { type: "string" }, description: "Require these tags." },
        scope: { type: "string", description: "Restrict to one scope." },
        since_days: { type: "number", description: "Only notes newer than this many days." },
        limit: { type: "number", description: "Max results (default 10)." },
      },
    },
    run: (args) => {
      const rows = recall({
        query: args.query,
        tags: args.tags,
        scope: args.scope,
        sinceDays: args.since_days,
        limit: args.limit ?? 10,
      });
      if (!rows.length) return "no memories matched";
      return rows
        .map((r) => {
          const d = new Date(r.created).toISOString().slice(0, 16).replace("T", " ");
          const who = r.agent ? ` by ${r.agent}` : "";
          const tags = r.tags ? ` [${r.tags}]` : "";
          const scope = r.scope ? ` (${r.scope})` : "";
          return `#${r.id} ${d}${who}${scope}${tags}\n${r.text}`;
        })
        .join("\n---\n");
    },
  },
  {
    name: "forget",
    description: "Delete one memory by its id (use when a note is wrong or obsolete).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Memory id from recall output." } },
      required: ["id"],
    },
    run: (args) => {
      const ok = forget(args.id);
      const s = stats();
      return ok
        ? `deleted memory #${args.id} (${s.c} memories remain)`
        : `no memory with id ${args.id}`;
    },
  },
];

createMcpServer({ name: "shared-memory", version: "0.1.0", tools }).run();
