// Paths and environment. Everything overridable, nothing hardcoded to a machine.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(ROOT, "..", "data");

export const MEMORY_DB =
  process.env.MEMORY_DB_PATH ?? path.join(DATA_DIR, "memory.db");

// Agent dashboard's database — read-only, used as the fuel signal for routing.
export const DASHBOARD_DB =
  process.env.AGENT_DASHBOARD_DB ??
  path.join(os.homedir(), "home/project/agent-dashboard/data/usage.db");

// Antigravity CLI binary name and where it keeps conversations.
export const AGY_BIN = process.env.AGY_BIN ?? "agy";
export const AGY_CONV_DIR =
  process.env.AGY_CONV_DIR ??
  path.join(os.homedir(), ".gemini/antigravity-cli/conversations");

// Reuse the running Node for any child that needs an interpreter.
export const NODE = process.execPath;
