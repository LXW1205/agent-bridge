#!/usr/bin/env node
// Legacy shim: an existing OpenCode MCP config and an `agy mcp add` entry both
// point at this path, so keep serving antigravity_consult/antigravity_quota
// from here. The real server lives in consult-server.mjs.
import { buildServer } from "./consult-server.mjs";

buildServer({ legacy: true }).run();
