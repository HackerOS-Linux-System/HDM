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
  // One-time setup-time check, not a reactive read — see PatternLock.tsx.
  // eslint-disable-next-line solid/reactivity
  assertRequiredFns('SessionPicker', { onSelect: props.onSelect });

  return (
    <div class="space-y-1.5 max-h-64 overflow-y-auto pr-1">
      <For each={props.sessions}>
        {(session) => {
          const isSelected = () => session.id === props.selected;
          const isWayland = session.session_type === 'wayland';
          return (
            <button
              onClick={() => props.onSelect(session.id)}
              class="w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 text-left group"
              style={`
                background:${isSelected() ? 'rgba(37,99,235,0.15)' : 'rgba(8,20,45,0.5)'};
                border:${isSelected() ? '1px solid rgba(59,130,246,0.4)' : '1px solid rgba(255,255,255,0.05)'};
              `}
            >
              <div
                class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                style={`background:${isSelected() ? 'rgba(59,130,246,0.2)' : 'rgba(255,255,255,0.05)'};`}
              >
                <Show when={isWayland} fallback={<Globe size={16} color={isSelected() ? '#60a5fa' : '#475569'} />}>
                  <Monitor size={16} color={isSelected() ? '#60a5fa' : '#475569'} />
                </Show>
              </div>

              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium truncate" style={`color:${isSelected() ? '#e2e8f0' : '#94a3b8'};`}>
                  {session.name}
                </div>
                <Show when={session.comment}>
                  <div class="text-xs truncate mt-0.5" style="color:#475569;">
                    {session.comment}
                  </div>
                </Show>
              </div>

              <span
                class="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                style={`
                  background:${isWayland ? 'rgba(59,130,246,0.15)' : 'rgba(249,115,22,0.15)'};
                  color:${isWayland ? '#93c5fd' : '#fdba74'};
                  border:${isWayland ? '1px solid rgba(59,130,246,0.2)' : '1px solid rgba(249,115,22,0.2)'};
                  font-family:'JetBrains Mono', monospace;
                `}
              >
                {isWayland ? 'WL' : 'X11'}
              </span>

              <Show when={isSelected()}>
                <div class="w-5 h-5 rounded-full flex items-center justify-center shrink-0" style="background:#3b82f6;">
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
