import type { Config } from 'tailwindcss';
import { preset } from '@pavisie/ui/tailwind.preset';

const config: Config = {
  presets: [preset],
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
