// READ-ONLY recon. Visits each profile URL in the shared logged-in browser,
// reads the name / headline / current-company / relationship state, and writes
// recon.json. It NEVER calls .click() and NEVER sends anything — this is the
// "inspect read-only first" step from CLAUDE.md rule 3, and it doubles as the
// "verify LinkedIn is working" check (login valid, profiles load, selectors hit).
//
// Usage: node recon-readonly.js --urls urls.txt   (one profile URL per line)
//
// Guarantees (grep this file): there is exactly ZERO occurrence of ".click(" and
// no Send/Invite/Connect button is ever pressed. Pure navigation + text reads.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

function parseArgs(argv) {
  const args = { urls: 'urls.txt' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--urls') args.urls = argv[++i];
  }
  return args;
}

async function ensureLoggedIn(page) {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  const isLoggedIn = async () => {
    const cookies = await page.context().cookies('https://www.linkedin.com');
    if (cookies.some((c) => c.name === 'li_at' && c.value)) return true;
    if (/\/(login|signup|authwall)/.test(page.url())) return false;
    return (await page.locator('#global-nav, nav.global-nav, img.global-nav__me-photo').count()) > 0;
  };
  if (await isLoggedIn()) return true;
  console.log('\nPlease log in to LinkedIn in the browser window. Waiting up to 5 minutes...\n');
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await isLoggedIn()) return true;
    await sleep(2000);
  }
  throw new Error('Timed out waiting for login (5 min).');
}

// All reads below are passive: textContent / count only. No clicks.
async function readProfile(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(rand(1800, 3200));
  // Wait for the top card to hydrate (same gate connect.js uses, read-only).
  try {
    await page.locator('main h1:visible').first().waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    /* fall through; we'll report what we can */
  }

  const text = async (loc) => {
    try {
      const n = await page.locator(loc).count();
      if (!n) return '';
      return ((await page.locator(loc).first().textContent()) || '').replace(/\s+/g, ' ').trim();
    } catch {
      return '';
    }
  };
  const count = async (loc) => {
    try {
      return await page.locator(loc).count();
    } catch {
      return 0;
    }
  };

  // Most reliable name source: the page <title>, e.g. "(3) Jane Doe | LinkedIn"
  // or "Jane Doe - Software Engineer at Stripe | LinkedIn". Independent of render.
  const pageTitle = (await page.title().catch(() => '')) || '';
  let name = await text('main h1');
  if (!name) {
    // strip leading "(N) " notification count and trailing " | LinkedIn" / " - headline"
    name = pageTitle.replace(/^\(\d+\)\s*/, '').replace(/\s*\|\s*LinkedIn.*$/i, '').split(' - ')[0].trim();
  }
  const headline = await text('main h1 ~ div .text-body-medium, main .text-body-medium.break-words, main h2');
  // Whole intro/top card innerText — contains name, headline, location, current
  // company & school. Best-effort, read-only, so we can eyeball employer.
  let topCardText = '';
  try {
    const sec = page.locator('main section').first();
    if (await sec.count()) topCardText = ((await sec.innerText()) || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  } catch {
    /* ignore */
  }
  const topCompany = await text('main a[aria-label^="Current company" i], main a[href*="/company/"]');

  // Relationship state — READ ONLY, mirrors connect.js profileState() detection
  // but without ever opening the "More" overflow (no clicks).
  const dist = await text('main .dist-value:visible, main .distance-badge:visible');
  const connectAnchor = await count('main a[aria-label^="Invite" i][aria-label*="to connect" i]:visible');
  const pendingAnchor = await count('main a[aria-label^="Pending" i]:visible');
  const messageAnchor = await count('main a[aria-label^="Message" i]:visible:not([aria-label*="connect" i])');
  // If a Connect <button> (not anchor) exists in main that's the danger pattern; flag it.
  const connectButtonDanger = await count('main button[aria-label^="Invite" i][aria-label*="to connect" i]:visible');

  let rel = 'unknown';
  if (connectAnchor > 0) rel = 'connectable (own Connect anchor present)';
  else if (pendingAnchor > 0) rel = 'pending (invite already out)';
  else if (messageAnchor > 0) rel = 'likely-1st-degree (Message, no Connect) — use messenger.js';
  else rel = 'no-direct-connect (maybe under More overflow / follow-primary)';

  return {
    url,
    name,
    firstName: name ? name.split(/\s+/)[0] : '',
    pageTitle,
    headline,
    topCompany,
    topCardText,
    distanceBadge: dist,
    relationship: rel,
    counts: { connectAnchor, pendingAnchor, messageAnchor, connectButtonDanger },
    finalUrl: page.url(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const urlsPath = path.resolve(__dirname, args.urls);
  if (!fs.existsSync(urlsPath)) {
    console.error(`No urls file at ${urlsPath}`);
    process.exit(1);
  }
  const urls = fs
    .readFileSync(urlsPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l.startsWith('http'));

  const userDataDir = path.resolve(__dirname, 'user-data');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });
  const page = context.pages()[0] || (await context.newPage());

  const out = [];
  try {
    await ensureLoggedIn(page);
    console.log(`\nLogged in OK. Reading ${urls.length} profiles (READ-ONLY, no clicks)...\n`);
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      process.stdout.write(`(${i + 1}/${urls.length}) ${url}\n`);
      try {
        const info = await readProfile(page, url);
        out.push(info);
        console.log(
          `    name="${info.name}" | ${info.relationship}` +
            (info.counts.connectButtonDanger ? `  ⚠ CONNECT-BUTTON(danger)=${info.counts.connectButtonDanger}` : '')
        );
        console.log(`    title="${info.pageTitle}"`);
        console.log(`    topcard="${info.topCardText}"`);
      } catch (err) {
        console.log(`    ✗ read failed: ${err.message}`);
        out.push({ url, error: err.message });
      }
      await sleep(rand(1500, 3000));
    }
  } finally {
    fs.writeFileSync(path.resolve(__dirname, 'recon.json'), JSON.stringify(out, null, 2));
    console.log(`\nWrote recon.json (${out.length} rows). No invites sent — read-only run.\n`);
    await sleep(500);
    await context.close();
  }
}

main().catch((e) => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
