import '@testing-library/jest-dom/vitest';
import { cleanup } from '@solidjs/testing-library';
import { afterEach } from 'vitest';

// @solidjs/testing-library nie sprząta DOM-u między testami samo — bez tego nasłuchy i timery
// (onMount) z jednego testu przeciekają do następnego.
afterEach(() => {
  cleanup();
  // testy mostu Silvera ustawiają globalne `silver`; nie może zostać do następnego testu
  delete (globalThis as { silver?: unknown }).silver;
});
