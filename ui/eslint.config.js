import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import solid from 'eslint-plugin-solid';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'src-tauri/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { solid },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      ...solid.configs.recommended.rules,

      // solid/style-prop pushes toward `style={{...}}` object syntax over
      // `style="..."` strings. Both are fully valid Solid — this codebase
      // deliberately uses string styles everywhere (a carry-over from the
      // original Svelte template style bindings, and it keeps long
      // conditional style strings readable as template literals rather
      // than sprawling object literals). Left on, this single rule would
      // flag ~54 call sites that aren't bugs, drowning out the warnings
      // that are. Revisit if the codebase migrates to object styles.
      'solid/style-prop': 'off',

      // Common false positives in this codebase worth relaxing deliberately
      // rather than silencing per-line:
      '@typescript-eslint/no-explicit-any': 'off', // Tauri's invoke() and JSON IPC payloads are inherently untyped at the boundary.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off', // Used deliberately after `<Show when={...}>` narrows the value.

      // solid/reactivity catches the #1 Svelte-migration footgun: writing
      // `const { foo } = props` (which snapshots the value once, breaking
      // reactivity) instead of accessing `props.foo` at read time.
      'solid/reactivity': 'warn',
      'solid/no-destructure': 'error',
      'solid/jsx-no-undef': 'error',
      'solid/no-innerhtml': 'error',
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'vitest.config.ts', 'src/test-setup.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly',
      },
    },
  },
  prettier
);
