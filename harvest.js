// PHASE 1: build the list. Logs into LinkedIn (you, manually), reads your
// My Network → Connections page, and collects everyone you connected with on or
// after a cutoff date. Writes a reviewable targets.csv and prints a table.
// SENDS NOTHING. Review the list, trim it, then run messenger.js to send.
//
// Usage:
//   node harvest.js                       # cutoff defaults to 2026-05-24
//   node harvest.js --since 2026-05-24
//   node harvest.js --max-iter 60         # scroll-iteration safety cap
//   node harvest.js --out targets.csv

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  parseCaption, parseSince, toYMD, shiftDays, keepCard, isOlderThan, sortKeyOf, labelOf,
  firstNameOf, extractCompany,
} from './lib/dates.js';
import { normName, ownerKeySet } from './lib/names.js';

const MESSAGING_URL = 'https://www.linkedin.com/messaging/';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

function parseArgs(argv) {
  const a = { since: '2026-05-24', maxIter: 60, out: 'targets.csv', marginDays: 2 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--since') a.since = argv[++i];
    else if (argv[i] === '--max-iter') a.maxIter = Number(argv[++i]);
    else if (argv[i] === '--out') a.out = argv[++i];
  }
  return a;
}

// --- profile-URL helpers (dedup must collapse encoded/tracking variants) ---
const rawSlug = (url) => {
  const m = String(url || '').match(/\/in\/([^/?#]+)/);
  return m ? m[1] : null;
};
const dedupKey = (url) => {
  const r = rawSlug(url);
  if (!r) return null;
  try {
    return decodeURIComponent(r).toLowerCase();
  } catch {
    return r.toLowerCase();
  }
};
const cleanUrl = (url) => {
  const r = rawSlug(url);
  return r ? `https://www.linkedin.com/in/${r}/` : url;
};

function csvEscape(v) {
  const s = (v ?? '').toString();
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows, cols) {
  return cols.join(',') + '\n' + rows.map((r) => cols.map((c) => csvEscape(r[c])).join(',')).join('\n') + '\n';
}
function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// --- message inbox: find who you already have a conversation with ---
// NOTE: inbox conversation rows do NOT expose profile /in/ slugs, so this is a
// NAME-based, best-effort signal (used only to FLAG, never as the sole truth).

async function liveDisplayName(page) {
  try {
    return await page.evaluate(() => {
      const img = document.querySelector('img.global-nav__me-photo, .global-nav__me-photo');
      return img?.getAttribute('alt') || '';
    });
  } catch {
    return '';
  }
}

// One snapshot of the currently-rendered conversation rows (virtualized list).
async function extractInboxRows(page) {
  return page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const out = [];
    const lis = document.querySelectorAll(
      "li.msg-conversation-listitem, li.msg-conversation-card, [aria-label='Conversation list'] li"
    );
    lis.forEach((li) => {
      const link = li.querySelector("a[href*='/messaging/thread/']");
      const href = link?.getAttribute('href') || '';
      const tid = (href.match(/thread\/([^/?#]+)/) || [])[1] || null;
      const nameEl = li.querySelector(
        ".msg-conversation-listitem__participant-names .truncate, .msg-conversation-card__participant-names .truncate, h3.msg-conversation-listitem__participant-names"
      );
      const name = norm(nameEl?.textContent);
      const facepile = li.querySelector('.msg-facepile');
      const thumbs = li.querySelectorAll(
        ".msg-conversation-listitem__participant-thumbnail, .msg-facepile img, .presence-entity"
      );
      const sponsored = /sponsored|promoted/i.test(norm(li.textContent).slice(0, 60));
      const isGroup = !!facepile || thumbs.length > 1;
      if (!tid && !name) return;
      out.push({ threadId: tid, name, isGroup, sponsored });
    });
    return out;
  });
}

// Scroll the INNER conversation list viewport (not the window). Returns whether it moved.
async function scrollInbox(page) {
  return page.evaluate(() => {
    let el = document.querySelector('.msg-conversations-container__conversations-list');
    while (el && !(el.scrollHeight > el.clientHeight + 5 && /auto|scroll/.test(getComputedStyle(el).overflowY))) {
      el = el.parentElement;
    }
    if (!el) {
      window.scrollTo(0, document.body.scrollHeight);
      return false;
    }
    const before = el.scrollTop;
    el.scrollTop = el.scrollHeight;
    return el.scrollTop > before + 1;
  });
}

async function selectInboxTab(page, label) {
  try {
    const tab = page.getByRole('tab', { name: new RegExp(label, 'i') }).first();
    if (await tab.count()) {
      await tab.click();
      await sleep(rand(1200, 2200));
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

// Bounded scroll-harvest of one tab; accumulate rows by thread-id (rows recycle).
async function scanInboxTab(page, maxScrolls, acc) {
  let noGrowth = 0;
  for (let i = 0; i < maxScrolls; i++) {
    const rows = await extractInboxRows(page);
    let added = 0;
    for (const r of rows) {
      if (!r.name) continue; // skip skeleton rows until the name hydrates
      const key = r.threadId || `name:${r.name}`;
      if (!acc.has(key)) {
        acc.set(key, r);
        added += 1;
      }
    }
    const moved = await scrollInbox(page);
    if (added === 0) {
      noGrowth += 1;
      if (noGrowth >= 2) break;
    } else {
      noGrowth = 0;
    }
    if (!moved && added === 0) break;
    await sleep(rand(700, 1300));
  }
}

// Scan Focused + Other tabs; return a Set of normalized 1:1 participant names.
async function scrapeMessagedNames(page, ownerKeys) {
  await page.goto(MESSAGING_URL, { waitUntil: 'domcontentloaded' });
  await sleep(rand(2500, 4000));
  const acc = new Map();
  const MAX_SCROLLS = 10;
  await selectInboxTab(page, 'Focused'); // default, but make it explicit
  await scanInboxTab(page, MAX_SCROLLS, acc);
  if (await selectInboxTab(page, 'Other')) {
    await scanInboxTab(page, MAX_SCROLLS, acc); // tab switch re-virtualizes; fresh scan
  }
  const names = new Set();
  const display = new Map();
  for (const r of acc.values()) {
    if (r.isGroup || r.sponsored || !r.name) continue;
    const nk = normName(r.name);
    if (!nk || ownerKeys.has(nk)) continue;
    names.add(nk);
    if (!display.has(nk)) display.set(nk, r.name);
  }
  return { names, display };
}

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
  console.log('\n  Log in to LinkedIn in the browser window (incl. 2FA/CAPTCHA).');
  console.log('  I will wait, never touch your credentials, and save the session.\n');
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await isLoggedIn()) {
      log('Logged in.');
      await sleep(1500);
      return;
    }
    await sleep(2000);
  }
  throw new Error('Timed out waiting for login (5 min).');
}

// Best-effort: confirm the list is sorted newest-first. If we can't confirm it,
// we DON'T trust chronological early-stop and rely on scroll-exhaustion instead.
async function recentSortActive(page) {
  try {
    const c = await page.getByText(/Recently added/i).count();
    return c > 0;
  } catch {
    return false;
  }
}

async function isChallenge(page) {
  return /checkpoint|challenge|authwall/.test(page.url());
}

// Pull every currently-rendered connection card, in DOM order. LinkedIn's 2026
// connections page uses hashed class names and no <li>, so we anchor on the
// stable "Connected on <date>" caption: each marks one card, and we climb to the
// smallest ancestor holding the profile link + avatar to read name/headline.
async function extractCards(page) {
  return page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const dateEls = [...document.querySelectorAll('p, span, div')].filter(
      (el) => el.children.length === 0 && /^connected\b/i.test((el.textContent || '').trim())
    );
    const out = [];
    const seen = new Set();
    for (const dEl of dateEls) {
      let card = dEl.parentElement;
      while (card) {
        if (card.querySelectorAll("a[href*='/in/']").length > 4) {
          card = null; // climbed into the whole list — abandon this one
          break;
        }
        if (card.querySelector("a[href*='/in/']") && card.querySelector('img')) break;
        card = card.parentElement;
      }
      if (!card) continue;
      const link = card.querySelector("a[href*='/in/']");
      const url = link?.href;
      if (!url) continue;
      const slug = (url.match(/\/in\/([^/?#]+)/) || [])[1];
      if (slug && seen.has(slug)) continue;
      if (slug) seen.add(slug);
      const rawAlt = [...card.querySelectorAll('img')].map((im) => norm(im.getAttribute('alt'))).find(Boolean) || '';
      // LinkedIn avatar alt is "<Name>'s profile picture" — or "<Name>' ..." for
      // names ending in s. Drop the " profile picture/photo" tail (glyph-agnostic),
      // then any trailing possessive apostrophe across apostrophe variants.
      const imgAlt = rawAlt
        .replace(/\s+profile\s+(?:picture|photo)\s*$/i, '')
        .replace(/['‘’ʼʹ`´]s?$/i, '')
        .trim();
      const anchors = [...card.querySelectorAll("a[href*='/in/']")];
      const full = norm(anchors.map((a) => a.innerText).find((t) => norm(t)) || '');
      let name = imgAlt || full;
      let headline = full;
      if (name && full.toLowerCase().startsWith(name.toLowerCase())) headline = norm(full.slice(name.length));
      else if (!imgAlt) headline = '';
      out.push({ url, name, headline, datetime: null, dateText: norm(dEl.textContent) });
    }
    return out;
  });
}

async function scrollStep(page) {
  await page.evaluate(() => {
    const links = document.querySelectorAll("a[href*='/in/']");
    const last = links[links.length - 1];
    if (last) last.scrollIntoView({ block: 'end' });
    window.scrollTo(0, document.body.scrollHeight);
  });
  try {
    const b = page.getByRole('button', { name: /show more|load more|more results/i }).first();
    if ((await b.count()) && (await b.isVisible())) await b.click();
  } catch {
    /* ignore */
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cutoff = parseSince(args.since);
  const stopThresholdYMD = toYMD(...shiftDays(cutoff.parts, -args.marginDays));
  const now = new Date();
  const nowParts = [now.getFullYear(), now.getMonth() + 1, now.getDate()];
  const userDataDir = path.resolve(__dirname, 'user-data'); // shared with messenger.js
  const outPath = path.resolve(__dirname, args.out);
  const amPath = path.resolve(__dirname, 'already-messaged.csv');
  const logPath = path.resolve(__dirname, 'sent-log.json');

  console.log('\n────────────────────────────────────────────────────────');
  console.log(`  Harvesting connections made ON/AFTER ${args.since}`);
  console.log(`  (today is ${nowParts.join('-')}; nothing will be sent)`);
  console.log('────────────────────────────────────────────────────────');

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });
  const page = context.pages()[0] || (await context.newPage());

  const seen = new Map(); // dedupKey -> { url, name, headline, parsed }
  try {
    await ensureLoggedIn(page);
    await page.goto(CONNECTIONS_URL, { waitUntil: 'domcontentloaded' });
    await sleep(rand(2500, 4000));

    const allowChrono = await recentSortActive(page);
    log(allowChrono
      ? 'Sort confirmed "Recently added" — will stop early once past the cutoff.'
      : 'Could not confirm "Recently added" sort — scanning the full list to be safe. (Tip: set the page Sort to "Recently added" for a faster run.)');

    let noGrowth = 0;
    for (let iter = 1; iter <= args.maxIter; iter++) {
      if (await isChallenge(page)) {
        log('LinkedIn showed a security check — stopping the scan. Re-run later.');
        break;
      }
      const cards = await extractCards(page);
      let newCount = 0;
      for (const c of cards) {
        const key = dedupKey(c.url);
        if (!key || seen.has(key)) continue;
        seen.set(key, { ...c, parsed: parseCaption(c.dateText, c.datetime, nowParts) });
        newCount += 1;
      }

      // Chronological early-stop: only when sort is confirmed AND the oldest
      // loaded cards are confidently past the cutoff (2+ of the last 3).
      let stop = false;
      if (allowChrono) {
        const tail = cards.slice(-3).map((c) => seen.get(dedupKey(c.url))?.parsed).filter(Boolean);
        const older = tail.filter((p) => isOlderThan(p, stopThresholdYMD)).length;
        if (tail.length >= 2 && older >= 2) stop = true;
      }

      log(`scroll ${iter}: ${seen.size} unique connections (${newCount} new)`);
      if (stop) {
        log('Passed the cutoff date — stopping scroll.');
        break;
      }
      if (newCount === 0) {
        noGrowth += 1;
        if (noGrowth >= 3) {
          log('No new connections loading — reached the end of the list.');
          break;
        }
        await sleep(rand(3000, 5000)); // extended wait absorbs a slow lazy-load
      } else {
        noGrowth = 0;
      }
      await scrollStep(page);
      await sleep(rand(700, 1500));
    }
  } catch (err) {
    console.error('\nScan error:', err.message);
  }

  // --- find people already in a conversation, to split into a second table ---
  // Signal A (reliable): slug already in sent-log.json with status 'sent'.
  // Both sides are canonicalized via dedupKey() — sent-log keys are cleanUrl
  // form (raw case), so a naive string compare would silently miss them.
  const sentLog = loadJson(logPath, {});
  const sentSlugSet = new Set(
    Object.entries(sentLog)
      .filter(([, v]) => v?.status === 'sent')
      .map(([k]) => dedupKey(k))
      .filter(Boolean)
  );
  // Signal B (heuristic): name matches someone in your inbox. FLAG only.
  let inboxNames = new Set();
  let ownerKeys = ownerKeySet('Manay Lodha');
  try {
    log('Scanning your message inbox (Focused + Other) for people you already talk to...');
    ownerKeys = ownerKeySet('Manay Lodha', await liveDisplayName(page));
    const { names } = await scrapeMessagedNames(page, ownerKeys);
    inboxNames = names;
    log(`Inbox scan found ${inboxNames.size} distinct 1:1 conversation name(s).`);
  } catch (e) {
    log(`Inbox scan skipped (${e.message}). Relying on sent-log + the send-time history check.`);
  }

  // Classify every in-range connection into "new" vs "already messaged".
  const rowsOut = [...seen.values()]
    .filter((r) => keepCard(r.parsed, cutoff.ymd))
    .map((r) => {
      const k = dedupKey(r.url);
      const nk = normName(r.name);
      let bucket = 'new';
      let reason = '';
      if (k && sentSlugSet.has(k)) {
        bucket = 'messaged';
        reason = 'messaged by this tool';
      } else if (nk && !ownerKeys.has(nk) && inboxNames.has(nk)) {
        bucket = 'messaged';
        reason = 'name match in inbox (verify)';
      }
      return {
        url: cleanUrl(r.url),
        firstName: firstNameOf(r.name),
        name: r.name,
        company: extractCompany(r.headline) || 'your company',
        connected: labelOf(r.parsed),
        reason,
        headline: r.headline,
        approx: r.parsed.kind !== 'abs',
        bucket,
        _sort: sortKeyOf(r.parsed, cutoff.ymd),
      };
    })
    .sort((a, b) => b._sort - a._sort);

  const newOnes = rowsOut.filter((r) => r.bucket === 'new');
  const alreadyMessaged = rowsOut.filter((r) => r.bucket === 'messaged');

  fs.writeFileSync(outPath, toCsv(newOnes, ['url', 'firstName', 'company', 'connected', 'headline']));
  fs.writeFileSync(amPath, toCsv(alreadyMessaged, ['url', 'firstName', 'company', 'reason', 'connected']));

  const pad = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
  const printTable = (rows, extraCol) => {
    console.log('   #  ' + pad('Name', 22) + pad('Company', 20) + pad('Connected', 18) + (extraCol ? pad(extraCol, 26) : 'Profile'));
    console.log('  ' + '─'.repeat(extraCol ? 88 : 96));
    rows.forEach((r, i) => {
      const mark = r.approx ? '~' : ' ';
      console.log(
        `  ${String(i + 1).padStart(2)}${mark} ` +
          pad(r.name || r.firstName, 22) +
          pad(r.company, 20) +
          pad(r.connected, 18) +
          (extraCol ? pad(r.reason, 26) : r.url)
      );
    });
  };

  console.log(`\n  ✅ ${newOnes.length} NEW connection(s) to message (→ targets.csv):\n`);
  printTable(newOnes, null);

  console.log(`\n  ⏭  ${alreadyMessaged.length} already in your DMs — SKIPPED (→ already-messaged.csv):\n`);
  if (alreadyMessaged.length) printTable(alreadyMessaged, 'Why skipped');
  else console.log('     (none)');

  const approxN = newOnes.filter((r) => r.approx).length;
  const verifyN = alreadyMessaged.filter((r) => r.reason.includes('verify')).length;
  console.log('\n  ' + '─'.repeat(96));
  console.log(`  Wrote ${outPath} (${newOnes.length}) and ${amPath} (${alreadyMessaged.length})`);
  if (approxN) console.log(`  • ${approxN} new row(s) marked "~" have an approximate connect date — worth a glance.`);
  if (verifyN) console.log(`  • ${verifyN} skipped row(s) are "(verify)" NAME matches — could be a different person with the same name. If so, move them from already-messaged.csv into targets.csv.`);
  console.log('\n  Next:');
  console.log("   1. Review targets.csv — delete anyone you don't want; fix any odd names/companies.");
  console.log('   2. Preview:  node messenger.js --template referral-template.txt');
  console.log(`   3. Send:     node messenger.js --template referral-template.txt --send --cap ${Math.max(15, newOnes.length)}`);
  console.log('   (messenger.js also re-checks each thread at send time and skips anyone with prior messages — a backstop in case a name match was missed.)');
  if (newOnes.length > 20) {
    console.log(`\n  Heads up: ${newOnes.length} is a lot of referral asks in one go. Consider splitting across 2 days to stay under LinkedIn's radar.`);
  }

  await sleep(1200);
  await context.close();
}

main().catch((e) => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
