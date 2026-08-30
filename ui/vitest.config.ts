import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // solid-js needs its own conditions resolved for the *browser* (dev)
    // build rather than the server build when running under Vitest/Node,
    // or component reactivity silently breaks in tests. This mirrors the
    // official @solidjs/testing-library setup guidance.
    deps: {
      optimizer: {
        web: {
          include: ['solid-js'],
        },
      },
    },
  },
  resolve: {
    conditions: ['development', 'browser'],
  },
});
