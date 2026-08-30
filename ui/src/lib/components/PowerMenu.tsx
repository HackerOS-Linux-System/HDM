import { createSignal, onCleanup, For, Show } from 'solid-js';
import { Power, RefreshCcw, Moon, HardDrive, X } from 'lucide-solid';
import { assertRequiredFns } from '../utils/propValidation';
import type { PowerAction } from '../types';

interface PowerMenuProps {
  onAction: (action: PowerAction) => void;
  onClose: () => void;
}

const ACTIONS = [
  {
    action: 'shutdown' as PowerAction,
    label: 'Shut Down',
    Icon: Power,
    color: '#ef4444',
    glow: 'rgba(239,68,68,0.3)',
    description: 'Power off the system',
  },
  {
    action: 'reboot' as PowerAction,
    label: 'Restart',
    Icon: RefreshCcw,
    color: '#f59e0b',
    glow: 'rgba(245,158,11,0.3)',
    description: 'Reboot the system',
  },
  {
    action: 'suspend' as PowerAction,
    label: 'Suspend',
    Icon: Moon,
    color: '#3b82f6',
    glow: 'rgba(59,130,246,0.3)',
    description: 'Sleep — resume quickly',
  },
  {
    action: 'hibernate' as PowerAction,
    label: 'Hibernate',
    Icon: HardDrive,
    color: '#8b5cf6',
    glow: 'rgba(139,92,246,0.3)',
    description: 'Save state to disk',
  },
] as const;

export default function PowerMenu(props: PowerMenuProps) {
  // One-time setup-time check, not a reactive read — see PatternLock for
  // the same pattern and rationale.
  // eslint-disable-next-line solid/reactivity
  assertRequiredFns('PowerMenu', { onAction: props.onAction, onClose: props.onClose });

  const [confirming, setConfirming] = createSignal<PowerAction | null>(null);
  const [countdown, setCountdown] = createSignal(5);
  let timer: ReturnType<typeof setInterval> | undefined;

  function handleSelect(action: PowerAction) {
    setConfirming(action);
    setCountdown(5);
    clearInterval(timer);
    timer = setInterval(() => {
      const next = countdown() - 1;
      setCountdown(next);
      if (next <= 0) {
        clearInterval(timer);
        props.onAction(action);
      }
    }, 1000);
  }

  function cancel() {
    clearInterval(timer);
    setConfirming(null);
  }

  onCleanup(() => clearInterval(timer));

  const selected = () => ACTIONS.find((a) => a.action === confirming());

  function hoverIn(e: MouseEvent, color: string, glow: string) {
    const el = e.currentTarget as HTMLElement;
    const rgb = color
      .slice(1)
      .match(/../g)!
      .map((x) => parseInt(x, 16))
      .join(',');
    el.style.background = `rgba(${rgb},0.08)`;
    el.style.borderColor = `${color}40`;
    el.style.boxShadow = `0 0 24px ${glow}`;
  }
  function hoverOut(e: MouseEvent) {
    const el = e.currentTarget as HTMLElement;
    el.style.background = 'rgba(8,20,45,0.6)';
    el.style.borderColor = 'rgba(255,255,255,0.06)';
    el.style.boxShadow = 'none';
  }

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center"
      style="background:rgba(2,8,18,0.8); backdrop-filter:blur(20px);"
      onClick={() => props.onClose()}
    >
      <div
        class="relative glass-card rounded-3xl p-8 w-96 animate-scale-in"
        onClick={(e) => e.stopPropagation()}
        style="border:1px solid rgba(59,130,246,0.2);"
      >
        <button
          onClick={() => props.onClose()}
          class="absolute top-4 right-4 p-2 hdm-btn-ghost rounded-xl"
        >
          <X size={16} />
        </button>

        <Show
          when={selected()}
          fallback={
            <>
              <h2
                class="text-center text-white mb-2"
                style="font-family:'Oxanium', monospace; font-size:1.25rem; font-weight:400;"
              >
                Power Options
              </h2>
              <p class="text-center text-slate-500 text-sm mb-8">Choose an action</p>
              <div class="grid grid-cols-2 gap-3">
                <For each={ACTIONS}>
                  {(item) => {
                    const Icon = item.Icon;
                    return (
                      <button
                        onClick={() => handleSelect(item.action)}
                        class="group flex flex-col items-center gap-3 p-5 rounded-2xl transition-all duration-200"
                        style="background:rgba(8,20,45,0.6); border:1px solid rgba(255,255,255,0.06);"
                        onMouseEnter={(e) => hoverIn(e, item.color, item.glow)}
                        onMouseLeave={hoverOut}
                      >
                        <Icon
                          size={28}
                          class="text-slate-500 group-hover:scale-110 transition-all"
                        />
                        <div>
                          <div class="text-slate-300 text-sm font-medium group-hover:text-white transition-colors">
                            {item.label}
                          </div>
                          <div class="text-slate-600 text-xs mt-0.5">{item.description}</div>
                        </div>
                      </button>
                    );
                  }}
                </For>
              </div>
            </>
          }
        >
          {(sel) => {
            const Icon = sel().Icon;
            return (
              <div class="text-center">
                <div
                  class="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6"
                  style={`background:radial-gradient(circle, ${sel().glow} 0%, transparent 70%); border:2px solid ${sel().color}30;`}
                >
                  <Icon
                    size={36}
                    color={sel().color}
                    style={`filter:drop-shadow(0 0 8px ${sel().color});`}
                  />
                </div>
                <div
                  class="text-6xl font-light tabular-nums mb-2"
                  style={`font-family:'Oxanium', monospace; color:${sel().color};`}
                >
                  {countdown()}
                </div>
                <p class="text-slate-300 mb-1 text-lg">{sel().label}ing…</p>
                <p class="text-slate-500 text-sm mb-8">{sel().description}</p>
                <button
                  onClick={cancel}
                  class="hdm-btn-ghost px-8 py-3 rounded-xl text-sm font-medium"
                >
                  Cancel
                </button>
              </div>
            );
          }}
        </Show>
      </div>
    </div>
  );
}
