import { For, Show } from 'solid-js';

interface BackgroundProps {
  /** Ścieżka pliku tapety (Silver ładuje <img src> prosto ze ścieżki). */
  wallpaper?: string | null;
}

/**
 * Tło ekranu logowania. Silver nie ma <canvas>, więc cząsteczki to zwykłe elementy z animacją CSS
 * (@keyframes float-up), a „zorze” to rozmyte cienie (box-shadow) zamiast filter:blur + radial-gradient.
 * Pozycje i czasy cząsteczek są deterministyczne (stała tablica), żeby render był powtarzalny.
 */
const PARTICLE_COUNT = 36;

interface Particle {
  left: number;
  top: number;
  size: number;
  duration: number;
  delay: number;
}

// Prosty generator pseudolosowy (LCG) — stałe ziarno, ten sam układ przy każdym uruchomieniu.
function makeParticles(): Particle[] {
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  return Array.from({ length: PARTICLE_COUNT }, () => ({
    left: Math.round(rnd() * 100),
    top: Math.round(rnd() * 100),
    size: 1 + Math.round(rnd() * 2),
    duration: 10 + Math.round(rnd() * 14),
    delay: Math.round(rnd() * 12),
  }));
}

const PARTICLES = makeParticles();

export default function Background(props: BackgroundProps) {
  return (
    <div class="bg">
      <div class="bg-base" />

      <Show when={props.wallpaper}>
        <img class="bg-wallpaper" src={props.wallpaper!} alt="" />
        <div class="bg-dim" />
      </Show>

      <div class="bg-orb bg-orb-1" />
      <div class="bg-orb bg-orb-2" />
      <div class="bg-orb bg-orb-3" />

      <For each={PARTICLES}>
        {(p) => (
          <div
            class="bg-particle"
            style={`left:${p.left}%; top:${p.top}%; width:${p.size}px; height:${p.size}px; animation-duration:${p.duration}s; animation-delay:${p.delay}s;`}
          />
        )}
      </For>

      <div class="bg-vignette-top" />
      <div class="bg-vignette-bottom" />
    </div>
  );
}
