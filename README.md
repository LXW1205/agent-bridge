# agent-bridge

Two small MCP servers that let several coding agents share one memory and borrow each
other's quota. One server is a SQLite-backed note store any MCP client can read and write;
the other shells out to an installed agent CLI (`agy`, Claude Code, or Codex CLI) headlessly,
returns its answer, and reports which harnesses are available. It was built to let OpenCode
and Antigravity hand work to each other on a single machine, and generalised so the same
wiring works for Claude Code and Codex CLI. Zero dependencies, ESM only, Node >= 22.5
(built-in `node:sqlite`).

## Servers and tools

| Server | File | Tools | Role |
|---|---|---|---|
| Shared memory | `memory-server.mjs` | `remember`, `recall`, `forget` | Durable notes both agents read |
| Consult bridge | `consult-server.mjs` | `consult`, `harnesses`, `quota` | Delegate a task to an installed agent CLI |
| Legacy shim | `agy-bridge.mjs` | `antigravity_consult`, `antigravity_quota` | Old names, pinned to agy, so existing registrations keep working |

`data/` (created on first write) holds the personal SQLite store — `memory.db` plus its
`-wal`/`-shm` siblings. It is ignored by git and is never part of the repo.

## Harness matrix

The memory server is plain MCP over stdio, so it works with **any MCP client**. The consult
bridge has one backend adapter per CLI:

| Backend | Adapter | Fuel gate | Verified here |
|---|---|---|---|
| `agy` (Antigravity CLI) | `agy` | yes, from the agent-dashboard database | yes, on agy 1.5.3 |
| `claude` (Claude Code) | `claude` | no | no — not installed on this machine |
| `codex` (Codex CLI) | `codex` | no | no — not installed on this machine |

`harnesses` lists what is actually installed; `consult` targets `agy` by default, or whatever
`AGENT_BRIDGE_DEFAULT_HARNESS` names, or an explicit `harness` argument.

## Install

Register a server per harness with that harness's own `mcp add` command. Use the absolute
path to the node binary that will run the server (`npm run doctor` prints these for your
machine):

```bash
NODE="$(command -v node)"        # must be >= 22.5
REPO=/path/to/agent-bridge
```

OpenCode:

```bash
opencode mcp add memory -- "$NODE" "$REPO/memory-server.mjs"
opencode mcp add bridge -- "$NODE" "$REPO/consult-server.mjs"
```

Antigravity (flags before the name; `--type` defaults to stdio):

```bash
agy mcp add memory --type stdio -- "$NODE" "$REPO/memory-server.mjs"
agy mcp add bridge --type stdio -- "$NODE" "$REPO/consult-server.mjs"
```

Claude Code:

```bash
claude mcp add memory -- "$NODE" "$REPO/memory-server.mjs"
claude mcp add bridge -- "$NODE" "$REPO/consult-server.mjs"
```

Codex CLI:

```bash
codex mcp add memory -- "$NODE" "$REPO/memory-server.mjs"
codex mcp add bridge -- "$NODE" "$REPO/consult-server.mjs"
```

Existing registrations of `agy-bridge.mjs` need no change: it is now a shim that serves the
old `antigravity_*` tool names from the same file path, harness pinned to agy. New installs
should register `consult-server.mjs` instead.

`agy` itself must be signed in (run `agy` with no arguments once) with the **Gemini Enterprise
seat account**, otherwise `models` and delegation fail with "Please sign in".

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `MEMORY_DB_PATH` | `data/memory.db` | Memory store location |
| `AGENT_DASHBOARD_DB` | `~/home/project/agent-dashboard/data/usage.db` | Fuel data source for the agy gate. That default is the author's local layout: point it at your own SQLite file with an `ag_snapshot` table, or leave it unset and the gate reports unavailable, which lets delegation proceed |
| `AGY_BIN` | `agy`, then `~/.local/bin/agy`, `~/.local/share/nodejs/bin/agy` | Antigravity CLI binary |
| `CLAUDE_BIN` | `claude`, then `~/.local/bin/claude` | Claude Code binary |
| `CODEX_BIN` | `codex`, then `~/.local/bin/codex` | Codex CLI binary |
| `AGY_CONV_DIR` | `~/.gemini/antigravity-cli/conversations` | agy conversation store (viewer + fallback) |
| `AGY_MIN_REMAINING` | `20` | Fuel gate threshold (%) |
| `AGENT_BRIDGE_DEFAULT_HARNESS` | `agy` | Backend `consult` uses when none is named |

Binary discovery is lazy: a *missing* binary is re-probed after 30 s, so installing the CLI
later is picked up without restarting the MCP server. A found binary stays cached.

## What is verified

Honest accounting, from the machine this repo was written on:

| Claim | Status |
|---|---|
| `agy` flags used by the adapter (`-p`, `--output-format json`, `--model`, `--effort`, `--add-dir`, `--settings`, `--dangerously-skip-permissions`) | verified against `agy --help` on 1.5.3 |
| agy consult path end to end | verified live on agy 1.5.3 |
| agy conversation decoder (protobuf walk, `step_type` 14/15) | verified on agy **1.3.1** |
| `claude` adapter | **not exercised** — `claude` is not installed here; argv follows the documented `--print`/`--output-format json`/`--permission-mode` flags |
| `codex` adapter | **not exercised** — `codex` is not installed here; argv follows the documented `exec` subcommand and `--sandbox` flags |
| Memory server + both tool lists + remember/recall | covered by `npm test` (stdio, temp database) |

## Conversations decoder

`lib/agy-conversations.mjs` is the single decoder used by both the consult fallback and the
`agy-conversations.mjs` CLI.

Verified against agy 1.3.1:

- one SQLite file per thread: `~/.gemini/antigravity-cli/conversations/<id>.db`
- `trajectory_meta` holds the ids, `steps` holds the turns; there are **no text columns** —
  `step_payload` is protobuf
- walking its length-delimited fields yields clean UTF-8: the user prompt, the model's
  answer, cwd, ids
- role mapping is inferred: `step_type` **14 → user**, **15 → assistant**
- plumbing is filtered (UUIDs, `bot-…`, base64 session tokens, paths) and a protobuf length
  byte that leaks into text ("3Reply with …") is stripped

```bash
node agy-conversations.mjs              # list threads
node agy-conversations.mjs --last       # newest assistant answer only
node agy-conversations.mjs <id|file>    # full transcript
node agy-conversations.mjs --json       # machine-readable
```

Caveat: field numbers and status codes have no published `.proto`, so this is inference over a
private store — an agy update may change it. Nothing in the store records an account email or
licence, so threads cannot be attributed to the seat vs the personal account.

## Design notes

- **Fuel gate (agy only).** The point of routing through Antigravity is free seat quota, so
  `consult` refuses when tracked remaining quota is below `AGY_MIN_REMAINING`, unless
  `allow_low_quota` is set. When the dashboard database is absent the gate reports
  unavailable and lets the call proceed. Other harnesses have no quota source, so no gate.
- **Quota units.** `antigravity-usage` records `remainingPercentage` as a **0..1 fraction**
  (its own formatter multiplies by 100). Both the dashboard and the bridge normalise it; a
  new consumer that skips that reads "1%" where it means 100%.
- **Empty-stdout fallback.** `agy --print` has a known upstream bug (issue #76) where it can
  write nothing to a piped stdout. If stdout is empty the bridge reads the newest
  conversation's final assistant turn from agy's store. Extraction is restricted to `steps`
  and takes the last answer; the noisy full-request blob (`gen_metadata.data`) is never used.
- **Headless write permission.** agy print mode soft-denies `write_file` it cannot prompt
  for, exiting 0 with `"response": ""` and `denied_actions`. The adapter passes a
  session-only `--settings` grant scoped to the delegated working directory:
  `write_file(<cwd>/)`. Rules are exact-match strings; globs are silently ignored, and a
  trailing slash covers the whole directory. Project-level permission JSON does not work —
  the CLI clears it on load.
- **Empty answers are errors.** An empty response is reported as an error naming the denied
  tools, never as the `conversation_id` (an earlier generic JSON walker returned that UUID as
  if it were the answer).
- **stdout is protocol only.** Both servers write JSON-RPC frames to stdout and logs to
  stderr; nothing else may print there.
- **Deliberately not built:** seeding an OpenCode context into an agy thread (agy can
  continue its own threads with `--continue`/`--conversation`), and reverse delegation from
  Antigravity to another agent (its terminal tool can just run the CLI).

## Development

```bash
npm test         # stdio handshake + tools/list for all servers, memory round-trip
npm run doctor   # installed harnesses, per-harness registration commands, memory store
npm run memory   # memory server on stdio
npm run consult  # consult server on stdio
node agy-bridge.mjs  # legacy shim on stdio
```
