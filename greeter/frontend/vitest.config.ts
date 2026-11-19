import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // solid-js musi się rozwiązywać do wersji przeglądarkowej (nie serwerowej), inaczej reaktywność
    // w testach po cichu nie działa — zgodnie z oficjalnym setupem @solidjs/testing-library.
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
