// Default Open Graph image for the whole site (ARCHITECTURE.md §17, §22). Embeds the real canonical skull logo
// (`assets/brand/pavisie-skull.png`, 1024x1024, PNG — the JPEG-decoder issue that used to block this route was
// specific to next/og's decoder choking on that stale JPEG source; the canonical logo is a lossless PNG now and
// decodes fine) as a base64 `data:` URI, read once at module load time with `node:fs` so the build stays 100%
// offline: zero network calls, zero runtime file reads (the read happens at build/module time, not per-request).
// Per §22's graceful-degradation rule this must never fail the build — if the source PNG is ever missing (e.g. a
// checkout without `assets/brand/`), we fall back to the original dependency-free monochrome pixel-grid mark
// instead of throwing.
import { ImageResponse } from 'next/og';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const alt = 'Pavisie — Discord moderation you can trust';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// A tiny 8x8 pixel-art skull silhouette (1 = filled) — fallback-only mark, used solely if the real logo PNG
// cannot be found at build time (see LOGO_DATA_URI below).
const SKULL_ROWS = [
  '00111100',
  '01111110',
  '11111111',
  '11011011',
  '11111111',
  '11100111',
  '01111110',
  '00100100',
];

// Candidate paths for the canonical logo, covering both plausible `process.cwd()` values for `next build`
// (pnpm's `--filter @pavisie/web build` runs the script with cwd = apps/web, per package.json's own `prebuild`/
// `build` scripts) and a repo-root cwd, plus the sync-brand.mjs-generated copy as a secondary fallback. The first
// candidate — the git-tracked source under `assets/brand/` — is copied into every Docker build context by
// `COPY . .` in infra/docker/Dockerfile.web regardless of script execution order, so it is the most reliable.
const LOGO_CANDIDATES = [
  join(process.cwd(), '..', '..', 'assets', 'brand', 'pavisie-skull.png'), // cwd = apps/web
  join(process.cwd(), 'assets', 'brand', 'pavisie-skull.png'), // cwd = repo root
  join(process.cwd(), 'public', 'brand', 'pavisie-skull.png'), // cwd = apps/web, synced copy
  join(process.cwd(), 'apps', 'web', 'public', 'brand', 'pavisie-skull.png'), // cwd = repo root, synced copy
];

function loadLogoDataUri(): string | null {
  for (const path of LOGO_CANDIDATES) {
    try {
      const bytes = readFileSync(path);
      return `data:image/png;base64,${bytes.toString('base64')}`;
    } catch {
      // Try the next candidate; if all fail, LOGO_DATA_URI stays null and Image() falls back to the pixel grid.
    }
  }
  return null;
}

const LOGO_DATA_URI = loadLogoDataUri();

export default function Image() {
  const cell = 14;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#050505',
          color: '#e5e5e5',
        }}
      >
        {LOGO_DATA_URI ? (
          // Note: this <img> is rendered by satori/next/og (server-side, into a PNG), not the DOM — the
          // next/image / no-img-element lint concerns that normally apply to browser-rendered JSX don't apply here.
          <img src={LOGO_DATA_URI} width={200} height={200} style={{ borderRadius: 16 }} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {SKULL_ROWS.map((row, y) => (
              <div key={y} style={{ display: 'flex' }}>
                {row.split('').map((bit, x) => (
                  <div
                    key={x}
                    style={{
                      width: cell,
                      height: cell,
                      backgroundColor: bit === '1' ? '#d4d4d4' : 'transparent',
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: 40, fontSize: 96, fontWeight: 700, letterSpacing: -2, display: 'flex' }}>
          PAVISIE
        </div>
        <div style={{ marginTop: 20, fontSize: 34, color: '#a3a3a3', display: 'flex' }}>
          Discord moderation you can trust
        </div>
      </div>
    ),
    { ...size },
  );
}
