// LinkedIn message helper — low volume, human-paced, you-stay-in-control.
//
// Design goals (these exist to protect your account, not to slow you down):
//   * You log in MANUALLY in a real, visible browser. The script never sees
//     your password. The session is saved to ./user-data so you log in once.
//   * Randomized, human-like pacing between sends and while typing.
//   * A hard daily cap and a persistent sent-log so nobody is ever
//     double-messaged and the cap is never exceeded.
//   * Backstop: when the composer opens it checks for an EXISTING conversation
//     and skips anyone you've already messaged (even outside this tool). Any
//     uncertainty => skip, not send.
//   * Dry-run by default: it opens the compose box and types the message so
//     you can SEE it, then clears it and closes WITHOUT sending. Pass --send
//     to actually send.
//
// Usage:
//   node messenger.js                 # dry run / preview (no messages sent)
//   node messenger.js --send          # actually send
//   node messenger.js --cap 12        # change the daily cap (default 15)
//   node messenger.js --min 45 --max 120   # delay bounds between sends (sec)
//   node messenger.js --targets my.csv --template my.txt
//   node messenger.js --no-history-check   # disable the prior-conversation skip
//                                          # (use only if LinkedIn DOM changes
//                                          # and it skips everyone)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { parseCsv } from './lib/csv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

// ---------- args ----------
function parseArgs(argv) {
  const args = { send: false, cap: 15, min: 45, max: 120, targets: 'targets.csv', template: 'template.txt', historyCheck: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--send') args.send = true;
    else if (a === '--no-history-check') args.historyCheck = false;
    else if (a === '--cap') args.cap = Number(argv[++i]);
    else if (a === '--min') args.min = Number(argv[++i]);
    else if (a === '--max') args.max = Number(argv[++i]);
    else if (a === '--targets') args.targets = argv[++i];
    else if (a === '--template') args.template = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('See the comment block at the top of messenger.js for usage.');
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

function log(...a) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...a);
}

function render(template, row) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    if (!(key in row)) {
      throw new Error(`Template uses {{${key}}} but the CSV has no "${key}" column`);
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

// ---------- LinkedIn interaction ----------
async function ensureLoggedIn(page) {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  const isLoggedIn = async () => {
    // The li_at auth cookie is the definitive signal — far more reliable than a
    // DOM selector, and it survives security-check redirects.
    const cookies = await page.context().cookies('https://www.linkedin.com');
    if (cookies.some((c) => c.name === 'li_at' && c.value)) return true;
    if (/\/(login|signup|authwall)/.test(page.url())) return false;
    return (await page.locator('#global-nav, nav.global-nav, img.global-nav__me-photo').count()) > 0;
  };
  if (await isLoggedIn()) return;

  console.log('\n  ┌──────────────────────────────────────────────────────────┐');
  console.log('  │  Please log in to LinkedIn in the browser window.        │');
  console.log('  │  Solve any CAPTCHA / 2FA. I will wait and never touch    │');
  console.log('  │  your credentials. The session is saved for next time.   │');
  console.log('  └──────────────────────────────────────────────────────────┘\n');

  const deadline = Date.now() + 5 * 60 * 1000; // 5 minutes to log in
  while (Date.now() < deadline) {
    if (await isLoggedIn()) {
      log('Logged in. Continuing.');
      await sleep(1500);
      return;
    }
    await sleep(2000);
  }
  throw new Error('Timed out waiting for login (5 min).');
}

async function openComposer(page) {
  // The profile "Message" affordance is now an <a> linking to /messaging/compose/
  // (a stray overlay intercepts clicks), so read its href and navigate there.
  // Accessible name "Message" exactly avoids the "Message <Name>" sidebar links.
  let href = null;
  const msgLink = page.getByRole('link', { name: 'Message', exact: true }).first();
  if ((await msgLink.count()) > 0) href = await msgLink.getAttribute('href');
  if (!href) {
    const alt = page.locator('a[href*="/messaging/compose/"]').first(); // profile's own is first in DOM
    if ((await alt.count()) > 0) href = await alt.getAttribute('href');
  }
  if (!href) return null; // no message affordance (not 1st-degree / messaging off)

  await page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  const box = page.locator('div.msg-form__contenteditable[contenteditable="true"], [role="textbox"][contenteditable="true"]').last();
  try {
    await box.waitFor({ state: 'visible', timeout: 12000 });
  } catch {
    return null;
  }
  return box;
}

// Backstop against double-messaging: when the composer opens, detect whether a
// prior conversation already exists. Returns 'history' | 'empty' | 'inconclusive'.
// Conservative by design — anything uncertain returns 'inconclusive' so the
// caller SKIPS (a missed send is cheap; a duplicate referral ask is the harm).
async function checkHistory(page) {
  // openComposer navigated to the full messaging page. A FRESH conversation has
  // no message-list container and 0 bubbles; an EXISTING thread renders prior
  // bubbles within a few seconds. Count p.msg-s-event-listitem__body directly —
  // do NOT require the list container (it's absent for fresh composes, which
  // would otherwise make us wrongly skip everyone). The "you're now connected"
  // system card has no __body, so it isn't counted.
  const countBodies = () =>
    page.evaluate(() => {
      let n = 0;
      document.querySelectorAll('p.msg-s-event-listitem__body').forEach((b) => {
        const t = (b.textContent || '').trim().toLowerCase();
        if (!t) return;
        if (/now connected|accepted your (invitation|connection)|you're connected/.test(t)) return;
        n += 1;
      });
      return n;
    });
  // Give any thread that DOES exist time to load: wait out spinners first.
  const spinnerDeadline = Date.now() + 8000;
  while (Date.now() < spinnerDeadline) {
    const busy = await page
      .locator('.artdeco-spinner, .msg-s-message-list__loading-indicator, .msg-s-event-listitem--loading, [aria-busy="true"]')
      .count();
    if (busy === 0) break;
    await sleep(300);
  }
  // Poll a short settle window: any bubble => history; stays at 0 => fresh/empty.
  for (let i = 0; i < 10; i++) {
    let c;
    try {
      c = await countBodies();
    } catch {
      return 'inconclusive';
    }
    if (c >= 1) return 'history';
    await sleep(300);
  }
  return 'empty';
}

async function typeMessage(page, box, message) {
  await box.click();
  await sleep(rand(300, 900));
  // Clear any restored draft so we never concatenate or send leftover text.
  await page.keyboard.press(`${MOD}+A`);
  await page.keyboard.press('Backspace');
  const lines = message.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.keyboard.press('Shift+Enter'); // newline, never send
    // pressSequentially types char-by-char with a human-ish delay.
    await box.pressSequentially(lines[i], { delay: rand(20, 45), timeout: 60000 });
  }
}

async function clearBox(page, box) {
  await box.click();
  await page.keyboard.press(`${MOD}+A`);
  await page.keyboard.press('Backspace');
}

async function clickSend(page) {
  const send = page.getByRole('button', { name: /^Send$/i }).last();
  await send.waitFor({ state: 'visible', timeout: 5000 });
  // Wait until it's actually enabled (LinkedIn disables it until text exists).
  for (let i = 0; i < 20 && (await send.isDisabled()); i++) await sleep(150);
  await send.click();
}

async function closeComposer(page) {
  const close = page.locator(
    'button[aria-label^="Close your conversation"], button[aria-label*="Close conversation"], button.msg-overlay-bubble-header__control[aria-label*="Close"]'
  );
  if ((await close.count()) > 0) {
    try {
      await close.first().click();
    } catch {
      /* ignore */
    }
  }
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetsPath = path.resolve(__dirname, args.targets);
  const templatePath = path.resolve(__dirname, args.template);
  const logPath = path.resolve(__dirname, 'sent-log.json');
  const shotsDir = path.resolve(__dirname, 'screenshots');
  const userDataDir = path.resolve(__dirname, 'user-data');
  fs.mkdirSync(shotsDir, { recursive: true });

  if (!fs.existsSync(targetsPath)) {
    console.error(`\nNo targets file at ${targetsPath}.\nCopy targets.example.csv to targets.csv and fill it in.\n`);
    process.exit(1);
  }
  if (!fs.existsSync(templatePath)) {
    console.error(`\nNo template at ${templatePath}.\n`);
    process.exit(1);
  }

  const template = fs.readFileSync(templatePath, 'utf8').trim();
  const allTargets = parseCsv(fs.readFileSync(targetsPath, 'utf8'));
  const sentLog = loadJson(logPath, {}); // url -> { status, date, time, message }

  // Validate the template against the first row up front (fail fast).
  if (allTargets.length === 0) {
    console.error('targets.csv has no data rows.');
    process.exit(1);
  }
  render(template, allTargets[0]);

  // Skip anyone already messaged successfully.
  const pending = allTargets.filter((t) => {
    const key = (t.url || '').trim();
    if (!key) return false;
    return sentLog[key]?.status !== 'sent';
  });

  // Enforce the daily cap.
  const sentToday = Object.values(sentLog).filter((e) => e.status === 'sent' && e.date === today()).length;
  const remaining = Math.max(0, args.cap - sentToday);
  const batch = pending.slice(0, remaining);

  console.log('\n────────────────────────────────────────────────────────');
  console.log(`  Mode:        ${args.send ? 'SEND (messages will be sent)' : 'DRY RUN (nothing sent)'}`);
  console.log(`  Targets:     ${allTargets.length} total, ${pending.length} not yet messaged`);
  console.log(`  Daily cap:   ${args.cap}  (already sent today: ${sentToday})`);
  console.log(`  This run:    ${batch.length} message(s)`);
  console.log(`  Pacing:      ${args.min}-${args.max}s between messages`);
  console.log('────────────────────────────────────────────────────────\n');

  if (batch.length === 0) {
    console.log('Nothing to do. (Cap reached, or everyone already messaged.)');
    return;
  }
  if (!args.send) {
    console.log('This is a DRY RUN. Review the previews below, then re-run with --send.\n');
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });
  const page = context.pages()[0] || (await context.newPage());

  // Persist progress on Ctrl+C.
  let interrupted = false;
  process.on('SIGINT', () => {
    interrupted = true;
    console.log('\nInterrupted — saving progress and exiting...');
  });

  const results = { sent: 0, skipped: 0, failed: 0 };

  try {
    await ensureLoggedIn(page);

    for (let i = 0; i < batch.length; i++) {
      if (interrupted) break;
      const t = batch[i];
      const url = t.url.trim();
      const message = render(template, t);
      const label = t.firstName || t.name || url;

      console.log(`\n── (${i + 1}/${batch.length}) ${label} ──`);
      console.log(url);
      console.log('  ┌─ message ' + '─'.repeat(40));
      message.split('\n').forEach((l) => console.log('  │ ' + l));
      console.log('  └' + '─'.repeat(50));

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(rand(2000, 4500)); // let the profile settle

        const box = await openComposer(page);
        if (!box) {
          console.log('  ⚠ No message box (likely not a 1st-degree connection, or messaging is off). Skipping.');
          sentLog[url] = { status: 'skipped', reason: 'no-compose', date: today(), time: new Date().toISOString() };
          results.skipped++;
          saveJson(logPath, sentLog);
          continue;
        }

        // Backstop: never message someone you already have a thread with.
        if (args.historyCheck) {
          const hist = await checkHistory(page);
          if (hist === 'history' || hist === 'inconclusive') {
            const reason = hist === 'history' ? 'prior-history' : 'history-check-inconclusive';
            console.log(
              hist === 'history'
                ? '  ⏭  Prior conversation exists — skipping so you don\'t double-message.'
                : "  ⏭  Couldn't confirm the thread is empty — skipping to be safe (logged 'history-check-inconclusive')."
            );
            sentLog[url] = { status: 'skipped', reason, date: today(), time: new Date().toISOString() };
            results.skipped++;
            await closeComposer(page);
            saveJson(logPath, sentLog);
            continue;
          }
        }

        await typeMessage(page, box, message);
        await sleep(rand(600, 1500));

        if (args.send) {
          await clickSend(page);
          await sleep(rand(1200, 2500));
          console.log('  ✓ Sent.');
          sentLog[url] = { status: 'sent', date: today(), time: new Date().toISOString(), message };
          results.sent++;
        } else {
          await clearBox(page, box); // leave no draft behind in dry run
          console.log('  ✓ Preview OK (composer opened, message typed & cleared, not sent).');
          results.skipped++;
        }
        await closeComposer(page);
        saveJson(logPath, sentLog);
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
        sentLog[url] = { status: 'failed', reason: err.message, date: today(), time: new Date().toISOString() };
        saveJson(logPath, sentLog);
      }

      // Human-like pause before the next person (skip after the last one).
      if (i < batch.length - 1 && !interrupted) {
        const wait = rand(args.min * 1000, args.max * 1000);
        log(`Waiting ${Math.round(wait / 1000)}s before the next message...`);
        await sleep(wait);
      }
    }
  } finally {
    saveJson(logPath, sentLog);
    console.log('\n════════════════ summary ════════════════');
    console.log(`  Sent:    ${results.sent}`);
    console.log(`  Skipped: ${results.skipped}`);
    console.log(`  Failed:  ${results.failed}`);
    console.log(`  Log:     ${logPath}`);
    console.log('═════════════════════════════════════════\n');
    await sleep(1500);
    await context.close();
  }
}

main().catch((e) => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
