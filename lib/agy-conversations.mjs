// Reader for Antigravity CLI conversation stores.
//
// Verified on agy 1.3.1: each conversation lives in
//   ~/.gemini/antigravity-cli/conversations/<cascade_id>.db
// with tables:
//   trajectory_meta(trajectory_id, cascade_id, trajectory_type, source)
//   steps(idx, step_type, status, ..., step_payload BLOB, ...)
//   gen_metadata(idx, data BLOB, size)          <- full model request (noisy)
//
// There are NO text columns: step_payload is protobuf. Walking its
// length-delimited fields yields clean UTF-8 (prompt, cwd, ids, answers).
// Field numbers and the numeric codes (step_type 14/15, status 3, ...) are
// undocumented, so role mapping below is inferred from observed samples.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { AGY_CONV_DIR } from "./config.mjs";

const MAX_TURN_CHARS = 4000;
const MAX_TEXT_FIELDS = 200;

// Fallback role mapping, inferred: 14 = user turn, 15 = model turn.
const ROLE_BY_STEP_TYPE = { 14: "user", 15: "assistant" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Ids often appear embedded and concatenated ("$uuid\"$uuid"), so any string
// containing a UUID is plumbing — a real prompt rarely carries one.
const CONTAINS_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BOT_RE = /^bot-[0-9a-f-]+$/i;
const NUM_RE = /^-?\d+$/;
const B64ISH_RE = /^[A-Za-z0-9+/=_-]{16,}$/; // session tokens, keys: no spaces
const PATH_RE = /^[a-z]+:\/\//i; // file://, https://

// Strings that are plumbing rather than conversational content.
export function isPlumbing(s) {
  return (
    UUID_RE.test(s) ||
    CONTAINS_UUID_RE.test(s) ||
    BOT_RE.test(s) ||
    NUM_RE.test(s) ||
    PATH_RE.test(s) ||
    s === "sessionID" ||
    (B64ISH_RE.test(s) && !s.includes(" "))
  );
}

// A protobuf length byte captured inside a text field can prefix the text
// (e.g. "3Reply with ..."). Drop a single leading digit followed by a letter.
export function cleanText(s) {
  let t = String(s).replace(/[\u0000-\u001f]+/g, " ").trim();
  if (/^\d[A-Za-z]/.test(t) && t.includes(" ")) t = t.slice(1);
  return t.trim();
}

// Walk protobuf LEN fields, collecting printable UTF-8 strings.
export function pbTexts(buf, out = [], depth = 0) {
  let i = 0;
  const readVarint = () => {
    let r = 0n;
    let shift = 0n;
    while (i < buf.length) {
      const x = buf[i++];
      r |= BigInt(x & 0x7f) << shift;
      if (!(x & 0x80)) break;
      shift += 7n;
    }
    return r;
  };
  while (i < buf.length && out.length < MAX_TEXT_FIELDS) {
    let tag;
    const tagStart = i;
    try {
      tag = readVarint();
    } catch {
      break;
    }
    if (i === tagStart) break;
    const wire = Number(tag & 7n);
    if (wire === 2) {
      const len = Number(readVarint());
      if (!Number.isFinite(len) || i + len > buf.length) break;
      const seg = buf.subarray(i, i + len);
      i += len;
      const text = seg.toString("utf8");
      if (/^[\x20-\x7e\s]{2,}$/.test(text)) out.push(text);
      else if (depth < 5) pbTexts(seg, out, depth + 1);
    } else if (wire === 0) {
      readVarint();
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 5) {
      i += 4;
    } else {
      break;
    }
  }
  return out;
}

function pickTurnText(strings) {
  const candidates = strings
    .map(cleanText)
    .filter((s) => s.length >= 2 && !isPlumbing(s))
    .sort((a, b) => b.length - a.length);
  if (!candidates.length) return "";
  return candidates[0].slice(0, MAX_TURN_CHARS);
}

// Read one conversation DB.
export function readConversation(file) {
  const st = fs.statSync(file);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const meta = db.prepare("SELECT * FROM trajectory_meta LIMIT 1").get() ?? {};
    const steps = db
      .prepare("SELECT idx, step_type, step_payload FROM steps ORDER BY idx")
      .all();

    const turns = [];
    for (const s of steps) {
      if (!s.step_payload) continue;
      const text = pickTurnText(pbTexts(Buffer.from(s.step_payload)));
      if (!text) continue;
      turns.push({
        idx: s.idx,
        type: s.step_type,
        role: ROLE_BY_STEP_TYPE[s.step_type] ?? "step",
        text,
      });
    }

    const firstUser = turns.find((t) => t.role === "user");
    const answers = turns.filter((t) => t.role === "assistant");
    return {
      id: meta.cascade_id ?? path.basename(file, path.extname(file)),
      file,
      mtime: st.mtimeMs,
      trajectoryId: meta.trajectory_id ?? null,
      trajectoryType: meta.trajectory_type ?? null,
      source: meta.source ?? null,
      turns,
      prompt: (firstUser ?? turns[0])?.text ?? "",
      answer: answers.length ? answers[answers.length - 1].text : "",
      reason: null,
    };
  } finally {
    db.close();
  }
}

function conversationFiles(dir = AGY_CONV_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(db|sqlite)$/i.test(f))
    .map((f) => {
      const full = path.join(dir, f);
      return { file: full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// Newest-first list. Unreadable files are reported rather than skipped silently.
export function listConversations({ dir = AGY_CONV_DIR, limit = 50 } = {}) {
  const out = [];
  for (const { file } of conversationFiles(dir).slice(0, limit)) {
    try {
      out.push(readConversation(file));
    } catch (e) {
      out.push({
        id: path.basename(file, path.extname(file)),
        file,
        mtime: fs.statSync(file).mtimeMs,
        turns: [],
        prompt: "",
        answer: "",
        reason: `unreadable: ${e?.message ?? e}`,
      });
    }
  }
  return out;
}

// Find one conversation by cascade id (full or prefix) or file path.
export function findConversation(target, { dir = AGY_CONV_DIR } = {}) {
  if (target && fs.existsSync(target)) return readConversation(target);
  const all = listConversations({ dir, limit: 500 });
  return (
    all.find((c) => c.id === target) ??
    all.find((c) => c.id.startsWith(target)) ??
    all.find((c) => path.basename(c.file).startsWith(target)) ??
    null
  );
}

// Newest conversation's last assistant text — the bridge's fallback when
// stdout comes back empty.
export function latestTurnText({ dir = AGY_CONV_DIR } = {}) {
  const files = conversationFiles(dir);
  if (!files.length) {
    return { text: "", reason: `no conversations in ${dir}` };
  }
  try {
    const conv = readConversation(files[0].file);
    if (conv.answer) {
      return { text: conv.answer, reason: null, file: conv.file, turns: conv.turns.length };
    }
    return {
      text: "",
      reason: `newest conversation ${conv.id} has no readable assistant turn`,
    };
  } catch (e) {
    return { text: "", reason: `could not read ${files[0].file}: ${e?.message ?? e}` };
  }
}
