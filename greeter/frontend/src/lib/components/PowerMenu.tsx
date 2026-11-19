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
    description: 'Power off the system',
  },
  {
    action: 'reboot' as PowerAction,
    label: 'Restart',
    Icon: RefreshCcw,
    color: '#f59e0b',
    description: 'Reboot the system',
  },
  {
    action: 'suspend' as PowerAction,
    label: 'Suspend',
    Icon: Moon,
    color: '#d4d4d8',
    description: 'Sleep — resume quickly',
  },
  {
    action: 'hibernate' as PowerAction,
    label: 'Hibernate',
    Icon: HardDrive,
    color: '#8b5cf6',
    description: 'Save state to disk',
  },
] as const;

export default function PowerMenu(props: PowerMenuProps) {
  // Jednorazowe sprawdzenie przy tworzeniu — ten sam wzorzec i uzasadnienie co w PatternLock.
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

  return (
    <div class="overlay" onClick={() => props.onClose()}>
      <div class="card power-card" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => props.onClose()}
          class="btn btn-ghost power-close"
          aria-label="Close"
        >
          <X size={16} />
        </button>

        <Show
          when={selected()}
          fallback={
            <>
              <h2 class="power-title">Power Options</h2>
              <p class="power-subtitle">Choose an action</p>
              <div class="power-grid">
                <For each={ACTIONS}>
                  {(item) => {
                    const Icon = item.Icon;
                    return (
                      <button
                        onClick={() => handleSelect(item.action)}
                        class={`power-tile power-tile-${item.action}`}
                      >
                        <Icon size={28} class="power-tile-icon" />
                        <div>
                          <div class="power-tile-label">{item.label}</div>
                          <div class="power-tile-desc">{item.description}</div>
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
              <div class="power-confirm">
                <div
                  class="power-confirm-icon"
                  style={`border:2px solid ${sel().color}; background:${sel().color}22;`}
                >
                  <Icon size={36} color={sel().color} />
                </div>
                <div class="power-countdown" style={`color:${sel().color};`}>
                  {countdown()}
                </div>
                <p class="power-confirm-title">{sel().label}ing…</p>
                <p class="power-confirm-desc">{sel().description}</p>
                <button onClick={cancel} class="btn btn-ghost power-cancel">
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
