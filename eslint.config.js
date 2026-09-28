// Root ESLint flat config (ESM). Shared by every workspace via `eslint --config ../../eslint.config.js src`.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/.next',
      '**/coverage',
      '**/generated',
      '**/playwright-report',
      '**/test-results',
      '**/*.config.js',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: [
      'apps/dashboard/**/*.{ts,tsx}',
      'apps/web/**/*.{ts,tsx}',
      'packages/ui/**/*.{ts,tsx}',
      // Compiled directly to browser-loaded <script> files (Twitch Extension panel — no framework, no bundler
      // per Twitch's review rules) rather than run through Next.js like the other browser-globals entries above.
      'apps/twitch-extension/**/*.ts',
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  eslintConfigPrettier,
);
