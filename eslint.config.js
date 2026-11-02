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
  {
    // Logging guard: a caught error must never be logged below `warn`, or Railway's level filter hides it, and
    // it must carry the error object itself (`{ err }`) so pino's err serializer records type, message, stack and
    // code. Tests are exempt (they assert on logger calls and fake errors freely). Any future
    // `no-restricted-syntax` entries for these files must be merged into this list, not added as a later override.
    files: ['**/src/**/*.{ts,tsx}', '**/scripts/**/*.ts'],
    ignores: ['**/*.{test,spec}.{ts,tsx}', '**/__tests__/**', '**/test/**', '**/tests/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // logger.info/debug/trace(...) anywhere inside a catch block. Matches `logger`, `ctx.logger`,
          // `this.ctx.logger`, `request.log`, `app.log`, `deps.logger`, ...
          selector:
            'CatchClause CallExpression[callee.property.name=/^(info|debug|trace)$/]:matches([callee.object.name=/log/i], [callee.object.property.name=/log/i])',
          message:
            'Log caught errors at warn or error, with the error object as err: logger.warn({ err }, "...") (info/debug/trace are hidden by the production log level).',
        },
        {
          // logger.info/debug/trace(...) inside the callback of `.catch(...)`.
          selector:
            'CallExpression[callee.property.name="catch"] > :function CallExpression[callee.property.name=/^(info|debug|trace)$/]:matches([callee.object.name=/log/i], [callee.object.property.name=/log/i])',
          message:
            'Log caught errors at warn or error, with the error object as err: .catch((err) => logger.warn({ err }, "...")) (info/debug/trace are hidden by the production log level).',
        },
        {
          // logger.info/debug/trace({ err | error, ... }, ...): an error payload at a non-error level.
          selector:
            'CallExpression[callee.property.name=/^(info|debug|trace)$/]:matches([callee.object.name=/log/i], [callee.object.property.name=/log/i]) > ObjectExpression > Property[key.name=/^(err|error)$/]',
          message:
            'Log caught errors at warn or error, with the error object as err: an err/error payload does not belong in info/debug/trace.',
        },
        {
          // logger.<level>({ err: <something>.message | String(...) | ... }): pass the error object itself so
          // pino records type, message, stack and code.
          selector:
            'CallExpression[callee.property.name=/^(fatal|error|warn)$/]:matches([callee.object.name=/log/i], [callee.object.property.name=/log/i]) > ObjectExpression > Property[key.name="err"][shorthand=false]:matches([value.type="MemberExpression"][value.property.name="message"], [value.type="ConditionalExpression"], [value.type="CallExpression"][value.callee.name="String"])',
          message:
            'Pass the error object itself as err ({ err }), not its message or String(err), so pino logs the stack and code.',
        },
      ],
    },
  },
  eslintConfigPrettier,
);
