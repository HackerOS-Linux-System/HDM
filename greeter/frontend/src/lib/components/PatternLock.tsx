import { createSignal, onMount, onCleanup, For, Show } from 'solid-js';
import { assertRequiredFns } from '../utils/propValidation';

interface PatternLockProps {
  disabled?: boolean;
  error?: boolean;
  onComplete: (pattern: number[]) => void;
}

const SIZE = 260;
const PAD = 40;
const STEP = (SIZE - PAD * 2) / 2;
const MIN_LENGTH = 4;
const HIT = 36; // średnica pola trafienia punktu (większa niż widoczna kropka)

const DOTS = Array.from({ length: 9 }, (_, i) => ({
  x: PAD + (i % 3) * STEP,
  y: PAD + Math.floor(i / 3) * STEP,
}));

/**
 * Wzór 3×3. Silver nie dostarcza zdarzeń pointer ani mousemove, więc gest oparto na zdarzeniach, które ma:
 *   - przeciągnięcie: mousedown na punkcie → mouseenter na kolejnych → mouseup (gdziekolwiek, na window);
 *   - stuknięcie: pojedyncze kliknięcia w kolejne punkty, potem „Confirm” (ekrany dotykowe / brak przeciągania).
 * Linie to obrócone <div>-y (transform: rotate) — bez dynamicznego SVG.
 */
export default function PatternLock(props: PatternLockProps) {
  // Jednorazowe sprawdzenie przy tworzeniu, nie odczyt reaktywny: onComplete to sposób obsługi
  // gestu przez rodzica, nie wartość zmieniająca się w czasie życia komponentu.
  // eslint-disable-next-line solid/reactivity
  assertRequiredFns('PatternLock', { onComplete: props.onComplete });

  const [path, setPath] = createSignal<number[]>([]);
  const [dragging, setDragging] = createSignal(false);
  const [tapMode, setTapMode] = createSignal(false);

  function finish() {
    const p = path();
    setTapMode(false);
    props.onComplete(p);
  }

  function clear() {
    setPath([]);
    setTapMode(false);
    setDragging(false);
  }

  function dotDown(i: number) {
    if (props.disabled) return;
    if (tapMode()) {
      if (!path().includes(i)) setPath([...path(), i]);
      return;
    }
    setPath([i]);
    setDragging(true);
  }

  function dotEnter(i: number) {
    if (!dragging() || props.disabled) return;
    if (!path().includes(i)) setPath([...path(), i]);
  }

  function release() {
    if (!dragging()) return;
    setDragging(false);
    const len = path().length;
    if (len >= MIN_LENGTH) {
      finish();
    } else if (len === 1) {
      setTapMode(true); // pojedyncze stuknięcie: kontynuuj kolejnymi stuknięciami
    } else {
      setPath([]);
    }
  }

  onMount(() => {
    window.addEventListener('mouseup', release);
  });
  onCleanup(() => window.removeEventListener('mouseup', release));

  const color = () => (props.error ? '#ef4444' : '#d4d4d8');

  const segments = () => {
    const p = path();
    const out: { x: number; y: number; len: number; angle: number }[] = [];
    for (let i = 0; i < p.length - 1; i++) {
      const a = DOTS[p[i]];
      const b = DOTS[p[i + 1]];
      out.push({
        x: a.x,
        y: a.y,
        len: Math.hypot(b.x - a.x, b.y - a.y),
        angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
      });
    }
    return out;
  };

  return (
    <div class="pattern-wrap">
      <div
        class={`pattern ${props.disabled ? 'disabled' : ''}`}
        style={`width:${SIZE}px; height:${SIZE}px;`}
        data-testid="pattern"
      >
        <For each={segments()}>
          {(s) => (
            <div
              class="pattern-line"
              style={`left:${s.x}px; top:${s.y - 2}px; width:${s.len}px; background:${color()}; transform:rotate(${s.angle}deg);`}
            />
          )}
        </For>

        <For each={DOTS}>
          {(dot, i) => {
            const active = () => path().includes(i());
            return (
              <div
                class="pattern-hit"
                data-testid={`dot-${i()}`}
                style={`left:${dot.x - HIT / 2}px; top:${dot.y - HIT / 2}px; width:${HIT}px; height:${HIT}px;`}
                onMouseDown={() => dotDown(i())}
                onMouseEnter={() => dotEnter(i())}
              >
                <Show when={active()}>
                  <div class="pattern-ring" style={`border-color:${color()};`} />
                </Show>
                <div
                  class={`pattern-dot ${active() ? 'active' : ''}`}
                  style={active() ? `background:${color()}; border-color:${color()};` : ''}
                />
              </div>
            );
          }}
        </For>
      </div>

      <Show when={tapMode()}>
        <div class="pattern-actions">
          <button
            type="button"
            class="btn btn-ghost pattern-action"
            onClick={clear}
            disabled={props.disabled}
          >
            Clear
          </button>
          <button
            type="button"
            class="btn btn-primary pattern-action"
            onClick={finish}
            disabled={props.disabled || path().length < MIN_LENGTH}
          >
            Confirm
          </button>
        </div>
      </Show>
    </div>
  );
}
