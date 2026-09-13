# Quickstart for Brandon (no coding required)

This is the plain-language version. It walks through getting Pavisie live on
`pavisie.com` using accounts and web forms only — every command you need to copy-paste is
in a grey box, and every click is spelled out. If a step ever produces an error message, the
fastest way to get unstuck is to ask in the **Pavisie support Discord server** (linked on the
website's `/support` page and in its footer) — after that, check `docs/TROUBLESHOOTING.md` for the
specific error.

## 1. Accounts you need before you start

| Account                                                                                          | What it's for                                                 | Cost                                                |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------- |
| **Discord Developer Portal** (discord.com/developers) — sign in with your normal Discord account | Creates the bot application itself                            | Free                                                |
| **Railway** (railway.app) — sign in with GitHub                                                  | Hosts the bot, API, dashboard, and website, plus the database | Paid — see [What costs money](#5-what-costs-money)  |
| **Stripe** (stripe.com) — optional, only if you want donations                                   | Processes donation payments                                   | Free to sign up; they take a small cut per donation |
| **Domain registrar** — wherever you bought `pavisie.com`                                     | Points the domain at Railway                                  | Whatever you already pay for the domain             |
| **GitHub** — you already have this since the code lives there                                    | Railway deploys straight from your GitHub repo                | Free                                                |

You do not need a code editor, a terminal, or to install anything on your computer for the
production setup below — that's all done through the Railway and Discord websites. (A developer
running this locally on their own machine is a separate, more technical path covered in the main
`README.md`.)

## 2. Create the Discord bot application

1. Go to <https://discord.com/developers/applications> and log in.
2. Click **New Application** (top right). Name it **Pavisie**. Agree to the terms, click
   **Create**.
3. On the **General Information** page: click the icon circle, upload
   `assets/brand/pavisie-skull.png` from the project folder as the app icon. Click **Save
   Changes**.
4. Click **Bot** in the left sidebar. Under the bot's icon, click it and upload the same
   `assets/brand/pavisie-skull.png` file as the bot's avatar too.
5. Still on the **Bot** page, click **Reset Token**, confirm, then click **Copy**. This is your
   bot's password — paste it somewhere temporarily safe (a private note), you'll need it in step
   4 below. If you lose it later, come back here and reset it again.
6. Scroll down to **Privileged Gateway Intents**. Turn **ON** the toggle for **Server Members
   Intent**. Leave **Message Content Intent** and **Presence Intent** OFF for now — you can turn
   Message Content on later once specific features need it (Discord requires extra approval for
   it once the bot is in 100+ servers; the bot works fine without it until then).
7. Click **General Information** again and copy the **Application ID** — this is your
   `DISCORD_CLIENT_ID`. Then click **Reset Secret** under **OAuth2** (or find **Client Secret**
   under OAuth2 → General) and copy it too — this is your `DISCORD_CLIENT_SECRET`.
8. Click **OAuth2** in the sidebar → **General**. Under **Redirects**, click **Add Redirect** and
   enter exactly:
   ```
   https://api.pavisie.com/auth/discord/callback
   ```
   Click **Save Changes**.

You now have three copied values: the **bot token**, the **Application ID**, and the **Client
Secret**. Keep them private — anyone with the bot token can control your bot.

## 3. Set up hosting on Railway

1. Go to <https://railway.app>, sign in with GitHub, and authorize Railway to see your
   repositories.
2. Click **New Project → Deploy from GitHub repo** and pick the `pavisie` repository.
3. Railway will ask what to deploy — add **four services**, one at a time, all pointing at the
   same repo:
   - Service named `bot` — Root Directory `/`, Dockerfile Path `infra/docker/Dockerfile.bot`
   - Service named `api` — Root Directory `/`, Dockerfile Path `infra/docker/Dockerfile.api`
   - Service named `dashboard` — Root Directory `/`, Dockerfile Path
     `infra/docker/Dockerfile.dashboard`
   - Service named `web` — Root Directory `/`, Dockerfile Path `infra/docker/Dockerfile.web`
     (Each service's settings page has a **Root Directory** and **Dockerfile Path** field under
     **Settings → Build**.)
4. In the same project, click **New → Database → Add PostgreSQL**, then **New → Database → Add
   Redis**. Railway provisions both automatically.
5. For each of the four services, open **Variables** and paste in the values from
   `.env.production.example` (in the project folder), filling in the blanks:
   - `DATABASE_URL` → paste `${{Postgres.DATABASE_URL}}` (Railway fills in the real value)
   - `REDIS_URL` → paste `${{Redis.REDIS_URL}}`
   - `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` → the three values from step 2
   - `ENCRYPTION_KEY` and `SESSION_SECRET` → see the grey box below for how to generate these
   - Everything else in `.env.production.example` that isn't already filled in for
     `pavisie.com`

   To generate `ENCRYPTION_KEY` and `SESSION_SECRET`, you need two random strings. If you have a
   developer helping, they can run this once each and send you the output:

   ```
   openssl rand -base64 32
   ```

   Run it twice — once for `ENCRYPTION_KEY`, once for `SESSION_SECRET`. Each one only needs to be
   generated once, ever, then reused everywhere.

6. For `api`, `dashboard`, and `web`: open **Settings → Networking → Generate Domain**, or (better)
   attach your real domain — see step 4 below.
7. On the `api` service, open **Settings → Deploy** and set a **Pre-Deploy Command**:
   ```
   pnpm db:migrate
   ```
   This makes sure the database is always up to date before the app starts serving requests.
8. Click **Deploy** on all four services. The first deploy takes a few minutes per service — watch
   the **Deployments** tab for a green checkmark on each.

## 4. Point pavisie.com at Railway

1. In each of `api`, `dashboard`, and `web`'s Railway settings (**Settings → Networking → Custom
   Domain**), add:
   - `api` → `api.pavisie.com`
   - `dashboard` → `app.pavisie.com`
   - `web` → `pavisie.com` (and `www.pavisie.com`)
     Railway will show you a target value (a CNAME, or an A/ALIAS record for the bare domain).
2. Log into your domain registrar (wherever `pavisie.com` is registered) and add the DNS
   records Railway showed you:
   - `CNAME app` → Railway's target for `dashboard`
   - `CNAME api` → Railway's target for `api`
   - `CNAME www` → Railway's target for `web`
   - the bare `pavisie.com` (root/apex) → follow your registrar's instructions for an
     ALIAS/ANAME record, or Railway's specific apex-domain instructions if your registrar doesn't
     support ALIAS records
3. DNS changes can take anywhere from a few minutes to a few hours to take effect. Railway shows a
   green checkmark next to the domain once it detects it working and issues HTTPS automatically —
   you don't need to do anything extra for the padlock icon.

## 5. How to know it worked

- Visit `https://pavisie.com` — you should see the Pavisie website.
- Visit `https://app.pavisie.com` — you should see the dashboard login page. Click **Login
  with Discord**, approve, and you should land on a page listing your Discord servers.
- In Discord, go to a server you manage and try typing `/health` — if the bot responds with an
  embed showing "status: ok", everything is connected.
- If `/health` (or any slash command) doesn't show up at all, you still need to **invite the bot**
  and **register its commands** — see the next section.

## 6. Inviting the bot to a server and testing commands

1. Build your invite link by filling in your Application ID from step 2:
   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot%20applications.commands&permissions=1504198388950
   ```
   Open it in a browser, pick a server you manage, and click **Authorize**.
2. After the bot joins, **immediately try typing `+help` in any channel**. That lists every command.
   Unlike slash commands, `+` works the moment the bot joins — there is nothing to register first.
   If `+help` does nothing at all, the Message Content intent isn't on yet: switch it on in the
   Discord Developer Portal (**Bot** → **Privileged Gateway Intents** → **Message Content Intent**)
   and set `ENABLE_MESSAGE_CONTENT_INTENT=true` in your environment, then restart the bot. Every
   command also works as a slash command (`/help`) once step 3 is done.
3. Commands need to be registered once (and again any time commands change). If you have a
   developer available, they run:
   ```
   pnpm --filter @pavisie/bot register --global
   ```
   Global registration can take **up to an hour** to show up in Discord — that's normal, not
   broken. After you register, try `/help` as well to confirm the slash form is working.

## 7. How to update Pavisie later

Once it's live, updating is simple:

1. Whoever is making the code changes pushes them to the `main` branch on GitHub (or merges a pull
   request into it).
2. Railway automatically detects the change and redeploys all four services — you don't have to do
   anything.
3. Watch the **Deployments** tab on each service in Railway; a green checkmark means it's live.
4. If something breaks after an update, Railway keeps previous deployments — open the service →
   **Deployments** → find the last known-good one → click the **⋮** menu → **Redeploy** to roll
   back instantly while the problem gets fixed.

## 8. What costs money (rough numbers — check current pricing)

These are ballpark figures, not quotes. **Always check the provider's current pricing page before
committing** — hosting prices change.

| Thing                                                | Rough monthly cost                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Railway (4 services + Postgres + Redis, low traffic) | Roughly $15–30/month depending on usage; Railway bills by actual resource use on top of a small base plan   |
| Domain registration (`pavisie.com`)              | Usually $10–20/**year**, already a sunk cost if you own it                                                  |
| Stripe                                               | No monthly fee — they take a small percentage + fixed fee per donation processed (check stripe.com/pricing) |
| Discord Developer Portal                             | Free                                                                                                        |

Donations collected through the Stripe-powered **Donate** page on the website fund hosting costs
directly — that's the intended purpose stated on the page itself.

## If something goes wrong

- **First stop: the Pavisie support Discord server** (linked on the website's `/support` page and
  in its footer) — ask there first, especially if you don't have a developer on hand.
- Nothing loads at all → check the Railway **Deployments** tab for a red/failed build on any of
  the four services, and open its logs.
- Bot doesn't respond in Discord → see `docs/TROUBLESHOOTING.md` → "The bot won't start" and
  "Slash commands aren't showing up in Discord".
- Dashboard sends you back to the login page → see `docs/TROUBLESHOOTING.md` → "Dashboard login
  loop".
- Anything else → the full `docs/TROUBLESHOOTING.md` covers webhooks, database errors, and more,
  in the same plain style as this guide.
