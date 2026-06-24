// LinkedIn connection-request helper — sends an INVITE WITH A NOTE, never a
// message/InMail. Companion to messenger.js (which is for existing connections).
//
// Usage:
//   node connect.js --targets my.csv --note referral-note.txt        # dry run
//   node connect.js --targets my.csv --note referral-note.txt --send # actually send
//   node connect.js --min 4 --max 10     # delay bounds between profiles (sec)
//   node connect.js ... --send --force   # override the daily/weekly rate guardrail
//
// A pre-send tally (today / rolling 7-day) prints every run and refuses to exceed
// the caps in lib/tally.js unless --force is given. OUTREACH-LOG.md is rewritten
// after each run. Use `node tally.js` any time for the full report.
//
// Notes are capped at 300 chars by LinkedIn; every row is validated up front.
// Skips (never guesses): already-connected (use messenger.js), invite pending,
// email-required gates, and no-Connect-button profiles. Each result lands in
// invite-log.json so nobody is double-invited across runs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { parseCsv } from './lib/csv.js';
import { CAPS, computeTally, renderConsole, writeOutreachLog } from './lib/tally.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOTE_LIMIT = 300;

// ---------- args ----------
function parseArgs(argv) {
  const args = { send: false, force: false, min: 4, max: 10, targets: 'targets.csv', note: 'referral-note.txt' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--send') args.send = true;
    else if (a === '--force') args.force = true;
    else if (a === '--min') args.min = Number(argv[++i]);
    else if (a === '--max') args.max = Number(argv[++i]);
    else if (a === '--targets') args.targets = argv[++i];
    else if (a === '--note') args.note = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('See the comment block at the top of connect.js for usage.');
      process.exit(0);
    }
  }
  if (args.max < args.min) args.max = args.min;
  return args;
}

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
const today = () => new Date().toISOString().slice(0, 10);

// Defense-in-depth against the 2026-06-15 incident: never click a Connect
// control whose accessible name doesn't name the intended target. A suggestion
// card or any wrong-profile control carries a different person's name, so this
// fails CLOSED — we skip rather than risk an instant note-less invite to a
// stranger. Matches first + last token (tolerates middle names in the label).
function nameMatches(ariaLabel, fullName) {
  const L = (ariaLabel || '').toLowerCase();
  const parts = (fullName || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return true; // nothing to check against
  const first = parts[0];
  const last = parts[parts.length - 1];
  return L.includes(first) && L.includes(last);
}

function render(template, row) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    if (!(key in row)) {
      throw new Error(`Note uses {{${key}}} but the CSV has no "${key}" column`);
    }
    return row[key];
  });
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// LinkedIn's newer profile UI (obfuscated classes + `componentkey` attrs, seen
// 2026-06-24) renders action controls that pass Playwright's visible/enabled/
// overlay checks but never satisfy its "stable" actionability gate in a headed-
// but-occluded window (requestAnimationFrame throttling), so a plain .click()
// hangs until timeout — confirmed read-only: the anchor is visible, enabled,
// in-viewport, pointer-events:auto, animation:none, nothing overlapping it, yet
// even a no-op {trial:true} probe times out. We click robustly: bring the tab to
// front, scroll into view, try a normal click, then a forced click (skips the
// stability wait), then a direct event dispatch on the exact resolved node.
// SAFETY: every caller has ALREADY identity-verified this node's aria-label
// (nameMatches) and recon confirmed nothing overlays it, so a forced/dispatched
// click targets the same vetted control — it cannot land on a different person.
async function robustClick(page, locator, timeout = 6000) {
  await page.bringToFront().catch(() => {});
  await locator.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
  try {
    await locator.click({ timeout });
    return 'click';
  } catch {
    /* actionability gate stuck — escalate */
  }
  try {
    await locator.click({ force: true, timeout });
    return 'force';
  } catch {
    /* point-click failed (covered/odd geometry) — dispatch on the node itself */
  }
  await locator.dispatchEvent('click');
  return 'dispatch';
}

// ---------- LinkedIn interaction ----------
async function ensureLoggedIn(page) {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  const isLoggedIn = async () => {
    const cookies = await page.context().cookies('https://www.linkedin.com');
    if (cookies.some((c) => c.name === 'li_at' && c.value)) return true;
    if (/\/(login|signup|authwall)/.test(page.url())) return false;
    return (await page.locator('#global-nav, nav.global-nav, img.global-nav__me-photo').count()) > 0;
  };
  if (await isLoggedIn()) return;
  console.log('\nPlease log in to LinkedIn in the browser window. Waiting up to 5 minutes...\n');
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await isLoggedIn()) return;
    await sleep(2000);
  }
  throw new Error('Timed out waiting for login (5 min).');
}

// Profile relationship state, read from the top (intro) card ONLY.
//
// CRITICAL: LinkedIn now renders the "More profiles for you" suggestion cards
// INSIDE <main>, and each suggestion has its own <button aria-label="Invite NAME
// to connect"> that fires an INSTANT, note-less invite with no modal. A
// main-scoped, button-based selector matches those strangers instead of the
// person you're on. Two defenses keep us off them: (a) we target the profile's
// OWN Connect, which is an <a> ANCHOR — suggestion quick-connects are <button>s;
// and (b) the caller (main loop) refuses to click any control whose aria-label
// name doesn't match the intended target (nameMatches), so a misfire fails
// CLOSED. We RETURN that aria-label (`label`) here so the caller can enforce (b).
async function profileState(page) {
  // Don't read state before the top card hydrates.
  await page.locator('main a:visible, main button:visible').first().waitFor({ state: 'visible', timeout: 15000 });

  // The profile's OWN actions are ANCHORS (<a>) in <main>. The "More profiles
  // for you" suggestions — now also inside <main> — use <button>s that fire an
  // INSTANT note-less invite. Keying on anchor-vs-button is what keeps us off
  // those sidebar strangers. .first() prefers the intro card (earlier in DOM).

  // 1) Own Connect present -> connectable. Checked FIRST: its presence proves
  //    this isn't a 1st-degree connection, so we never misread a real target.
  const directA = page.locator('main a[aria-label^="Invite" i][aria-label*="to connect" i]:visible').first();
  if ((await directA.count()) > 0) {
    const label = (await directA.getAttribute('aria-label')) || '';
    return { state: 'connectable', button: directA, label };
  }

  // 2) Own invite already pending (anchor: "Pending, click to withdraw…").
  if ((await page.locator('main a[aria-label^="Pending" i]:visible').count()) > 0) {
    return { state: 'pending' };
  }

  // 3) Follow-primary profiles hide Connect under the intro card's "More"
  //    overflow. Read the Connect item from the OPEN dropdown only.
  const more = page
    .locator('main button[aria-label="More" i]:visible, main button[aria-label^="More actions" i]:visible')
    .first();
  if ((await more.count()) > 0) {
    await robustClick(page, more);
    await sleep(rand(900, 1400));
    // Only match the Connect item INSIDE the overflow we just opened (or a
    // proper menuitem) — never a bare top-level suggestion-card <button>. The
    // caller's nameMatches() guard is the backstop if this ever widens.
    const item = page
      .locator(
        '.artdeco-dropdown__content--is-open [aria-label^="Invite" i][aria-label*="to connect" i]:visible, ' +
          '[role="menu"] [role="menuitem"][aria-label^="Invite" i][aria-label*="to connect" i]:visible'
      )
      .first();
    if ((await item.count()) > 0) {
      const label = (await item.getAttribute('aria-label')) || '';
      return { state: 'connectable', button: item, label };
    }
    await page.keyboard.press('Escape'); // close the dropdown we opened
  }

  // 4) No Connect/Pending path: a 1st-degree connection (own Message anchor) is
  //    treated as connected (use messenger.js); otherwise no connect path.
  if ((await page.locator('main a[aria-label^="Message" i]:visible:not([aria-label*="connect" i])').count()) > 0) {
    return { state: 'connected' };
  }
  return { state: 'no-connect-button' };
}

// Click Connect, attach the note, send (or discard on dry run).
// Returns 'invited' | 'dry-run' or throws with a specific reason.
async function inviteWithNote(page, note, send) {
  // Scope to LinkedIn's invite modal specifically. A plain div[role="dialog"]
  // also matches the hidden video.js caption dialog (.vjs-modal-dialog) that
  // exists on any profile with an embedded video post — that false match made
  // .last() wait on an invisible element until timeout. .artdeco-modal excludes it.
  const dialog = page.locator('.artdeco-modal[role="dialog"]:visible').first();
  await dialog.waitFor({ state: 'visible', timeout: 8000 });

  // Some profiles gate invites behind "enter their email" — never guessable.
  if ((await dialog.locator('input[type="email"]').count()) > 0) {
    await page.keyboard.press('Escape');
    throw new Error('email-required');
  }

  const addNote = dialog.getByRole('button', { name: /add a (free )?note/i }).first();
  await addNote.waitFor({ state: 'visible', timeout: 5000 });
  await robustClick(page, addNote);

  const box = dialog.locator('textarea[name="message"], textarea#custom-message').first();
  try {
    await box.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    // "Add a note" opened an upsell instead of a textarea (out of noted invites).
    await page.keyboard.press('Escape');
    throw new Error('no-note-box (out of personalized invites?)');
  }
  await box.fill(note);
  await sleep(rand(400, 900));

  if (!send) {
    await page.keyboard.press('Escape'); // discard, dialog asks nothing for empty… just close
    await sleep(300);
    await page.keyboard.press('Escape'); // dismiss possible "discard draft?" confirm
    return 'dry-run';
  }

  // Accessible name is "Send now" on some variants, "Send invitation"/"Send" on others.
  const sendBtn = dialog.getByRole('button', { name: /^send( now| invitation)?$/i }).last();
  await sendBtn.waitFor({ state: 'visible', timeout: 5000 });
  for (let i = 0; i < 20 && (await sendBtn.isDisabled()); i++) await sleep(150);
  await robustClick(page, sendBtn);

  // Success = the dialog goes away. A surviving dialog mentioning a limit means
  // LinkedIn blocked it (weekly invite cap) — surface that loudly.
  try {
    await dialog.waitFor({ state: 'hidden', timeout: 8000 });
  } catch {
    const text = ((await dialog.textContent()) || '').toLowerCase();
    await page.keyboard.press('Escape');
    if (/limit|reached/.test(text)) throw new Error('weekly-invite-limit');
    throw new Error('dialog-did-not-close');
  }
  return 'invited';
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetsPath = path.resolve(__dirname, args.targets);
  const notePath = path.resolve(__dirname, args.note);
  const logPath = path.resolve(__dirname, 'invite-log.json');
  const shotsDir = path.resolve(__dirname, 'screenshots');
  const userDataDir = path.resolve(__dirname, 'user-data');
  fs.mkdirSync(shotsDir, { recursive: true });

  if (!fs.existsSync(targetsPath)) {
    console.error(`\nNo targets file at ${targetsPath}.\n`);
    process.exit(1);
  }
  const noteTemplate = fs.readFileSync(notePath, 'utf8').trim();
  const allTargets = parseCsv(fs.readFileSync(targetsPath, 'utf8'));
  const inviteLog = loadJson(logPath, {}); // url -> { status, reason?, date, time, note? }

  if (allTargets.length === 0) {
    console.error('Targets file has no data rows.');
    process.exit(1);
  }

  // Validate every rendered note against the hard 300-char limit up front.
  for (const t of allTargets) {
    const n = render(noteTemplate, t);
    if (n.length > NOTE_LIMIT) {
      console.error(`Note for ${t.firstName || t.url} is ${n.length} chars (limit ${NOTE_LIMIT}). Shorten the template.`);
      process.exit(1);
    }
  }

  const pending = allTargets.filter((t) => {
    const key = (t.url || '').trim();
    if (!key) return false;
    return inviteLog[key]?.status !== 'invited';
  });

  const tally = computeTally(inviteLog);
  console.log('\n────────────────────────────────────────────────────────');
  console.log(`  Mode:     ${args.send ? 'SEND (invites will go out)' : 'DRY RUN (nothing sent)'}`);
  console.log(`  Targets:  ${allTargets.length} total, ${pending.length} not yet invited`);
  console.log(`  Pacing:   ${args.min}-${args.max}s between profiles`);
  console.log(`  ${renderConsole(tally)}`);
  console.log('────────────────────────────────────────────────────────\n');

  if (pending.length === 0) {
    console.log('Nothing to do — everyone already invited.');
    return;
  }

  // Rate guardrail: only when actually sending. Refuse to blow past your
  // self-imposed daily/weekly caps unless --force is given. This is the
  // "don't let me (or Claude) over-send" backstop the tally is for.
  if (args.send) {
    const projDay = tally.today + pending.length;
    const projWeek = tally.rolling7 + pending.length;
    const overDay = projDay > CAPS.daily;
    const overWeek = projWeek > CAPS.weekly;
    if ((overDay || overWeek) && !args.force) {
      console.log('⛔ Rate guardrail tripped — this run would exceed your caps:');
      if (overDay) console.log(`   • Today: ${tally.today} + ${pending.length} = ${projDay} (cap ${CAPS.daily})`);
      if (overWeek) console.log(`   • Rolling 7-day: ${tally.rolling7} + ${pending.length} = ${projWeek} (cap ${CAPS.weekly})`);
      console.log('   Send fewer (split the targets file), wait, or re-run with --force to override.');
      console.log('   Caps live in lib/tally.js.\n');
      return;
    }
    if (overDay || overWeek) console.log('⚠ Over a cap, but --force given — proceeding.\n');
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });
  const page = context.pages()[0] || (await context.newPage());

  let interrupted = false;
  process.on('SIGINT', () => {
    interrupted = true;
    console.log('\nInterrupted — saving progress and exiting...');
  });

  const results = { invited: 0, skipped: 0, failed: 0 };

  try {
    await ensureLoggedIn(page);

    for (let i = 0; i < pending.length; i++) {
      if (interrupted) break;
      const t = pending[i];
      const url = t.url.trim();
      const note = render(noteTemplate, t);
      const label = t.firstName || url;

      console.log(`\n── (${i + 1}/${pending.length}) ${label} ──`);
      console.log(url);
      console.log(`  note (${note.length}/${NOTE_LIMIT}): ${note}`);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(rand(1500, 3000));

        const st = await profileState(page);
        if (st.state === 'connected') {
          console.log('  ⏭  Already a 1st-degree connection — use messenger.js for these. Skipping.');
          inviteLog[url] = { status: 'skipped', reason: 'already-connected', date: today(), time: new Date().toISOString() };
          results.skipped++;
        } else if (st.state === 'pending') {
          console.log('  ⏭  Invite already pending. Skipping.');
          inviteLog[url] = { status: 'skipped', reason: 'invite-pending', date: today(), time: new Date().toISOString() };
          results.skipped++;
        } else if (st.state === 'no-connect-button') {
          console.log('  ⚠ No Connect button found. Skipping.');
          inviteLog[url] = { status: 'skipped', reason: 'no-connect-button', date: today(), time: new Date().toISOString() };
          results.skipped++;
        } else {
          // FAIL-CLOSED identity guard: the Connect control's accessible name
          // must name the intended person before we ever click it. This is the
          // structural defense against the 2026-06-15 instant-send-to-stranger
          // incident — a suggestion card / wrong profile won't match the row's name.
          const expected = (t.name || '').trim();
          if (expected && !nameMatches(st.label, expected)) {
            console.log(`  ⛔ Name mismatch — Connect control says "${st.label}" but target is "${expected}". NOT clicking. Skipping.`);
            try {
              await page.screenshot({ path: path.join(shotsDir, `${Date.now()}-mismatch-${expected.replace(/[^\w]+/g, '_').slice(0, 30)}.png`) });
            } catch {
              /* ignore */
            }
            inviteLog[url] = { status: 'skipped', reason: `name-mismatch: control="${st.label}" expected="${expected}"`, date: today(), time: new Date().toISOString() };
            results.skipped++;
          } else {
            if (!expected) console.log('  ⚠ No "name" column — identity guard inactive for this row (add a name column to enable it).');
            else console.log(`  ✓ Identity OK — control "${st.label}" matches "${expected}".`);
            await robustClick(page, st.button);
            const outcome = await inviteWithNote(page, note, args.send);
            if (outcome === 'invited') {
              console.log('  ✓ Invitation sent with note.');
              inviteLog[url] = { status: 'invited', date: today(), time: new Date().toISOString(), note };
              results.invited++;
            } else {
              console.log('  ✓ Preview OK (note attached, then discarded — not sent).');
              results.skipped++;
            }
          }
        }
        saveJson(logPath, inviteLog);
      } catch (err) {
        results.failed++;
        const shot = path.join(shotsDir, `${Date.now()}-${(label || 'err').replace(/[^\w]+/g, '_').slice(0, 40)}.png`);
        try {
          await page.screenshot({ path: shot, fullPage: false });
        } catch {
          /* ignore */
        }
        console.log(`  ✗ Failed: ${err.message}`);
        console.log(`    Screenshot: ${shot}`);
        inviteLog[url] = { status: 'failed', reason: err.message, date: today(), time: new Date().toISOString() };
        saveJson(logPath, inviteLog);
        if (err.message === 'weekly-invite-limit') {
          console.log('\nLinkedIn says the invite limit is reached — stopping the run.');
          break;
        }
      }

      if (i < pending.length - 1 && !interrupted) {
        const wait = rand(args.min * 1000, args.max * 1000);
        await sleep(wait);
      }
    }
  } finally {
    saveJson(logPath, inviteLog);
    const mdPath = path.resolve(__dirname, 'OUTREACH-LOG.md');
    let after = null;
    try {
      after = writeOutreachLog(logPath, mdPath);
    } catch {
      /* tally is best-effort */
    }
    console.log('\n════════════════ summary ════════════════');
    console.log(`  Invited: ${results.invited}`);
    console.log(`  Skipped: ${results.skipped}`);
    console.log(`  Failed:  ${results.failed}`);
    console.log(`  Log:     ${logPath}`);
    if (after) console.log(`  Tally:   today ${after.today}/${CAPS.daily}, 7-day ${after.rolling7}/${CAPS.weekly}  → ${mdPath}`);
    console.log('═════════════════════════════════════════\n');
    await sleep(1000);
    await context.close();
  }
}

main().catch((e) => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
