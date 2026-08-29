import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import SessionPicker from './SessionPicker';
import type { SessionInfo } from '../types';

const sessions: SessionInfo[] = [
  {
    id: 'blue-environment',
    name: 'Blue Environment',
    exec: '/usr/bin/blue',
    session_type: 'wayland',
    desktop_names: ['Blue'],
    comment: 'Blue Environment Wayland Desktop',
  },
  {
    id: 'openbox',
    name: 'Openbox',
    exec: 'openbox-session',
    session_type: 'x11',
    desktop_names: ['Openbox'],
    comment: undefined,
  },
];

describe('<SessionPicker />', () => {
  it('renders one row per session with its name', () => {
    render(() => <SessionPicker sessions={sessions} selected="blue-environment" onSelect={() => {}} />);
    expect(screen.getByText('Blue Environment')).toBeInTheDocument();
    expect(screen.getByText('Openbox')).toBeInTheDocument();
  });

  it('labels wayland sessions WL and x11 sessions X11', () => {
    render(() => <SessionPicker sessions={sessions} selected="blue-environment" onSelect={() => {}} />);
    expect(screen.getByText('WL')).toBeInTheDocument();
    expect(screen.getByText('X11')).toBeInTheDocument();
  });

  it('calls onSelect with the session id when a row is clicked', () => {
    const onSelect = vi.fn();
    render(() => <SessionPicker sessions={sessions} selected="blue-environment" onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Openbox'));
    expect(onSelect).toHaveBeenCalledWith('openbox');
  });

  it('omits the comment line when a session has none', () => {
    render(() => <SessionPicker sessions={sessions} selected="blue-environment" onSelect={() => {}} />);
    expect(screen.queryByText('undefined')).not.toBeInTheDocument();
  });
});
