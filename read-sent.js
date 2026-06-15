// READ-ONLY reader for the Sent-invitations page (ground truth per CLAUDE.md
// rule 4). Lists who currently has a PENDING invite from you, by name + profile
// slug, so we can confirm exactly the intended people went out and NO strangers.
//
// It NEVER clicks anything — in particular it never clicks "Withdraw". Pure read.
// Usage: node read-sent.js

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureLoggedIn(page) {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  const cookies = await page.context().cookies('https://www.linkedin.com');
  if (!cookies.some((c) => c.name === 'li_at' && c.value)) {
    console.log('Not logged in — please log in within 5 min...');
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      const c = await page.context().cookies('https://www.linkedin.com');
      if (c.some((x) => x.name === 'li_at' && x.value)) break;
      await sleep(2000);
    }
  }
}

async function main() {
  const userDataDir = path.resolve(__dirname, 'user-data');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });
  const page = context.pages()[0] || (await context.newPage());
  try {
    await ensureLoggedIn(page);
    await page.goto('https://www.linkedin.com/mynetwork/invitation-manager/sent/', { waitUntil: 'domcontentloaded' });
    await sleep(5000);
    // Ground truth: a few VIEWPORT screenshots while scrolling from the top, so
    // the most-recent (today's) invitations are legible. Read-only scrolling.
    const stamp = Date.now();
    await page.mouse.wheel(0, -4000);
    await sleep(800);
    for (let i = 0; i < 4; i++) {
      const shot = path.resolve(__dirname, 'screenshots', `sent-${stamp}-${i}.png`);
      try {
        await page.screenshot({ path: shot, fullPage: false });
        console.log('screenshot:', shot);
      } catch (e) {
        console.log('screenshot failed:', e.message);
      }
      await page.mouse.wheel(0, 640);
      await sleep(1100);
    }
    // Collect profile links anywhere on the page (the list container isn't always
    // <main>). Read-only: text + href.
    const entries = await page.$$eval('a[href*="/in/"]', (as) => {
      const seen = new Set();
      const out = [];
      for (const a of as) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/in\/([^/?#]+)/);
        if (!m) continue;
        const slug = m[1];
        const name = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
        if (!name) continue;
        const key = slug + '|' + name;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ slug, name });
      }
      return out;
    });
    // Try to read the visible count header, if present.
    let header = '';
    try {
      header = ((await page.locator('main h1, main h2').first().textContent()) || '').replace(/\s+/g, ' ').trim();
    } catch {
      /* ignore */
    }
    console.log('\n=== SENT INVITATIONS (read-only) ===');
    if (header) console.log('header:', header);
    console.log(`profile links found in list: ${entries.length}`);
    for (const e of entries) console.log(`  - ${e.name}  (/in/${e.slug})`);
    console.log('\n(no Withdraw clicked — read-only)\n');
  } finally {
    await sleep(500);
    await context.close();
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
