# CareerCrumbs — cloud edition

A private, phone-first career tracker for a warehouse supervisor working toward a promotion. It runs as one self-contained page (`careercrumbs.html`) and is published as a claude.ai artifact, so it opens on any phone or computer with nothing to install.

This is a separate build from the Android app in `C:\Users\Brandon\CareerCrumbs`. It keeps the same brand rules: black, white and brown only, templates always labelled as templates, and a calm tone with no streaks.

## What's in it

| Area | What it does |
| --- | --- |
| **Home** | Promotion-readiness meter, a "Today" list (overdue 1:1s, stakeholder touchpoints, job follow-ups, blocked projects, unlogged numbers, plan steps due), week stats, wins-per-week chart |
| **Wins** | STAR evidence log with before/after metrics and competency tags. Template résumé bullets built only from your own words and numbers. Brag doc for any date range |
| **Numbers** | Weekly KPI tracker (UPH, pick accuracy, INF rate, dasher wait, shrink, labor hours per order…) with targets, higher/lower-is-better, sparklines and history |
| **Promotion** | Competency self-ratings against a target level, evidence count per competency, gaps, a 30/60/90 plan, and a one-tap promotion case |
| **Projects** | Status, impact, next action, blockers, milestones. A finished project becomes a win |
| **Team** | 1:1, recognition and coaching log, auto-built 1:1 agendas, and a cross-training matrix that flags stations with fewer than 2 certified people |
| **Visibility** | Manager, skip-level and mentor touchpoint cadence with overdue reminders, plus a weekly-update generator |
| **Jobs** | Internal and outside openings with stages, follow-up dates and a timeline |
| **Drafts** | Everything generated, editable, copyable and saveable as a file. "Polish with Ruhv" (Claude) rewrites wording without adding facts |
| **Weekly review** | Went well / stuck / next focus / energy, with history |
| **Profile & data** | Profile, theme, JSON backup export/import, erase |

## Where data lives

- **Published on claude.ai:** the artifact's database, under `ws/<area>` (profile, wins, kpis, path, projects, team, people, jobs, drafts, reviews). Access rules make it readable and writable by the owner only.
- **Opened as a plain file:** `localStorage` in that browser.

On first open, it shows clearly marked example data until you choose **Start fresh** or **Keep examples**.

## Develop

```
npm test        # pure logic tests (node:test)
npm run build   # inlines src/ into careercrumbs.html
```

- `src/logic.js` — pure helpers: dates, readiness, KPI status, bullet and document templates, example data
- `src/app.js` — UI, persistence, Ask Ruhv
- `src/styles.css` — design tokens (light and dark)
- `src/shell.html` — page skeleton the build fills in
