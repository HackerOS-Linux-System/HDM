import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@solidjs/testing-library';
import App from './App';

// Background.tsx drives a requestAnimationFrame particle loop that has no
// bearing on the auth/navigation flow under test and doesn't play well
// with jsdom + fake timers, so it's stubbed out at the module boundary.
vi.mock('./lib/components/Background', () => ({
  default: () => <div data-testid="background-stub" />,
}));

describe('<App /> smoke test', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the connecting screen first, then the user list once the daemon "connects"', async () => {
    render(() => <App />);

    expect(screen.getByText(/Connecting to BEDM daemon/i)).toBeInTheDocument();

    // init()'s BedmBridge.connectDaemon() mock resolves after 600ms, then
    // getUsers/getSessions/getWallpaper resolve after another ~200ms.
    await vi.advanceTimersByTimeAsync(1000);

    await waitFor(() => {
      expect(screen.getByText('Select User')).toBeInTheDocument();
    });

    // MOCK_USERS in tauri.ts includes "Michał Kowalski".
    expect(screen.getByText('Michał Kowalski')).toBeInTheDocument();
  });
});
