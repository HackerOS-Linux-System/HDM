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
    <div class={`clock ${props.class ?? ''}`}>
      <div class="clock-time">{time()}</div>
      <div class="clock-date">{date()}</div>
    </div>
  );
}
