// Outreach tally — counts how many connection invites actually went OUT, by day
// / rolling-week / rolling-month, from invite-log.json. Used by `tally.js` (the
// CLI report) and by connect.js (pre-send guardrail + auto-updating the log file).
//
// EDIT THESE CAPS to taste. They are YOUR self-imposed guardrails, deliberately
// set BELOW LinkedIn's real ceilings so you stay comfortably safe. Research basis:
//   • LinkedIn weekly invite cap ≈ 100/week (rolling 7-day), free accounts safest
//     at ~80; strong/aged accounts can go higher. Daily safe zone ≈ 15–20, never
//     >10 in one hour. Low acceptance rate (<~30%) is what triggers restrictions.
export const CAPS = { daily: 20, weekly: 80, monthly: 250 };

// LinkedIn's own reference ceilings (NOT your targets — the platform's limits).
export const LINKEDIN_REF = { weeklyInviteCeiling: 100, pendingCeiling: 500, freeNotesPerMonth: 5 };

// Only statuses that represent an invite that genuinely left for LinkedIn.
const SENT_STATUSES = new Set(['invited', 'pending-noteless']);

const DAY_MS = 86400000;

export function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Build the list of sent invites with parsed local timestamps.
function sentEntries(log) {
  const out = [];
  for (const [url, e] of Object.entries(log || {})) {
    if (!e || !SENT_STATUSES.has(e.status)) continue;
    const ts = e.time ? new Date(e.time) : e.date ? new Date(`${e.date}T12:00:00`) : null;
    if (!ts || isNaN(ts.getTime())) continue;
    out.push({ url, status: e.status, ts });
  }
  return out;
}

export function computeTally(log, now = new Date()) {
  const sent = sentEntries(log);
  const todayStr = localDateStr(now);
  const monthStr = todayStr.slice(0, 7);

  const perDay = {};
  for (const s of sent) {
    const k = localDateStr(s.ts);
    perDay[k] = (perDay[k] || 0) + 1;
  }
  const inWindow = (days) => sent.filter((s) => s.ts <= now && now - s.ts < days * DAY_MS).length;

  return {
    total: sent.length,
    today: perDay[todayStr] || 0,
    rolling7: inWindow(7),
    rolling30: inWindow(30),
    month: sent.filter((s) => localDateStr(s.ts).slice(0, 7) === monthStr).length,
    perDay,
    todayStr,
    monthStr,
  };
}

const bar = (n, max = 25) => '█'.repeat(Math.min(n, max)) + (n > max ? '…' : '');
const remain = (cap, used) => Math.max(0, cap - used);
const flag = (used, cap) => (used > cap ? '  ⚠ OVER' : used >= cap * 0.8 ? '  ⚠ near' : '');

// Compact one-liner for connect.js pre-flight.
export function renderConsole(t) {
  return (
    `Outreach so far — today: ${t.today}/${CAPS.daily}${flag(t.today, CAPS.daily)}` +
    ` | 7-day: ${t.rolling7}/${CAPS.weekly}${flag(t.rolling7, CAPS.weekly)}` +
    ` | 30-day: ${t.rolling30}/${CAPS.monthly}`
  );
}

// Full markdown report (written to OUTREACH-LOG.md and printed by tally.js).
export function renderMarkdown(t, now = new Date()) {
  const days = Object.keys(t.perDay).sort().reverse().slice(0, 21);
  const rows = days.map((d) => `| ${d} | ${String(t.perDay[d]).padStart(3)} | ${bar(t.perDay[d])} |`).join('\n');
  const over = (u, c) => (u > c ? ' **(OVER cap)**' : '');
  return `# Outreach tally

_Auto-generated from \`invite-log.json\`. Last updated: ${now.toISOString()}_

Counts only invites that actually went out (\`invited\` + \`pending-noteless\`).

| Window | Sent | Your cap | Remaining | LinkedIn ceiling |
|---|---|---|---|---|
| **Today** (${t.todayStr}) | ${t.today} | ${CAPS.daily} | ${remain(CAPS.daily, t.today)}${over(t.today, CAPS.daily)} | ~10/hr |
| **Rolling 7 days** | ${t.rolling7} | ${CAPS.weekly} | ${remain(CAPS.weekly, t.rolling7)}${over(t.rolling7, CAPS.weekly)} | ~100/wk |
| **Rolling 30 days** | ${t.rolling30} | ${CAPS.monthly} | ${remain(CAPS.monthly, t.rolling30)} | — |
| **This calendar month** (${t.monthStr}) | ${t.month} | — | — | ~5 noted/mo (free) |
| **All time** | ${t.total} | — | — | ~500 pending |

## Per-day (last 21 days with activity)

| Date | Sent | |
|---|---|---|
${rows || '| _(none)_ | 0 | |'}

> Caps are self-imposed guardrails in \`lib/tally.js\` (daily ${CAPS.daily}, weekly ${CAPS.weekly}, monthly ${CAPS.monthly}), set below LinkedIn's real limits. The lever that actually keeps you safe is **acceptance rate** — only invite relevant people, with a note.
`;
}

import fs from 'node:fs';
// Read the log, compute, write the markdown file; returns the stats.
export function writeOutreachLog(logPath, mdPath, now = new Date()) {
  let log = {};
  try {
    log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  } catch {
    /* no log yet */
  }
  const t = computeTally(log, now);
  fs.writeFileSync(mdPath, renderMarkdown(t, now));
  return t;
}
