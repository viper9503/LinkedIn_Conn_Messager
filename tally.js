// Outreach tally report. Reads invite-log.json, prints how many invites went out
// per day / rolling-week / rolling-month, and (re)writes OUTREACH-LOG.md so there
// is always a persistent, human-readable record you can open.
//
// Usage:  node tally.js
//
// Counts only invites that actually went out. Caps live in lib/tally.js — edit
// them there. This script sends nothing and touches no browser.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPS, LINKEDIN_REF, computeTally, renderConsole, renderMarkdown } from './lib/tally.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.resolve(__dirname, 'invite-log.json');
const mdPath = path.resolve(__dirname, 'OUTREACH-LOG.md');

let log = {};
try {
  log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
} catch {
  console.error(`No readable invite-log.json at ${logPath}`);
  process.exit(1);
}

const now = new Date();
const t = computeTally(log, now);

console.log('\n' + renderMarkdown(t, now));
console.log('────────────────────────────────────────────────────────');
console.log(renderConsole(t));
console.log(
  `Caps: daily ${CAPS.daily}, weekly ${CAPS.weekly}, monthly ${CAPS.monthly}  •  ` +
    `LinkedIn ceilings: ~${LINKEDIN_REF.weeklyInviteCeiling}/wk, ~${LINKEDIN_REF.pendingCeiling} pending, ~${LINKEDIN_REF.freeNotesPerMonth} noted/mo (free)`
);

fs.writeFileSync(mdPath, renderMarkdown(t, now));
console.log(`\nWrote ${mdPath}\n`);
