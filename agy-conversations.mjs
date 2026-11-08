#!/usr/bin/env node
// Read Antigravity CLI conversations (see lib/agy-conversations.mjs).
//
//   node agy-conversations.mjs              list threads
//   node agy-conversations.mjs --json       list as JSON
//   node agy-conversations.mjs --last       newest assistant answer only
//   node agy-conversations.mjs <id|file>    print one transcript
import {
  listConversations,
  findConversation,
  latestTurnText,
} from "./lib/agy-conversations.mjs";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const positional = args.find((a) => !a.startsWith("--"));

const when = (ms) => {
  const d = new Date(ms);
  return d.toISOString().slice(0, 16).replace("T", " ");
};
const oneLine = (s, n = 70) => s.replace(/\s+/g, " ").trim().slice(0, n);

if (flag("--last")) {
  const r = latestTurnText();
  if (!r.text) {
    console.error(`no answer found: ${r.reason}`);
    process.exit(1);
  }
  process.stdout.write(r.text + "\n");
  process.exit(0);
}

if (positional) {
  const conv = findConversation(positional);
  if (!conv) {
    console.error(`no conversation matching ${positional}`);
    process.exit(1);
  }
  console.log(`${conv.id}  (${when(conv.mtime)}, ${conv.turns.length} turns)  ${conv.file}`);
  for (const t of conv.turns) {
    console.log(`\n[${t.role}] step ${t.idx} (type ${t.type})`);
    console.log(t.text);
  }
  process.exit(0);
}

const convs = listConversations({ limit: 50 });

if (flag("--json")) {
  console.log(JSON.stringify(convs, null, 2));
  process.exit(0);
}

if (!convs.length) {
  console.log("no conversations found");
  process.exit(0);
}
for (const c of convs) {
  const turns = c.turns.length ? `${c.turns.length} turns` : (c.reason ?? "no turns");
  console.log(`${c.id}  ${when(c.mtime)}  ${turns}`);
  if (c.prompt) console.log(`    ${oneLine(c.prompt)}`);
  if (c.answer) console.log(`  → ${oneLine(c.answer)}`);
}
