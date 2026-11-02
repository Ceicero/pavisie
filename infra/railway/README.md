# Railway deployment

This folder holds one Railway service config per deployable. The step-by-step click-path (creating
the project, the four services, Postgres/Redis, variables, domains, migrations, and command
registration) lives in **`infra/DEPLOYMENT.md` §2** — read that first if you're setting this up for
the first time. This README covers what the four `*.railway.json` files here do and why `bot`'s
looks different from the other three.

## What these files are

Railway reads a `railway.json` (or `railway.toml`) from a service's **Root Directory** to configure
its build and deploy behavior without you having to click through every setting in the UI. Each
service in this repo's Railway project should have its **Config File Path** (in the service's
**Settings → Config-as-code**) pointed at the matching file here:

| Service     | Config file                            | Dockerfile it builds                |
| ----------- | -------------------------------------- | ----------------------------------- |
| `api`       | `infra/railway/api.railway.json`       | `infra/docker/Dockerfile.api`       |
| `dashboard` | `infra/railway/dashboard.railway.json` | `infra/docker/Dockerfile.dashboard` |
| `web`       | `infra/railway/web.railway.json`       | `infra/docker/Dockerfile.web`       |
| `bot`       | `infra/railway/bot.railway.json`       | `infra/docker/Dockerfile.bot`       |

Setting the config file path is optional — Railway also lets you set Root Directory / Dockerfile
Path / healthcheck by hand in the Settings UI, and the click-path in `infra/DEPLOYMENT.md` §2.1 does
exactly that. Pointing a service at its `railway.json` here just keeps that configuration in git
instead of only in Railway's UI, so it's reviewable and doesn't drift.

## Why `bot.railway.json` has no `healthcheckPath`

`api`, `dashboard`, and `web` each serve HTTP on a port Railway assigns them a public domain for
(§2.4 of `infra/DEPLOYMENT.md`), so Railway's `deploy.healthcheckPath` can reliably hit that port to
decide whether a new deploy is healthy before routing traffic to it.

`bot` is different: it has no public HTTP surface at all. Its only HTTP endpoint is the tiny
`GET /health` server on `BOT_HEALTH_PORT` (default `3002`, see `apps/bot/src/host/health.ts`), which
exists purely for the **Docker-level** `HEALTHCHECK` instruction already baked into
`infra/docker/Dockerfile.bot` and for manual debugging — it was never meant to be internet-facing,
and `bot` never gets a Railway public domain. Railway's `railway.json` `healthcheckPath` is
documented and supported against a service's **public-networking** port; there is no confirmed,
stable way in the current Railway product to point that same feature at a private port on a service
that never generates a domain. Rather than ship a config that might silently no-op or, worse, might
make Railway mark healthy `bot` deploys as failed and restart-loop them, this file omits
`healthcheckPath` for `bot` and relies on two things that do work today:

1. **Docker's own `HEALTHCHECK`** in `Dockerfile.bot` (`wget -qO- http://localhost:3002/health`) —
   Railway (like any Docker host) can read the container's health status from this.
2. **`restartPolicyType: ON_FAILURE`** in `bot.railway.json` — if the process crashes or exits
   non-zero, Railway restarts it regardless of the HTTP healthcheck question.

If Railway later documents (or you confirm in your own account) first-class support for
healthchecking a private port, add `"healthcheckPath": "/health"` back to `bot.railway.json` — the
`bot` service's `BOT_HEALTH_PORT` (3002) is already exposed in `Dockerfile.bot` (`EXPOSE 3002`) and
ready for it. In the meantime, verify `bot`'s health manually the same way you'd debug anything
private on Railway:

```
railway run --service bot wget -qO- http://localhost:3002/health
```

or check the service's **Deployments** tab, which shows crash/restart history even without an HTTP
healthcheck configured.

The bot also now exits (code 1) on an uncaught crash or when the Discord gateway stays down for
`BOT_WATCHDOG_MINUTES`, which is what makes `ON_FAILURE` restart a wedged process, and `/health` returns
`503` after the gateway has been down for 2 minutes. If you do set a Healthcheck Path for `bot` in the
dashboard, see `infra/DEPLOYMENT.md` §2.7a for what it does (it only gates deploys) and the open question
about which port Railway checks.

## Editing these files

Change the Dockerfile path, restart policy, or healthcheck path here and redeploy — Railway re-reads
`railway.json` on the next deploy of that service. Don't rename these files without also updating
the Config File Path in each service's Railway Settings to match.
