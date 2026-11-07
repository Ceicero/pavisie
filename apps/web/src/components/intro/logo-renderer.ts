/**
 * Canvas renderer for the animated Pavisie shield logo used by the intro splash (`IntroSplash.tsx`).
 * It draws on a transparent canvas and fades its edges out, so it sits on whatever surface the
 * splash uses.
 *
 * Timeline: `INTRO_SECONDS` of intro (the star gem ignites, flash and shockwave, a shine runs along
 * the gold trim), then a seamless `LOOP_SECONDS` loop (star glint, trim shine, rotating rays,
 * smoke, rising embers).
 * Every idle motion repeats exactly on the loop period, and particles are seeded, so a given `t`
 * always draws the same frame.
 */

export const INTRO_SECONDS = 3.2;
export const LOOP_SECONDS = 6;

/** Centre of the shield's four-point star gem in logo space (0..1), measured from the 1024px logo. */
const STAR: readonly [number, number] = [0.5, 0.2773];
const TAU = Math.PI * 2;

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t), 3);
const bump = (x: number, c: number, w: number) => Math.exp(-Math.pow((x - c) / w, 2));
const mod = (a: number, n: number) => ((a % n) + n) % n;

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

interface Ember {
  x: number;
  y0: number;
  rise: number;
  k: number;
  ph: number;
  m: number;
  sway: number;
  sph: number;
  r: number;
  hot: number;
}

const R = rng(1337);
const EMBERS: Ember[] = Array.from({ length: 64 }, () => ({
  x: 0.08 + R() * 0.84,
  y0: 0.62 + R() * 0.45,
  rise: 0.45 + R() * 0.55,
  k: R() < 0.55 ? 1 : 2, // whole cycles per loop, so the loop is seamless
  ph: R(),
  m: 1 + Math.floor(R() * 3),
  sway: 0.008 + R() * 0.025,
  sph: R() * TAU,
  r: 0.6 + R() * 1.8,
  hot: R(),
}));
const SMOKE = Array.from({ length: 6 }, (_, i) => ({
  a: R() * TAU,
  rad: 0.12 + R() * 0.2,
  size: 0.28 + R() * 0.25,
  dir: i % 2 ? 1 : -1,
  y: 0.35 + R() * 0.45,
}));

export interface LogoRenderer {
  /** Draws the frame at `t` seconds since the intro started, filling the canvas. */
  render(t: number): void;
}

/**
 * Builds the derived layers (gold-trim mask, gold glow, ember sprite) from the loaded logo once and
 * returns a renderer. Throws if the image can't be read back (e.g. served cross-origin without
 * CORS); the caller falls back to a static logo in that case.
 */
export function createLogoRenderer(canvas: HTMLCanvasElement, img: HTMLImageElement): LogoRenderer {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const N = img.naturalWidth || 1024;

  // Gold mask: the saturated gold pixels (trim, emblem and star), used for the shine and the glow.
  const src = makeCanvas(N, N);
  const sctx = src.getContext('2d')!;
  sctx.drawImage(img, 0, 0, N, N);
  const data = sctx.getImageData(0, 0, N, N);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!,
      g = d[i + 1]!,
      b = d[i + 2]!,
      a = d[i + 3]!;
    const mx = Math.max(r, g, b),
      mn = Math.min(r, g, b);
    const sat = (mx - mn) / (mx + 1e-6);
    const m = r > g && g > b && mx > 70 ? clamp((sat - 0.3) / 0.15) : 0;
    d[i] = 255;
    d[i + 1] = 245;
    d[i + 2] = 215;
    d[i + 3] = a * m;
  }
  const mask = makeCanvas(N, N);
  mask.getContext('2d')!.putImageData(data, 0, 0);
  const shimmer = makeCanvas(N, N);
  const shimmerCtx = shimmer.getContext('2d')!;

  // Soft gold glow silhouette (shadow-only trick, so it works without ctx.filter).
  const pad = Math.round(N * 0.12);
  const glow = makeCanvas(N + pad * 2, N + pad * 2);
  const g = glow.getContext('2d')!;
  g.shadowColor = 'rgba(230,160,50,1)';
  g.shadowBlur = N * 0.045;
  g.shadowOffsetX = N * 4;
  g.drawImage(mask, pad - N * 4, pad);
  g.drawImage(mask, pad - N * 4, pad);

  const sprite = makeCanvas(64, 64);
  const s = sprite.getContext('2d')!;
  const sg = s.createRadialGradient(32, 32, 0, 32, 32, 32);
  sg.addColorStop(0, 'rgba(255,245,210,1)');
  sg.addColorStop(0.18, 'rgba(255,190,80,0.9)');
  sg.addColorStop(0.45, 'rgba(255,120,30,0.28)');
  sg.addColorStop(1, 'rgba(255,90,0,0)');
  s.fillStyle = sg;
  s.fillRect(0, 0, 64, 64);

  function render(t: number) {
    const S = canvas.width;
    const cx = S / 2,
      cy = S * 0.5;
    const tau = t - INTRO_SECONDS;
    const ph = mod(tau, LOOP_SECONDS) / LOOP_SECONDS;
    const w = (n: number) => Math.sin((TAU * n * tau) / LOOP_SECONDS);
    const c = ctx!;

    const starOn = smooth(0.15, 0.7, t);
    const starFlash = bump(t, 0.75, 0.16) * 1.4;
    const logoIn = smooth(0.75, 1.9, t);
    const scaleIn = 0.86 + 0.14 * easeOut((t - 0.75) / 1.4);
    const ambient = smooth(1.0, 2.8, t);
    const boom = t < INTRO_SECONDS ? bump(t, 1.12, 0.09) : 0;
    const breathe = 0.5 + 0.5 * w(1);

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.clearRect(0, 0, S, S);

    // warm under-glow
    const gr = c.createRadialGradient(cx, cy, 0, cx, cy, S * 0.62);
    gr.addColorStop(0, `rgba(120,76,18,${(0.28 + 0.1 * breathe) * ambient})`);
    gr.addColorStop(0.5, `rgba(60,34,8,${0.18 * ambient})`);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = gr;
    c.fillRect(0, 0, S, S);

    // drifting smoke
    c.globalCompositeOperation = 'lighter';
    for (const sm of SMOKE) {
      const a = sm.a + (sm.dir * TAU * tau) / LOOP_SECONDS;
      const x = cx + Math.cos(a) * sm.rad * S,
        y = sm.y * S + Math.sin(a) * sm.rad * S * 0.4;
      const r = sm.size * S;
      const smg = c.createRadialGradient(x, y, 0, x, y, r);
      smg.addColorStop(0, `rgba(70,58,46,${0.09 * ambient})`);
      smg.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = smg;
      c.fillRect(x - r, y - r, r * 2, r * 2);
    }

    // light rays, rotating one ray-gap per loop
    const RAYS = 16;
    c.save();
    c.translate(cx, cy * 0.98);
    c.rotate((TAU / RAYS) * (tau / LOOP_SECONDS) + 0.2);
    const rr = S * 0.75;
    const rg = c.createRadialGradient(0, 0, S * 0.08, 0, 0, rr);
    const rayA = (0.11 + 0.05 * w(2)) * ambient + boom * 0.2;
    rg.addColorStop(0, `rgba(255,200,90,${rayA})`);
    rg.addColorStop(0.55, `rgba(220,140,40,${rayA * 0.35})`);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = rg;
    c.beginPath();
    for (let i = 0; i < RAYS; i++) {
      const a = (i / RAYS) * TAU,
        half = (TAU / RAYS) * (i % 2 ? 0.16 : 0.26);
      c.moveTo(0, 0);
      c.arc(0, 0, rr, a - half, a + half);
      c.closePath();
    }
    c.fill();
    c.restore();

    // logo placement
    const D = S * 0.78;
    const scale = scaleIn * (1 + 0.012 * w(1));
    const lift = -S * 0.006 * w(1);
    const LX = (u: number) => cx + (u - 0.5) * D * scale;
    const LY = (v: number) => cy + lift + (v - 0.5) * D * scale;
    const box = (layer: CanvasImageSource, k = 1) => {
      const sz = D * scale * k;
      c.drawImage(layer, cx - sz / 2, cy + lift - sz / 2, sz, sz);
    };

    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = clamp((0.32 + 0.14 * breathe) * logoIn + boom * 0.6);
    box(glow, glow.width / mask.width);

    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = logoIn;
    box(img);

    // shine along the gold trim
    const sweepIntro = t < INTRO_SECONDS ? clamp((t - 1.5) / 1.2) : -1;
    const sweepIdle = clamp((ph * LOOP_SECONDS - 2.6) / 1.6);
    const sweep =
      sweepIntro >= 0 && sweepIntro < 1
        ? sweepIntro
        : t >= INTRO_SECONDS && sweepIdle > 0 && sweepIdle < 1
          ? sweepIdle
          : -1;
    if (sweep >= 0) {
      shimmerCtx.globalCompositeOperation = 'source-over';
      shimmerCtx.clearRect(0, 0, N, N);
      shimmerCtx.drawImage(mask, 0, 0);
      shimmerCtx.globalCompositeOperation = 'source-in';
      const p = -0.4 + sweep * 1.8;
      const lg = shimmerCtx.createLinearGradient(N * (p - 0.3), 0, N * (p + 0.3), N * 0.6);
      lg.addColorStop(0, 'rgba(255,240,200,0)');
      lg.addColorStop(0.42, 'rgba(255,230,170,0.15)');
      lg.addColorStop(0.5, 'rgba(255,252,235,0.95)');
      lg.addColorStop(0.58, 'rgba(255,230,170,0.15)');
      lg.addColorStop(1, 'rgba(255,240,200,0)');
      shimmerCtx.fillStyle = lg;
      shimmerCtx.fillRect(0, 0, N, N);
      c.globalCompositeOperation = 'lighter';
      c.globalAlpha = 0.85 * Math.sin(Math.PI * sweep) * Math.max(logoIn, 0.6);
      box(shimmer);
    }

    // star gem: core glow that twinkles, and a four-point glint that flares once per loop
    const flare = t >= INTRO_SECONDS - 0.4 ? bump(ph * LOOP_SECONDS, 5.0, 0.35) : 0;
    const flick = 0.9 + 0.06 * w(5) + 0.04 * Math.sin((TAU * 11 * tau) / LOOP_SECONDS + 1.3);
    const starGlow = clamp(starOn * flick + starFlash + flare * 0.7, 0, 2.6);
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = 1;
    {
      const x = LX(STAR[0]),
        y = LY(STAR[1]);
      const r = S * 0.07 * (0.7 + 0.3 * starGlow);
      const sg2 = c.createRadialGradient(x, y, 0, x, y, r);
      sg2.addColorStop(0, `rgba(255,248,220,${0.8 * clamp(starGlow)})`);
      sg2.addColorStop(0.2, `rgba(255,200,90,${0.5 * clamp(starGlow)})`);
      sg2.addColorStop(0.55, `rgba(255,140,30,${0.18 * clamp(starGlow)})`);
      sg2.addColorStop(1, 'rgba(255,110,0,0)');
      c.fillStyle = sg2;
      c.fillRect(x - r, y - r, r * 2, r * 2);

      const streak = 0.22 * starOn + starFlash * 0.8 + flare;
      if (streak > 0.01) {
        const len = S * (0.14 + 0.16 * clamp(starFlash + flare));
        // horizontal and vertical arms, the vertical one a little shorter
        for (const [sx, sy, k] of [
          [1, 0.06, 1],
          [0.06, 1, 0.75],
        ] as const) {
          c.save();
          c.translate(x, y);
          c.scale(sx, sy);
          const sr = len * k;
          const stg = c.createRadialGradient(0, 0, 0, 0, 0, sr);
          stg.addColorStop(0, `rgba(255,240,200,${clamp(streak) * 0.9})`);
          stg.addColorStop(0.4, `rgba(255,170,60,${clamp(streak) * 0.3})`);
          stg.addColorStop(1, 'rgba(255,120,0,0)');
          c.fillStyle = stg;
          c.fillRect(-sr, -sr, sr * 2, sr * 2);
          c.restore();
        }
      }
    }

    // intro shockwave + flash
    if (t < INTRO_SECONDS) {
      const k = clamp((t - 1.05) / 1.1);
      if (k > 0 && k < 1) {
        c.globalCompositeOperation = 'lighter';
        c.globalAlpha = (1 - k) * 0.9;
        c.strokeStyle = 'rgba(255,200,100,1)';
        c.lineWidth = S * 0.012 * (1 - k) + 1;
        c.beginPath();
        c.arc(cx, cy, S * (0.12 + 0.62 * easeOut(k)), 0, TAU);
        c.stroke();
      }
      const fl = boom * 0.16;
      if (fl > 0.003) {
        c.globalCompositeOperation = 'lighter';
        c.globalAlpha = fl;
        c.fillStyle = 'rgb(255,210,140)';
        c.fillRect(0, 0, S, S);
      }
    }

    // embers
    c.globalCompositeOperation = 'lighter';
    for (const e of EMBERS) {
      const u = mod((e.k * tau) / LOOP_SECONDS + e.ph, 1);
      const env = Math.sin(Math.PI * u);
      const a = env * ambient * (0.45 + 0.55 * e.hot);
      if (a < 0.02) continue;
      const x = (e.x + e.sway * Math.sin((TAU * e.m * tau) / LOOP_SECONDS + e.sph)) * S;
      const y = (e.y0 - u * e.rise) * S;
      const r = e.r * S * 0.012 * (0.6 + 0.4 * env);
      c.globalAlpha = a;
      c.drawImage(sprite, x - r, y - r, r * 2, r * 2);
    }

    // fade the square's edges to transparent so it blends into the splash background
    c.globalCompositeOperation = 'destination-in';
    c.globalAlpha = 1;
    const vg = c.createRadialGradient(cx, cy, S * 0.41, cx, cy, S * 0.5);
    vg.addColorStop(0, 'rgba(0,0,0,1)');
    vg.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = vg;
    c.fillRect(0, 0, S, S);
    c.globalCompositeOperation = 'source-over';
  }

  return { render };
}
