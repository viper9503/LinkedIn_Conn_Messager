# LinkedIn referral-outreach helper

A small Playwright toolkit for **low-volume, human-paced** LinkedIn outreach. It
opens a real browser, **you log in yourself**, then it (1) builds a reviewable
list of your recent connections and (2) sends a referral-ask message, paced, to
the ones you approve. Built for catching up on a couple dozen messages — not
bulk blasting.

## ⚠️ Read this first

LinkedIn's User Agreement prohibits automated access. Even careful automation
carries a real risk of a temporary restriction or a permanent ban. This tool
stays low-volume and human-in-the-loop to minimize that risk, but **the risk is
not zero**. Keep volumes low, keep messages genuinely personal, and stop if
LinkedIn shows you any "unusual activity" warning.

## Setup

```bash
cd linkedin-messenger
npm install
npx playwright install chromium
```

First run opens a browser — **log in to LinkedIn manually** (incl. 2FA/CAPTCHA).
The session is saved in `user-data/` and shared by both scripts, so you only log
in once.

## Phase 1 — build the list (sends nothing)

```bash
node harvest.js --since 2026-05-24
```

This scrapes your *My Network → Connections*, keeps everyone connected **on/after
the cutoff**, scans your message inbox, and splits them into two tables:

- **`targets.csv`** — NEW people you have *not* messaged → these get the referral ask.
- **`already-messaged.csv`** — people you already have a conversation with → skipped.

How someone lands in `already-messaged.csv`:

| Reason | Reliability |
|--------|-------------|
| `messaged by this tool` | **Reliable** — recorded in `sent-log.json`. |
| `name match in inbox (verify)` | **Heuristic** — LinkedIn inbox rows don't expose profile URLs, so this is a *name* match. A different person with the same name could be flagged by mistake. **Skim `already-messaged.csv`; move anyone wrongly there back into `targets.csv`.** |

Dates shown with a `~` are approximate (LinkedIn shows recent connects as "2
weeks ago", not an exact date) — worth a glance.

## Phase 2 — preview, then send

```bash
# review/trim targets.csv first, then:
node messenger.js --template referral-template.txt              # DRY RUN — see each message
node messenger.js --template referral-template.txt --send --cap 50   # send, paced
```

The message lives in `referral-template.txt`. `{{firstName}}` and `{{company}}`
are filled per person from the CSV; `{{company}}` falls back to "your company"
when it can't be parsed, so it always reads cleanly.

## How it protects your account

- **You log in manually** — the script never sees your password.
- **Randomized pacing** between sends and realistic typing speed.
- **Daily cap** + `sent-log.json` so nobody is double-messaged and the cap holds
  across multiple runs in a day.
- **Two safety nets against double-messaging:** the harvest-time inbox split,
  **and** a send-time check — when the composer opens, messenger.js counts prior
  message bubbles and **skips anyone with an existing thread** (logged
  `prior-history`). If it can't confirm the thread is empty, it skips rather than
  risk a duplicate (logged `history-check-inconclusive`).
- **Dry-run by default** so you preview before anything goes out.
- **Skips non-connections** automatically (no Message button → logged, not sent).

## Options

### `harvest.js`
| Flag | Default | Meaning |
|------|---------|---------|
| `--since YYYY-MM-DD` | 2026-05-24 | Only keep connections made on/after this date. |
| `--max-iter N` | 60 | Safety cap on scroll iterations. |
| `--out path` | targets.csv | Output file for the "new" list. |

### `messenger.js`
| Flag | Default | Meaning |
|------|---------|---------|
| `--send` | off | Actually send. Without it, it's a dry run. |
| `--cap N` | 15 | Max messages **per day** (enforced via the log). |
| `--min N` `--max N` | 45 / 120 | Random delay (seconds) between messages. |
| `--template path` | template.txt | Message template (use `referral-template.txt`). |
| `--targets path` | targets.csv | CSV of people to message. |
| `--no-history-check` | off | Disable the prior-conversation skip. Only use if a LinkedIn DOM change makes it skip everyone. |

## Files

- `targets.csv` / `already-messaged.csv` — the two tables (don't commit; gitignored).
- `sent-log.json` — who's been messaged/skipped/failed (don't delete; powers the
  cap, de-dupe, and the reliable half of the split).
- `screenshots/` — saved when a send fails, to help debug.
- `user-data/` — your saved login session. **Never commit or share it.**
- `lib/` + `test/` — date parsing, name matching, CSV; run `node test/*.test.mjs`.

## If selectors break

LinkedIn changes its HTML often. The fragile selectors are grouped and commented:
connection cards in `harvest.js` (`extractCards`), inbox rows (`extractInboxRows`),
and the composer/history in `messenger.js` (`openComposer`, `checkHistory`). If
the history check starts skipping everyone, run with `--no-history-check` and
ping for a selector update.
