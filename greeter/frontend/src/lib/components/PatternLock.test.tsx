import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import PatternLock from './PatternLock';

// Silver nie ma zdarzeń pointer*/mousemove — gest to mousedown na punkcie, mouseenter na kolejnych
// i mouseup na window (albo seria pojedynczych kliknięć + „Confirm”).
const dot = (i: number) => screen.getByTestId(`dot-${i}`);

function drag(indices: number[]) {
  fireEvent.mouseDown(dot(indices[0]));
  for (const i of indices.slice(1)) fireEvent.mouseEnter(dot(i));
  fireEvent.mouseUp(window);
}

describe('<PatternLock />', () => {
  it('renders nine dots', () => {
    render(() => <PatternLock onComplete={() => {}} />);
    for (let i = 0; i < 9; i++) expect(dot(i)).toBeInTheDocument();
  });

  it('calls onComplete with the visited dot indices for a valid (>=4 dot) drag', () => {
    const onComplete = vi.fn();
    render(() => <PatternLock onComplete={onComplete} />);
    drag([0, 1, 2, 4]);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith([0, 1, 2, 4]);
  });

  it('does not add the same dot twice', () => {
    const onComplete = vi.fn();
    render(() => <PatternLock onComplete={onComplete} />);
    fireEvent.mouseDown(dot(0));
    fireEvent.mouseEnter(dot(1));
    fireEvent.mouseEnter(dot(1));
    fireEvent.mouseEnter(dot(0));
    fireEvent.mouseEnter(dot(2));
    fireEvent.mouseEnter(dot(5));
    fireEvent.mouseUp(window);
    expect(onComplete).toHaveBeenCalledWith([0, 1, 2, 5]);
  });

  it('does not call onComplete for a drag shorter than 4 dots', () => {
    const onComplete = vi.fn();
    render(() => <PatternLock onComplete={onComplete} />);
    drag([0, 1, 2]);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('ignores mouse input while disabled', () => {
    const onComplete = vi.fn();
    render(() => <PatternLock onComplete={onComplete} disabled />);
    drag([0, 1, 2, 4]);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('ignores mouseenter when no gesture is in progress', () => {
    const onComplete = vi.fn();
    render(() => <PatternLock onComplete={onComplete} />);
    fireEvent.mouseEnter(dot(0));
    fireEvent.mouseEnter(dot(1));
    fireEvent.mouseUp(window);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('supports a tap sequence: single clicks on dots, then Confirm', () => {
    const onComplete = vi.fn();
    render(() => <PatternLock onComplete={onComplete} />);
    for (const i of [0, 1, 2, 4]) {
      fireEvent.mouseDown(dot(i));
      fireEvent.mouseUp(window);
    }
    expect(onComplete).not.toHaveBeenCalled(); // czeka na potwierdzenie
    fireEvent.click(screen.getByText('Confirm'));
    expect(onComplete).toHaveBeenCalledWith([0, 1, 2, 4]);
  });

  it('keeps Confirm disabled below 4 dots and Clear resets the tap sequence', () => {
    const onComplete = vi.fn();
    render(() => <PatternLock onComplete={onComplete} />);
    for (const i of [0, 1]) {
      fireEvent.mouseDown(dot(i));
      fireEvent.mouseUp(window);
    }
    expect(screen.getByText('Confirm')).toBeDisabled();
    fireEvent.click(screen.getByText('Clear'));
    expect(screen.queryByText('Confirm')).toBeNull();
    drag([3, 4, 5, 8]);
    expect(onComplete).toHaveBeenCalledWith([3, 4, 5, 8]);
  });
});
