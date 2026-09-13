import type { Config } from 'tailwindcss';
import { preset } from '@pavisie/ui/tailwind.preset';

// The dashboard (formerly apps/dashboard, now apps/web/src/app/dashboard/**) brought its
// `@pavisie/ui` component library and shadcn-style tokens (`bg-background`, `text-foreground`,
// `border-border`, ...) with it — this preset supplies those, scanning `packages/ui/src` below.
// Marketing pages are untouched: they keep using the site's own `ink`/`grey`/`paper`/`gold` tokens
// defined below and in `src/app/globals.css` (ARCHITECTURE.md §17 / §20), which the preset's
// tokens don't overlap with (different color keys entirely), so both systems coexist without
// either one clobbering the other. `darkMode: 'class'` matches the preset (dashboard theme
// toggle uses `next-themes` `attribute="class"`); the marketing look is dark-by-default via plain
// CSS (`html[data-theme='light']` overrides in globals.css), not Tailwind's `dark:` variant, so it
// is unaffected either way.
const config: Config = {
  presets: [preset],
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          0: 'var(--ink-0)',
          1: 'var(--ink-1)',
          2: 'var(--ink-2)',
          3: 'var(--ink-3)',
          4: 'var(--ink-4)',
          5: 'var(--ink-5)',
          6: 'var(--ink-6)',
          7: 'var(--ink-7)',
        },
        grey: {
          1: 'var(--grey-1)',
          2: 'var(--grey-2)',
          3: 'var(--grey-3)',
          4: 'var(--grey-4)',
          5: 'var(--grey-5)',
          6: 'var(--grey-6)',
          7: 'var(--grey-7)',
        },
        paper: 'var(--paper)',
        gold: {
          1: 'hsl(var(--gold-1) / <alpha-value>)',
          2: 'hsl(var(--gold-2) / <alpha-value>)',
          3: 'hsl(var(--gold-3) / <alpha-value>)',
          4: 'hsl(var(--gold-4) / <alpha-value>)',
          5: 'hsl(var(--gold-5) / <alpha-value>)',
          6: 'hsl(var(--gold-6) / <alpha-value>)',
          7: 'hsl(var(--gold-7) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', '-apple-system', '"Segoe UI"', 'Inter', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
