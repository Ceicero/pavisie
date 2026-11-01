# CareerCrumbs — cloud edition

A no-AI job search companion with one goal: **make getting a job easier.** You write your own interview answers, practise them out loud, and keep every application moving. Ruhv, the CareerCrumbs mouse, is the logo.

It runs as one self-contained page (`careercrumbs.html`) published as a claude.ai artifact. Each person who opens it gets their own private workspace.

## What's in it

| Section | What it does |
| --- | --- |
| **Home** | Your next interview, what to do today (follow-ups due, prep before an interview, thank-you notes after), how many answers are ready, and the next question to write |
| **Jobs** | Every application with its stage, interview date and time, follow-up date and contact. A follow-up is set a week after you apply. Ready-to-copy messages: follow up, thank you, confirm a time, check on a decision, withdraw politely |
| **Interview** | 46 questions for everyday jobs (common, behavioral, warehouse & operations, customer service & retail, lead & supervisor) plus your own, pasted straight from a job posting. Write answers as free text or STAR, with word count, spoken time and a length hint. Mark them ready, practise 5 at a time with a timer, and keep a "needs work" list. Each job gets its own prep view, a one-page cheat sheet and a calendar file for the interview |
| **Stories** | Your real moments at work, in STAR form. One tap fills a STAR answer, and each story becomes a template résumé line built only from your words |
| **Me** | Name (signs your messages), the job you're going for, which question sets to include, theme, backup export/import, erase |

No AI anywhere, and nothing you write is sent anywhere else.

## Where data lives

- **Published on claude.ai:** the artifact's database, in each viewer's own private space (`data/users/<id>/profile|jobs|stories|interview`). Nobody else, the owner included, can read it.
- **Where that isn't available** (opened as a plain file, or a viewer who can't write): `localStorage` in that browser.

## No setup

There's no sign-up, setup form or example data to clear. The first screen offers three one-tap starts: answer "Tell me about yourself" (with an example answer to look at first), add a job, or practise 5 questions. Everything saves as you type.

- Adding a job needs only a title and company; the rest sits under "More details".
- A story needs only what you did and how it turned out; the backstory is optional.
- Your name is asked for only inside Messages, the one place it's used.
- Matching question sets (warehouse, customer service, lead) are one optional tap on the Interview page.

## Develop

```
npm test        # pure logic tests (node:test)
npm run build   # inlines src/ into careercrumbs.html
```

- `src/logic.js` — question bank and tips, answer timing, job stages and badges, message templates, résumé lines, cheat sheet, calendar file, example answers
- `src/app.js` — UI, saving, practice mode
- `test/fixture.cjs` — example workspace used by the tests
- `src/styles.css` — design tokens (light and dark)
- `src/shell.html` — page skeleton the build fills in
