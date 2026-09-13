# Pavisie brand assets

| File                  | What it is                                                                                                                                                            | Used by                                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pavisie-skull.png`  | Canonical Pavisie logo, used everywhere: a gold laurel-wreath medallion with a skull, on pure black, square (1024×1024). Lossless PNG; takes precedence over the `.jpg` when both exist. | Website, dashboard sidebar, bot avatar (`pnpm --filter @pavisie/bot set-avatar`), embed icons via `WEB_URL/brand/pavisie-skull.<ext>` (served from the web app's `public/brand/`), Discord Developer Portal app icon (manual upload). |
| `pavisie-skull.jpg`  | The same art re-encoded as JPEG. Kept only for backwards-compatible URLs/cached references that still name the `.jpg` file — not used as the preferred source anywhere. | Served alongside the `.png` from every app's `public/brand/` so old `.jpg` links keep working; never referenced as the preferred `logo` in a manifest.                                                                                        |

`pnpm brand:sync` (run automatically before `dev`/`build` of the web and dashboard apps) copies every shared logo
file that exists (`pavisie-skull.png` and `pavisie-skull.jpg`) into each app's `public/brand/` folder unchanged,
and writes each app's `public/brand/manifest.json` with `logo` naming the preferred one
(`{ "logo": "/brand/pavisie-skull.png" }`). It also writes a git-tracked, build-time copy of that manifest —
`apps/web/src/data/brand.json` and `apps/dashboard/src/data/brand.json` — that each app's logo component imports
directly instead of fetching `public/brand/manifest.json` at runtime. Everything degrades gracefully while a file is
missing (text wordmark, SVG fallback favicon, no embed icon).

An optional website-only override still exists in the script: dropping `pavisie-skull-web.png`/`.jpg` into this
folder would make the public website display that variant instead (header/hero/apple-icon only), while the
dashboard, bot avatar, and embed icons keep reading the shared `pavisie-skull.<ext>` above. No such file is
currently present in the repo — the shared logo already is the clean/bright art the website wants.

Do not commit other raster variants — sizes are generated at build/serve time. The one exception is the browser-tab
favicon, below.

## Browser-tab favicons

`apps/web/src/app/icon.png` and `apps/dashboard/src/app/icon.png` (256×256 RGB, black background kept) are the
committed favicons for the two apps, picked up automatically by Next's app-router file convention (no `icons` entry
needed in `metadata`). They are static, hand-generated files — `scripts/sync-brand.mjs` does not touch them — so
regenerate and re-commit both whenever `assets/brand/pavisie-skull.png` changes.

### Regenerating favicons

No `sharp`-based Node script ships in this repo (`sharp` isn't resolvable from the repo root as of this writing —
re-check with `node -e "require.resolve('sharp')"` before assuming this). Regenerate both favicons with Python PIL:

```
python -c "
from PIL import Image
src = Image.open('assets/brand/pavisie-skull.png').convert('RGB')
resized = src.resize((256, 256), Image.LANCZOS)
for t in ['apps/web/src/app/icon.png', 'apps/dashboard/src/app/icon.png']:
    resized.save(t, format='PNG', optimize=True)
"
```
