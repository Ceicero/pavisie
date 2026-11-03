'use client';

import * as React from 'react';
import brand from '../../data/brand.json';
import {
  INTRO_DURATION_MS,
  INTRO_FADE_MS,
  INTRO_REDUCED_MOTION_MS,
  INTRO_SKIP_ATTRIBUTE,
  INTRO_SKIP_VALUE,
  INTRO_STORAGE_KEY,
} from './intro-config';
import { INTRO_SECONDS, createLogoRenderer } from './logo-renderer';

/**
 * Full-screen branded intro: the animated skull-and-laurel logo, the gold wordmark and a progress
 * line, shown on the first page load of a browser session for `INTRO_DURATION_MS`, then faded out.
 *
 * It is server-rendered as part of the root layout, so it covers the page from first paint rather
 * than popping in after hydration. The inline boot script in `app/layout.tsx` (`INTRO_BOOT_SCRIPT`)
 * hides it before paint for repeat visits in the same session and for automated browsers. While it
 * is up, `.site-content` is `inert` and page scrolling is locked; both are restored when it ends.
 * If JavaScript never runs, a CSS failsafe in globals.css fades it out after a few seconds anyway.
 */
export function IntroSplash() {
  const [done, setDone] = React.useState(false);
  if (done || !brand.logo) return null;
  return <IntroOverlay logoSrc={brand.logo} onDone={() => setDone(true)} />;
}

type Phase = 'booting' | 'playing' | 'leaving';

function IntroOverlay({ logoSrc, onDone }: { logoSrc: string; onDone: () => void }) {
  const [phase, setPhase] = React.useState<Phase>('booting');
  const [durationMs, setDurationMs] = React.useState(INTRO_DURATION_MS);
  const [staticLogo, setStaticLogo] = React.useState(false);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const onDoneRef = React.useRef(onDone);
  onDoneRef.current = onDone;

  const finish = React.useCallback(() => setPhase('leaving'), []);

  // Start: decide whether to play, lock the page behind the splash, run the animation and timer.
  React.useEffect(() => {
    const root = document.documentElement;
    if (root.getAttribute(INTRO_SKIP_ATTRIBUTE) === INTRO_SKIP_VALUE) {
      onDoneRef.current();
      return;
    }
    try {
      window.sessionStorage.setItem(INTRO_STORAGE_KEY, '1');
    } catch {
      // Storage blocked: the intro just plays again on the next load.
    }

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const total = reduceMotion ? INTRO_REDUCED_MOTION_MS : INTRO_DURATION_MS;
    setDurationMs(total);
    setPhase('playing');

    const content = document.querySelector('.site-content');
    content?.setAttribute('inert', '');
    const prevOverflow = root.style.overflow;
    root.style.overflow = 'hidden';

    const timer = window.setTimeout(finish, total);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
    };
    window.addEventListener('keydown', onKey);

    let raf = 0;
    let stopped = false;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const canvas = canvasRef.current;
      if (stopped || !canvas) return;
      let renderer: ReturnType<typeof createLogoRenderer>;
      try {
        renderer = createLogoRenderer(canvas, img);
      } catch {
        setStaticLogo(true);
        return;
      }
      const start = performance.now();
      const frame = () => {
        if (stopped) return;
        const px = Math.round(canvas.clientWidth * Math.min(window.devicePixelRatio || 1, 2));
        if (px > 0 && canvas.width !== px) {
          canvas.width = px;
          canvas.height = px;
        }
        // Reduced motion: one settled frame, no animation loop.
        renderer.render(reduceMotion ? INTRO_SECONDS + 1 : (performance.now() - start) / 1000);
        if (!reduceMotion) raf = requestAnimationFrame(frame);
      };
      frame();
    };
    img.onerror = () => setStaticLogo(true);
    img.src = logoSrc;

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
      content?.removeAttribute('inert');
      root.style.overflow = prevOverflow;
    };
  }, [finish, logoSrc]);

  // End: let the fade-out run, then unmount (which runs the cleanup above).
  React.useEffect(() => {
    if (phase !== 'leaving') return;
    const t = window.setTimeout(() => onDoneRef.current(), INTRO_FADE_MS);
    return () => window.clearTimeout(t);
  }, [phase]);

  return (
    <div
      className="intro-splash"
      data-state={phase}
      role="dialog"
      aria-modal="true"
      aria-label="Pavisie intro"
      style={{ '--intro-duration': `${durationMs}ms` } as React.CSSProperties}
    >
      <div className="intro-splash__stage">
        <canvas ref={canvasRef} className="intro-splash__canvas" aria-hidden="true" />
        {staticLogo && (
          // Fallback when the canvas can't read the logo: the plain image, still centred.
          <img src={logoSrc} alt="" className="intro-splash__static" />
        )}
      </div>
      <p className="intro-splash__wordmark" aria-hidden="true">
        Pavisie
      </p>
      <div className="intro-splash__progress" aria-hidden="true">
        <span />
      </div>
      <button type="button" className="intro-splash__skip" onClick={finish}>
        Skip intro
      </button>
    </div>
  );
}
