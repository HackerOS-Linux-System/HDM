import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import PowerMenu from './PowerMenu';

describe('<PowerMenu />', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows all four power actions initially', () => {
    render(() => <PowerMenu onAction={() => {}} onClose={() => {}} />);
    expect(screen.getByText('Shut Down')).toBeInTheDocument();
    expect(screen.getByText('Restart')).toBeInTheDocument();
    expect(screen.getByText('Suspend')).toBeInTheDocument();
    expect(screen.getByText('Hibernate')).toBeInTheDocument();
  });

  it('calls onClose when the backdrop is clicked', () => {
    const onClose = vi.fn();
    render(() => <PowerMenu onAction={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByText('Power Options').closest('[class*="fixed"]')!);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a countdown confirmation after selecting an action', () => {
    render(() => <PowerMenu onAction={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Shut Down'));
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('calls onAction once the countdown reaches zero', () => {
    const onAction = vi.fn();
    render(() => <PowerMenu onAction={onAction} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Restart'));

    vi.advanceTimersByTime(5000);

    expect(onAction).toHaveBeenCalledWith('reboot');
  });

  it('cancels the countdown and returns to the action grid', () => {
    const onAction = vi.fn();
    render(() => <PowerMenu onAction={onAction} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Suspend'));
    fireEvent.click(screen.getByText('Cancel'));

    vi.advanceTimersByTime(6000);

    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByText('Power Options')).toBeInTheDocument();
  });
});
