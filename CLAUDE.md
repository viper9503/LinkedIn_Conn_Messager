# CLAUDE.md — LinkedIn outreach helper

Guidance for any future Claude working in this repo. **Read the "🚨 Never again"
section before running anything that touches LinkedIn.**

## What this project is

A small, local Playwright toolkit for **low-volume, human-paced** LinkedIn
outreach during a job search. It drives a **real browser that the user logs into
manually** — it never sees a password. It is deliberately not a bulk tool.

Three scripts, three distinct jobs (no shared "send" logic — don't try to merge
them):

| Script | Job | Acts on | Log | Default |
|--------|-----|---------|-----|---------|
| `harvest.js` | Build a target list from your recent connections + inbox | your network | writes `targets.csv` / `already-messaged.csv` | read-only |
| `messenger.js` | Send a **message** to people you're **already connected to** (1st-degree) | existing threads | `sent-log.json` | dry-run |
| `connect.js` | Send a **connection invite WITH a ≤300-char note** to people you're **not** connected to | new invites | `invite-log.json` | dry-run |

`README.md` covers `harvest.js` + `messenger.js` in depth. **`connect.js` is the
newest script and is documented here** (the README predates it).

Shared infra:
- `lib/` — `csv.js` (quoted-field CSV parser), `dates.js`, `names.js`. Tests in `test/*.test.mjs` (`node test/dates.test.mjs`).
- `user-data/` — the persisted Chromium login profile, **shared by all scripts**. Gitignored. Never commit or share it. If login expired, the script waits up to 5 min for you to log in in the visible window.
- `screenshots/` — failure screenshots, auto-written, gitignored, safe to delete.

## connect.js — how it works

```bash
# dry run (nothing sent) — ALWAYS do this first
node connect.js --targets <file.csv> --note <note.txt>
# real send
node connect.js --targets <file.csv> --note <note.txt> --send
# pacing between profiles (seconds)
node connect.js ... --min 4 --max 10
```

- **Targets CSV** needs a `url` column (the profile) plus any columns your note template references. The parser handles quoted fields with embedded commas.
- **Note template** is a text file. `{{column}}` placeholders are filled per row. Every rendered note is validated against LinkedIn's **300-char** hard cap up front — the run aborts if any is over.
- **`invite-log.json`** (url → status) makes the run idempotent: anyone already `invited` is skipped on re-runs. Statuses: `invited`, `skipped` (already-connected / pending / no-connect-button), `failed`, and `pending-noteless` (a hand-set marker, see history below).
- **Per-person unique notes:** put each full message in a quoted `note` column and use `note-passthrough.txt`, which is just `{{note}}`. This is how the Salient batch was sent. (For a single shared template with per-row swaps, use `referral-note.txt`: `Hi {{firstName}}, … at {{company}}, …`.)
- The script reads each profile's relationship state in `profileState()` and only attaches a note via the invite modal (`inviteWithNote()`). It stops the whole run if LinkedIn reports a weekly invite limit.
- **Fail-closed identity guard (added 2026-06-15).** Before any click, the row's
  `name` column is checked against the Connect control's `aria-label`
  (`nameMatches()`); if they don't match, the row is **skipped (`name-mismatch`)**
  and never clicked. Structural backstop against the instant-send-to-stranger
  incident below — a suggestion card / wrong profile carries a different name, so
  it can't be acted on. **Always include a `name` column** (full name) in the
  targets CSV so the guard is active.
- **Rate tally & guardrail (added 2026-06-16).** `node tally.js` reports invites
  sent per day / rolling-7-day / rolling-30-day from `invite-log.json` and rewrites
  `OUTREACH-LOG.md` (a persistent record you can open). connect.js prints the same
  tally before every run and **refuses to send past the self-imposed caps** in
  `lib/tally.js` (daily 20, weekly 80, monthly 250 — set below LinkedIn's ~100/wk
  ceiling) unless `--force` is passed; it rewrites `OUTREACH-LOG.md` after each run.
  **Before any batch, check `node tally.js`** and don't blow the weekly cap — the
  binding real-world limit is acceptance rate, so keep volume modest. NOTE: the
  tally only counts invites sent *by this tool*; manual invites you send in the
  LinkedIn UI aren't included, so the true rolling-7-day number can be higher.
- **Read-only recon/verify tools (added 2026-06-15):** `recon-readonly.js --urls
  file.txt` navigates each profile and dumps name/headline/company + relationship
  with **zero clicks** (writes `recon.json`) — use it to pull real names (slugs are
  unreliable: the display name, and often a preferred nickname, differ from the URL
  slug) and confirm connectable BEFORE a run. `read-sent.js` screenshots the Sent
  page for the rule-4 check. Both are pure-read (grep them: no `.click()`).

## 🚨 Never again — the 2026-06-15 incident (READ THIS)

**What happened:** a routine "send these 8 noted invites" run instead fired ~10
**bare, note-less invites to the wrong people** (random suggested strangers),
and delivered **zero** of the personalized notes — before anyone noticed.

**Root cause (a LinkedIn DOM change):**
1. LinkedIn now renders the **"More profiles for you" suggestion cards _inside_ `<main>`**. Scoping a selector to `main` no longer excludes them.
2. A profile's **own** "Connect" control is an **`<a>` anchor**. The suggestion cards' quick-connect buttons are **`<button>`s**.
3. Clicking a **suggestion's** Connect `<button>` sends an **instant invite with no modal and no note** — to a stranger.

The old selector `main button[aria-label^="Invite"][aria-label*="connect"]`
matched a **suggestion button** (`.first()`), so every iteration invited a
stranger instantly, then timed out waiting for a note modal that never opens.
Two more stray invites came from clicking on real profiles **to debug** before
inspecting the DOM read-only first.

**The rules — follow all of them:**

1. **The profile's own Connect is an anchor, never a button.** Use
   `main a[aria-label^="Invite" i][aria-label*="to connect" i]`. **If a Connect
   selector can match a `<button>`, stop** — that's a suggestion card and it
   instant-sends to a stranger. This is encoded in `profileState()`; keep it that
   way. Check "connectable" (anchor present) **before** any "1st-degree" guess,
   so a real target is never misread.
2. **Canary before batch.** Dry-run **one** profile, confirm `✓ Preview OK`,
   **then** open the Sent-invitations page and confirm nothing actually went out.
   Only then run the batch. A dry-run does **not** protect against
   instant-send-on-click, so a 1-profile canary is what caps the blast radius.
3. **Never click on a real profile to "debug."** Do **read-only** DOM inspection
   first (navigate, dump elements, take a screenshot — **no `.click()`**). Two of
   the stray invites came from skipping this. Any throwaway diagnostic that
   clicks must press `Escape` to cancel and must **never** click a Send button.
4. **Sent-invitations page is ground truth:** after any send, verify at
   `https://www.linkedin.com/mynetwork/invitation-manager/sent/`. The script's
   own log can lie if the DOM shifted under it.
5. **Validate notes ≤300 chars before launching a browser** (the script does this;
   don't bypass it).
6. **Sending is outward-facing and hard to reverse.** Get explicit user sign-off
   before a real `--send`, and prefer the dry-run → canary → batch sequence even
   when the user says "just do it."

## Current outreach state (as of 2026-06-16)

Per-person names + the exact notes live ONLY in the local, gitignored
`invite-log.json` (and `recon.json`). This committed doc keeps just counts and
the lessons — don't paste real names back in here (the repo has a remote).

- **11 Cisco targets invited WITH personalized notes** (general referral ask for
  engineering roles; from a gitignored `targets-cisco.csv`). All confirmed
  currently at Cisco; none excluded. Canary-first → Sent-page verified → batched
  at 30–90s → re-verified; the identity guard matched every one (including a name
  with a non-ASCII character and one display-name vs. preferred-name case). A
  2-agent adversarial QA pass caught and fixed a templated/duplicate-note cluster
  before sending.
- **11 Stripe targets invited WITH personalized notes** (referral ask for a Full
  Stack Engineer role + similar). Sent canary-first → Sent-page verified → batched
  → re-verified; identity guard matched every one. **2 of the original 13 were
  deliberately EXCLUDED:** one had moved employers (the target company was only a
  *past* role — wrong company for the note), and one was a follow-only / already-
  connected profile with no direct Connect anchor (would hit the fragile
  More-overflow path; use `messenger.js` for those).
- **5 Salient targets invited WITH their notes** (`invite-log.json` = `invited`).
- **3 Salient targets have PENDING note-less invites** (collateral from the
  2026-06-15 bug), marked `pending-noteless`. They reached the right people but
  without the note; you can't re-send a noted invite without withdrawing first
  (LinkedIn then blocks re-invite ~3 weeks). The user chose **not** to withdraw.
- **~5 unintended note-less invites to strangers/other staff** (also from the bug)
  are still pending. User chose **not** to withdraw. To revisit: Sent-invitations
  page → Withdraw.

## If selectors break again

LinkedIn changes its HTML often. Fragile spots: `profileState()` /
`inviteWithNote()` in `connect.js`; `extractCards`/`extractInboxRows` in
`harvest.js`; `openComposer`/`checkHistory` in `messenger.js`. When something
breaks, **inspect read-only first** (per rule 3), confirm the new structure, then
patch — and re-run the canary before any batch.
