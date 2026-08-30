import { Show } from 'solid-js';
import { assertRequiredFns } from '../utils/propValidation';
import type { UserInfo } from '../types';

interface UserCardProps {
  user: UserInfo;
  isSelected?: boolean;
  avatarData?: string;
  onClick: () => void;
}

export default function UserCard(props: UserCardProps) {
  // One-time setup-time check, not a reactive read — see PatternLock.tsx.
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
      class="group flex flex-col items-center gap-3 p-5 rounded-2xl transition-all duration-300 w-36"
      style={`
        background:${props.isSelected ? 'rgba(37,99,235,0.12)' : 'rgba(8,20,45,0.4)'};
        border:${props.isSelected ? '1px solid rgba(59,130,246,0.4)' : '1px solid rgba(255,255,255,0.05)'};
        box-shadow:${props.isSelected ? '0 0 32px rgba(59,130,246,0.15)' : 'none'};
        transform:${props.isSelected ? 'translateY(-2px)' : 'none'};
      `}
    >
      <div class="relative">
        <Show
          when={props.avatarData}
          fallback={
            <div
              class="w-16 h-16 rounded-full flex items-center justify-center text-white text-xl font-medium"
              style={`
                background:linear-gradient(135deg, #1d4ed8 0%, #7c3aed 100%);
                box-shadow:${props.isSelected ? '0 0 0 3px #3b82f6, 0 4px 20px rgba(59,130,246,0.4)' : '0 0 0 2px rgba(59,130,246,0.2), 0 4px 12px rgba(0,0,0,0.4)'};
                font-family:'DM Sans', sans-serif;
              `}
            >
              {initials()}
            </div>
          }
        >
          <img
            src={props.avatarData}
            alt={props.user.username}
            class="w-16 h-16 rounded-full object-cover"
            style={`box-shadow:${props.isSelected ? '0 0 0 3px #3b82f6, 0 4px 20px rgba(59,130,246,0.4)' : '0 0 0 2px rgba(59,130,246,0.2), 0 4px 12px rgba(0,0,0,0.4)'};`}
          />
        </Show>

        <Show when={props.isSelected}>
          <div
            class="absolute -bottom-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center"
            style="background:#3b82f6; box-shadow:0 0 8px rgba(59,130,246,0.8);"
          >
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

      <div class="text-center">
        <div
          class="text-sm font-medium truncate max-w-full"
          style={`color:${props.isSelected ? '#e2e8f0' : '#94a3b8'}; transition:color 0.2s;`}
        >
          {props.user.realname}
        </div>
        <div class="text-xs mt-0.5" style="color:#475569;">
          {props.user.username}
        </div>
      </div>
    </button>
  );
}
