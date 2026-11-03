/**
 * Settings shared by the intro splash (`IntroSplash.tsx`) and the inline boot script the root
 * layout renders ahead of it. Kept free of React and DOM imports so unit tests can load it.
 *
 * The splash is a deliberate branded intro, not a real loading indicator: it plays the animated
 * logo for `INTRO_DURATION_MS` on the first page load of a browser session, then fades away.
 * Visitors can end it early with the Skip button or Escape.
 */

/** sessionStorage key set once the intro has played in this tab's session. */
export const INTRO_STORAGE_KEY = 'pavisie:intro-seen';

/** Attribute the boot script puts on `<html>` when the intro should not show at all. */
export const INTRO_SKIP_ATTRIBUTE = 'data-intro';
export const INTRO_SKIP_VALUE = 'skip';

/** How long the intro stays up before fading out. */
export const INTRO_DURATION_MS = 8000;
/** Shorter, static intro for visitors who ask for reduced motion. */
export const INTRO_REDUCED_MOTION_MS = 2000;
/** Fade-out length; matches the `.intro-splash` opacity transition in globals.css. */
export const INTRO_FADE_MS = 600;

/**
 * Runs inline before first paint. Hides the splash (via CSS on `html[data-intro='skip']`) when the
 * intro already played this session, or when the browser is automated (`navigator.webdriver`, set
 * by Playwright and other test drivers) so e2e tests and tooling never wait behind it. Any storage
 * error (blocked storage, private modes) leaves the intro on, which is the safe direction: it
 * still ends on its own timer.
 */
export const INTRO_BOOT_SCRIPT =
  `(function(){try{var d=document.documentElement;` +
  `if(navigator.webdriver||window.sessionStorage.getItem(${JSON.stringify(INTRO_STORAGE_KEY)}))` +
  `d.setAttribute(${JSON.stringify(INTRO_SKIP_ATTRIBUTE)},${JSON.stringify(INTRO_SKIP_VALUE)});` +
  `}catch(e){}})();`;
