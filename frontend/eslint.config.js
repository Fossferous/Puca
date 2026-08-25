import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Ignore build output and generated/native trees so `npm run lint` reports
  // only real source. `android`/`ios` (Capacitor) and `src-tauri` (Rust + its
  // `target/` build dir and `gen/` bindings) hold generated files that would
  // otherwise bury the handful of genuine issues under hundreds of parse errors.
  globalIgnores(['dist', 'src/wasm/df', 'df-wasm', 'android', 'ios', 'src-tauri']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Underscore prefix = intentionally unused (params that must exist
      // positionally, deliberately-ignored destructured values, etc.).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
])
