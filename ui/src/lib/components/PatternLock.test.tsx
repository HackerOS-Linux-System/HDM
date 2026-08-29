import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@solidjs/testing-library';
import PatternLock from './PatternLock';

// jsdom doesn't implement pointer capture or layout (getBoundingClientRect
// always returns zeros), so both are stubbed here purely so pointer events
// can be simulated deterministically in a headless test environment.
beforeEach(() => {
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  SVGElement.prototype.getBoundingClientRect = vi.fn(() => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 260,
    bottom: 260,
    width: 260,
    height: 260,
    toJSON: () => {},
  }));
});

function firePointer(el: Element, type: string, clientX: number, clientY: number) {
  el.dispatchEvent(new PointerEvent(type, { clientX, clientY, bubbles: true, cancelable: true, pointerId: 1 }));
}

// Dot centers for the default 3x3 grid (PAD=40, STEP=90) mirror the
// component's internal constants — kept in sync here deliberately since
// they aren't exported (the grid geometry is an implementation detail).
const DOT = (row: number, col: number) => ({ x: 40 + col * 90, y: 40 + row * 90 });

describe('<PatternLock />', () => {
  it('renders a 3x3 grid of 9 dots', () => {
    const { container } = render(() => <PatternLock onComplete={() => {}} />);
    // 9 dots + possible ring circles for active dots; at minimum 9 <circle>s exist.
    const circles = container.querySelectorAll('circle');
    expect(circles.length).toBeGreaterThanOrEqual(9);
  });

  it('calls onComplete with the visited dot indices for a valid (>=4 dot) pattern', () => {
    const onComplete = vi.fn();
    const { container } = render(() => <PatternLock onComplete={onComplete} />);
    const svg = container.querySelector('svg')!;

    const topLeft = DOT(0, 0);
    const topMid = DOT(0, 1);
    const topRight = DOT(0, 2);
    const midRight = DOT(1, 2);

    firePointer(svg, 'pointerdown', topLeft.x, topLeft.y);
    firePointer(svg, 'pointermove', topMid.x, topMid.y);
    firePointer(svg, 'pointermove', topRight.x, topRight.y);
    firePointer(svg, 'pointermove', midRight.x, midRight.y);
    firePointer(svg, 'pointerup', midRight.x, midRight.y);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith([0, 1, 2, 5]);
  });

  it('does not call onComplete for a pattern shorter than 4 dots', () => {
    const onComplete = vi.fn();
    const { container } = render(() => <PatternLock onComplete={onComplete} />);
    const svg = container.querySelector('svg')!;

    const topLeft = DOT(0, 0);
    const topMid = DOT(0, 1);

    firePointer(svg, 'pointerdown', topLeft.x, topLeft.y);
    firePointer(svg, 'pointermove', topMid.x, topMid.y);
    firePointer(svg, 'pointerup', topMid.x, topMid.y);

    expect(onComplete).not.toHaveBeenCalled();
  });

  it('ignores pointer input while disabled', () => {
    const onComplete = vi.fn();
    const { container } = render(() => <PatternLock disabled onComplete={onComplete} />);
    const svg = container.querySelector('svg')!;

    const topLeft = DOT(0, 0);
    const topRight = DOT(0, 2);

    firePointer(svg, 'pointerdown', topLeft.x, topLeft.y);
    firePointer(svg, 'pointermove', topRight.x, topRight.y);
    firePointer(svg, 'pointerup', topRight.x, topRight.y);

    expect(onComplete).not.toHaveBeenCalled();
  });
});
