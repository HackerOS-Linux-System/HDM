import { createSignal, onMount, onCleanup } from 'solid-js';

interface ClockProps {
  class?: string;
}

export default function Clock(props: ClockProps) {
  const [time, setTime] = createSignal('');
  const [date, setDate] = createSignal('');
  let interval: ReturnType<typeof setInterval> | undefined;

  function update() {
    const now = new Date();
    const h = now.getHours().toString().padStart(2, '0');
    const m = now.getMinutes().toString().padStart(2, '0');
    setTime(`${h}:${m}`);

    const opts: Intl.DateTimeFormatOptions = {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    };
    setDate(now.toLocaleDateString('en-US', opts));
  }

  onMount(() => {
    update();
    interval = setInterval(update, 1000);
  });

  onCleanup(() => clearInterval(interval));

  return (
    <div class={`text-center ${props.class ?? ''}`}>
      <div
        class="tabular-nums leading-none text-white"
        style="font-family:'Oxanium',monospace; font-size:clamp(48px,8vw,110px); font-weight:300; letter-spacing:-0.02em; text-shadow:0 0 60px rgba(59,130,246,0.3),0 2px 4px rgba(0,0,0,0.5);"
      >
        {time()}
      </div>
      <div
        class="mt-2 text-slate-400 tracking-widest uppercase"
        style="font-family:'DM Sans',sans-serif; font-size:0.875rem; font-weight:300; letter-spacing:0.15em;"
      >
        {date()}
      </div>
    </div>
  );
}
