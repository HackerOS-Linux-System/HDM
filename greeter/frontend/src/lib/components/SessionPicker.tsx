import { For, Show } from 'solid-js';
import { Monitor, Globe } from 'lucide-solid';
import { assertRequiredFns } from '../utils/propValidation';
import type { SessionInfo } from '../types';

interface SessionPickerProps {
  sessions: SessionInfo[];
  selected: string;
  onSelect: (id: string) => void;
}

export default function SessionPicker(props: SessionPickerProps) {
  // Jednorazowe sprawdzenie przy tworzeniu, nie odczyt reaktywny — patrz PatternLock.tsx.
  // eslint-disable-next-line solid/reactivity
  assertRequiredFns('SessionPicker', { onSelect: props.onSelect });

  return (
    <div class="session-list">
      <For each={props.sessions}>
        {(session) => {
          const isSelected = () => session.id === props.selected;
          const isWayland = session.session_type === 'wayland';
          return (
            <button
              onClick={() => props.onSelect(session.id)}
              class={`session-card ${isSelected() ? 'selected' : ''}`}
            >
              <div class="session-icon">
                <Show when={isWayland} fallback={<Globe size={16} class="session-glyph" />}>
                  <Monitor size={16} class="session-glyph" />
                </Show>
              </div>

              <div class="session-text">
                <div class="session-name">{session.name}</div>
                <Show when={session.comment}>
                  <div class="session-comment">{session.comment}</div>
                </Show>
              </div>

              <span class={`badge ${isWayland ? 'badge-wl' : 'badge-x11'}`}>
                {isWayland ? 'WL' : 'X11'}
              </span>

              <Show when={isSelected()}>
                <div class="check-badge check-badge-inline">
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
            </button>
          );
        }}
      </For>
    </div>
  );
}
