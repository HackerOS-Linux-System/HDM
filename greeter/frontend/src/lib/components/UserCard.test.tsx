import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import UserCard from './UserCard';
import type { UserInfo } from '../types';

const user: UserInfo = {
  username: 'michal',
  realname: 'Michał Kowalski',
  uid: 1000,
  home: '/home/michal',
  shell: '/bin/bash',
  icon_path: undefined,
  last_session: undefined,
};

describe('<UserCard />', () => {
  it('renders the real name and username', () => {
    render(() => <UserCard user={user} onClick={() => {}} />);
    expect(screen.getByText('Michał Kowalski')).toBeInTheDocument();
    expect(screen.getByText('michal')).toBeInTheDocument();
  });

  it('falls back to initials when no avatar is provided', () => {
    render(() => <UserCard user={user} onClick={() => {}} />);
    // "Michał Kowalski" -> "MK"
    expect(screen.getByText('MK')).toBeInTheDocument();
  });

  it('renders an <img> instead of initials when avatarData is provided', () => {
    render(() => (
      <UserCard user={user} avatarData="data:image/png;base64,AAAA" onClick={() => {}} />
    ));
    const img = screen.getByAltText('michal') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toContain('data:image/png;base64,AAAA');
    expect(screen.queryByText('MK')).not.toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(() => <UserCard user={user} onClick={onClick} />);
    fireEvent.click(screen.getByText('Michał Kowalski'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('single-word usernames still produce an initial (no crash on empty realname)', () => {
    const oneName: UserInfo = { ...user, realname: 'guest' };
    render(() => <UserCard user={oneName} onClick={() => {}} />);
    expect(screen.getByText('G')).toBeInTheDocument();
  });
});
