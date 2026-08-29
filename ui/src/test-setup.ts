import '@testing-library/jest-dom/vitest';
import { cleanup } from '@solidjs/testing-library';
import { afterEach } from 'vitest';

// jsdom has no PointerEvent implementation at all (as of the jsdom version
// pulled in transitively here) — without this, any test that simulates
// pointer input (PatternLock's drag-to-draw gesture) fails with
// "ReferenceError: PointerEvent is not defined" before it even gets to
// assert anything. MouseEvent is a reasonable base since jsdom's MouseEvent
// already carries clientX/clientY; pointerId/pointerType are added on top
// since PatternLock's handlers read `e.pointerId`.
if (typeof (globalThis as any).PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    public pointerId: number;
    public pointerType: string;

    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? 'mouse';
    }
  }
  (globalThis as any).PointerEvent = PointerEventPolyfill;
}

// @solidjs/testing-library doesn't auto-cleanup between tests the way
// @testing-library/react's setup does — without this, DOM from one test
// (event listeners, timers created by onMount) leaks into the next.
afterEach(() => {
  cleanup();
});
