// Read-only view of the agent-dashboard's fuel data, used to gate delegation:
// don't silently burn the last of the Antigravity quota.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { DASHBOARD_DB } from "./config.mjs";

// antigravity-usage stores remainingPercentage as a 0..1 fraction (its own
// formatter multiplies by 100). Normalise to percent; also tolerate sources
// that already send percentages.
function toPercent(v) {
  return typeof v === "number" && v <= 1 ? v * 100 : v;
}

export function fuelSummary() {
  if (!fs.existsSync(DASHBOARD_DB)) {
    return { available: false, reason: `dashboard database not found at ${DASHBOARD_DB}` };
  }
  let db;
  try {
    db = new DatabaseSync(DASHBOARD_DB, { readOnly: true });
    const emails = db
      .prepare("SELECT DISTINCT email FROM ag_snapshot WHERE email IS NOT NULL")
      .all()
      .map((r) => r.email);

    const accounts = [];
    let lowest = null;

    for (const email of emails) {
      const latest = db
        .prepare(
          `SELECT taken_at, status, plan_type, models, error
             FROM ag_snapshot WHERE email = ? ORDER BY id DESC LIMIT 1`
        )
        .get(email);
      if (!latest || latest.status === "error") {
        accounts.push({ email, status: latest?.status ?? "unknown", error: latest?.error ?? null });
        continue;
      }
      let models = [];
      try {
        const seen = new Set();
        models = (JSON.parse(latest.models) || [])
          .filter((m) => !m.isAutocompleteOnly && m.remainingPercentage != null)
          .map((m) => {
            const remaining = toPercent(m.remainingPercentage);
            return {
              model: m.modelId,
              label: m.label,
              remaining,
              exhausted: !!m.isExhausted,
              resetMs: m.timeUntilResetMs ?? null,
              key: `${m.label ?? m.modelId}|${Math.round(remaining)}`,
            };
          })
          .filter((m) => (seen.has(m.key) ? false : (seen.add(m.key), true)));
      } catch {
        /* malformed snapshot: report the account without models */
      }
      const remaining = models
        .filter((m) => !m.exhausted)
        .map((m) => m.remaining);
      const min = remaining.length ? Math.min(...remaining) : null;
      if (min != null && (lowest == null || min < lowest)) lowest = min;
      accounts.push({
        email,
        status: latest.status,
        planType: latest.plan_type,
        takenAt: latest.taken_at,
        modelCount: models.length,
        models,
      });
    }
    return { available: true, lowestRemaining: lowest, accounts };
  } catch (e) {
    return { available: false, reason: `could not read dashboard db: ${e?.message ?? e}` };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

export function fuelSummaryText() {
  const f = fuelSummary();
  if (!f.available) return `no fuel data (${f.reason}) — account may not be connected yet`;
  if (!f.accounts.length) return "no Antigravity accounts connected yet";
  const lines = [`lowest remaining across accounts: ${f.lowestRemaining ?? "?"}%`];
  for (const a of f.accounts) {
    if (a.error) {
      lines.push(`- ${a.email}: error — ${a.error}`);
      continue;
    }
    const age = Math.round((Date.now() - a.takenAt) / 60000);
    const ms = (a.models || [])
      .map((m) => `${m.label || m.model} ${m.remaining}%${m.exhausted ? " (exhausted)" : ""}`)
      .join("; ");
    lines.push(`- ${a.email} [${a.planType ?? "?"}] (${age}m ago): ${ms || "no model quotas"}`);
  }
  return lines.join("\n");
}
