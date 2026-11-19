import { Show } from 'solid-js';
import { assertRequiredFns } from '../utils/propValidation';
import type { UserInfo } from '../types';

interface UserCardProps {
  user: UserInfo;
  isSelected?: boolean;
  /** Ścieżka pliku awatara (<img src>) albo undefined. */
  avatarData?: string;
  onClick: () => void;
}

export default function UserCard(props: UserCardProps) {
  // Jednorazowe sprawdzenie przy tworzeniu, nie odczyt reaktywny — patrz PatternLock.tsx.
  // eslint-disable-next-line solid/reactivity
  assertRequiredFns('UserCard', { onClick: props.onClick });

  const initials = () =>
    props.user.realname
      .split(' ')
      .map((w) => w[0] || '')
      .slice(0, 2)
      .join('')
      .toUpperCase() || props.user.username[0].toUpperCase();

  return (
    <button
      onClick={() => props.onClick()}
      class={`user-card ${props.isSelected ? 'selected' : ''}`}
    >
      <div class="user-card-avatar-wrap">
        <Show when={props.avatarData} fallback={<div class="avatar avatar-md">{initials()}</div>}>
          <img
            src={props.avatarData}
            alt={props.user.username}
            class="avatar avatar-md avatar-img"
          />
        </Show>

        <Show when={props.isSelected}>
          <div class="check-badge">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path
                d="M2 5L4 7L8 3"
                stroke="white"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
        </Show>
      </div>

      <div class="user-card-names">
        <div class="user-card-realname">{props.user.realname}</div>
        <div class="user-card-username">{props.user.username}</div>
      </div>
    </button>
  );
}
