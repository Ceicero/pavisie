# CareerCrumbs

A no-AI job search companion with one goal: **make getting a job easier.** You write your own interview answers, practise them out loud, and keep every application moving. Ruhv, the CareerCrumbs mouse, is the logo.

One codebase, two ways to run it:

- **Website** — `site/` is a standalone static site (no server code): app, offline cache, manifest, icons, self-hosted fonts, privacy page. Host the folder anywhere.
- **Android** — `android/` wraps the site build in a WebView for test APKs (built by `.github/workflows/careercrumbs-apk.yml`).

## What's in it

| Section | What it does |
| --- | --- |
| **Home** | Your next interview, what to do today (follow-ups due, prep before an interview, thank-you notes after), how many answers are ready, and the next question to write |
| **Jobs** | Every application with its stage, pay type (hourly or salaried), interview date and time, and contact. Check-ins are scheduled for you (see below). Ready-to-copy messages: follow up, thank you, confirm a time, check on a decision, withdraw politely |
| **Interview** | 46 questions for everyday jobs (common, behavioral, warehouse & operations, customer service & retail, lead & supervisor) plus your own, pasted straight from a job posting. Write answers as free text or STAR, with word count, spoken time and a length hint. Mark them ready, practise 5 at a time with a timer, and keep a "needs work" list. Each job gets its own prep view, a one-page cheat sheet and a calendar file for the interview |
| **Stories** | Your real moments at work, in STAR form. One tap fills a STAR answer, and each story becomes a template résumé line built only from your words |
| **Me** | Name (signs your messages), the job you're going for, which question sets to include, optional account and PIN lock, theme, backup export/import, erase |

No AI anywhere, and nothing you write is sent anywhere else.

## Check-in reminders

Reconnecting at the right time is what keeps an application alive, so every job gets a check-in schedule:

- **Hourly jobs:** 3 days, 1 week and 1 month after you apply, and again after your interview.
- **Salaried jobs:** 1 week and 1 month (3 days is too soon for salaried hiring).
- Once a job has an interview, the interview's schedule takes over from the application's.

Due check-ins show on Home and in the job's Messages, with the right message ready to copy and an **I checked in** button. Phone alerts are opt-in: after you add or update a job, CareerCrumbs offers a calendar file with 9:00 am alerts, and **Me → Check-in reminders** adds every upcoming one at once. There's no server to send push notifications, so your calendar app does the alerting. Each reminder has a stable id, so adding the file again updates reminders instead of duplicating them.

## Accounts and PIN lock (both optional)

- **Account + sync** (`src/sync.js`): sign in with an emailed 6-digit code — no password, and it works inside the Android app where Google sign-in and email links don't. Each account has one Supabase row holding the workspace plus a revision number; a save only succeeds against the revision it started from, so if two devices both changed, the app asks which version to keep instead of overwriting. Sign out keeps data on the device; **Delete my account** removes the account and its row (required by Google Play). Accounts only appear when the build has `SUPABASE_URL` and `SUPABASE_ANON_KEY`; see `supabase/README.md` for setup.
- **PIN lock** (`src/vault.js`): a 4–8 digit PIN; data on the device is encrypted with AES-GCM using a key derived from the PIN (PBKDF2, 310,000 rounds). Locks after 5 minutes in the background; wrong guesses add a growing wait. The PIN is never stored. Forgot PIN: erase the device copy, then sign in again or import a backup. It protects against someone picking up your phone, not a determined attacker with the device's storage.

## Where data lives

Everything is in `localStorage` on the device (`careercrumbs:v2`, encrypted when a PIN is set); with an account, a copy also syncs to Supabase. The app asks the browser to keep it (`navigator.storage.persist`), saves pending edits when it goes to the background, keeps any unreadable copy aside instead of overwriting it, and reminds people to export a backup.

Backups are checked before import (must be a CareerCrumbs backup with something in it), cleaned field by field, and can be undone. Ids from a file are replaced if they aren't plain ids, so an imported file can't inject HTML.

## No setup

There's no required sign-up, setup form or example data to clear. The first screen offers three one-tap starts: answer "Tell me about yourself" (with an example answer to look at first), add a job, or practise 5 questions. Everything saves as you type.

- Adding a job needs only a title and company; the rest sits under "More details".
- A story needs only what you did and how it turned out; the backstory is optional.
- Your name is asked for only inside Messages, the one place it's used.
- Matching question sets (warehouse, customer service, lead) are one optional tap on the Interview page.

## Develop

```
npm test        # pure logic tests (node:test)
npm run build   # site/
SITE_URL=https://example.org/ CONTACT_EMAIL=you@example.org npm run build   # for launch: canonical/og:url and the privacy contact
SUPABASE_URL=https://abc.supabase.co SUPABASE_ANON_KEY=eyJ... npm run build # turns on optional accounts
```

Before launch: set `SITE_URL` and `CONTACT_EMAIL`, host `site/`, then add `/.well-known/assetlinks.json` if the Play Store app is a TWA.

- `src/logic.js` — question bank and tips, answer timing, job stages and badges, check-in schedule and reminder calendar, message templates, résumé lines, cheat sheet, calendar file, example answers
- `src/app.js` — UI, saving, practice mode, lock screen, sign-in and sync
- `src/vault.js` — PIN lock encryption
- `src/sync.js` — Supabase sign-in and sync client
- `supabase/` — database schema and account setup guide
- `test/fixture.cjs` — example workspace used by the tests
- `src/styles.css` — design tokens (light and dark)
- `site-src/` — standalone site shell, manifest, service worker, privacy page, icons, self-hosted fonts (OFL)
- `android/` — WebView wrapper and `build.sh`
