import { createSignal, onMount, For, Show } from 'solid-js';
import { assertRequiredFns } from '../utils/propValidation';

interface PatternLockProps {
  disabled?: boolean;
  error?: boolean;
  onComplete: (pattern: number[]) => void;
}

interface Dot {
  x: number;
  y: number;
}

const SIZE = 260;
const PAD = 40;
const STEP = (SIZE - PAD * 2) / 2;

export default function PatternLock(props: PatternLockProps) {
  // One-time setup-time check, not a reactive read — assertRequiredFns
  // doesn't need to re-run if onComplete were ever swapped out post-mount
  // (it never is, in practice: it's how the parent handles a completed
  // gesture, not a value that changes over the component's lifetime).
  // eslint-disable-next-line solid/reactivity
  assertRequiredFns('PatternLock', { onComplete: props.onComplete });

  let svgEl: SVGSVGElement | undefined;
  const [dots, setDots] = createSignal<Dot[]>([]);
  const [path, setPath] = createSignal<number[]>([]);
  const [dragging, setDragging] = createSignal(false);
  const [cursor, setCursor] = createSignal({ x: 0, y: 0 });

  onMount(() => {
    setDots(
      Array.from({ length: 9 }, (_, i) => ({
        x: PAD + (i % 3) * STEP,
        y: PAD + Math.floor(i / 3) * STEP,
      })),
    );
  });

  function nearestDot(x: number, y: number): number | null {
    const ds = dots();
    for (let i = 0; i < ds.length; i++) {
      const d = ds[i];
      if (Math.hypot(d.x - x, d.y - y) < 24) return i;
    }
    return null;
  }

  function getLocalPoint(e: PointerEvent): { x: number; y: number } {
    const rect = svgEl!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * SIZE,
      y: ((e.clientY - rect.top) / rect.height) * SIZE,
    };
  }

  function handlePointerDown(e: PointerEvent) {
    if (props.disabled) return;
    const p = getLocalPoint(e);
    const idx = nearestDot(p.x, p.y);
    setPath(idx !== null ? [idx] : []);
    setDragging(true);
    setCursor(p);
    svgEl!.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent) {
    if (!dragging() || props.disabled) return;
    const p = getLocalPoint(e);
    setCursor(p);
    const idx = nearestDot(p.x, p.y);
    if (idx !== null && !path().includes(idx)) setPath([...path(), idx]);
  }

  function handlePointerUp() {
    if (!dragging()) return;
    setDragging(false);
    if (path().length >= 4) props.onComplete(path());
    else setPath([]);
  }

  const lineColor = () => (props.error ? '#ef4444' : '#3b82f6');

  return (
    <svg
      ref={svgEl}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      width={SIZE}
      height={SIZE}
      class={`touch-none select-none ${props.disabled ? 'opacity-50' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <For each={path().slice(0, -1)}>
        {(idx, i) => (
          <line
            x1={dots()[idx]?.x}
            y1={dots()[idx]?.y}
            x2={dots()[path()[i() + 1]]?.x}
            y2={dots()[path()[i() + 1]]?.y}
            stroke={lineColor()}
            stroke-width="4"
            stroke-linecap="round"
            opacity="0.85"
          />
        )}
      </For>

      <Show when={dragging() && path().length > 0}>
        <line
          x1={dots()[path()[path().length - 1]]?.x}
          y1={dots()[path()[path().length - 1]]?.y}
          x2={cursor().x}
          y2={cursor().y}
          stroke={lineColor()}
          stroke-width="4"
          stroke-linecap="round"
          opacity="0.5"
        />
      </Show>

      <For each={dots()}>
        {(dot, i) => {
          const active = () => path().includes(i());
          return (
            <>
              <circle
                cx={dot.x}
                cy={dot.y}
                r={active() ? 10 : 8}
                fill={active() ? lineColor() : 'rgba(255,255,255,0.08)'}
                stroke={active() ? lineColor() : 'rgba(255,255,255,0.25)'}
                stroke-width="2"
                style="transition:r 0.1s ease, fill 0.1s ease;"
              />
              <Show when={active()}>
                <circle
                  cx={dot.x}
                  cy={dot.y}
                  r="16"
                  fill="none"
                  stroke={lineColor()}
                  stroke-width="1.5"
                  opacity="0.35"
                />
              </Show>
            </>
          );
        }}
      </For>
    </svg>
  );
}
