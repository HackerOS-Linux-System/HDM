import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import Clock from './Clock';

describe('<Clock />', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T14:05:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the current time as HH:MM on mount', () => {
    render(() => <Clock />);
    expect(screen.getByText('14:05')).toBeInTheDocument();
  });

  it('renders a human-readable date', () => {
    render(() => <Clock />);
    // Friday, August 28, 2026
    expect(screen.getByText(/August 28, 2026/)).toBeInTheDocument();
  });

  it('updates the displayed time once a minute passes', () => {
    render(() => <Clock />);
    expect(screen.getByText('14:05')).toBeInTheDocument();

    vi.setSystemTime(new Date('2026-08-28T14:06:00'));
    vi.advanceTimersByTime(1000);

    expect(screen.getByText('14:06')).toBeInTheDocument();
  });

  it('applies an extra class when provided', () => {
    const { container } = render(() => <Clock class="custom-class" />);
    expect(container.querySelector('.custom-class')).toBeTruthy();
  });
});
