import { onMount, onCleanup, Show } from 'solid-js';

interface BackgroundProps {
  wallpaper?: string | null;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  opacity: number;
  life: number;
  maxLife: number;
}

export default function Background(props: BackgroundProps) {
  let canvasRef: HTMLCanvasElement | undefined;
  let animId = 0;
  let resizeHandler: (() => void) | undefined;

  onMount(() => {
    const canvas = canvasRef;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // FIX: size the canvas to the element's actual box (clientWidth/Height)
    // rather than window.innerWidth/innerHeight — inside a Tauri webview the
    // two can briefly disagree during the fullscreen handshake, which is
    // part of what caused the "off-screen" particle field before.
    const resize = () => {
      canvas.width = canvas.clientWidth || window.innerWidth;
      canvas.height = canvas.clientHeight || window.innerHeight;
    };
    resize();

    const particles: Particle[] = [];

    const spawnParticle = () => {
      const maxLife = 120 + Math.random() * 180;
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: -Math.random() * 0.4 - 0.1,
        size: Math.random() * 1.5 + 0.5,
        opacity: 0,
        life: 0,
        maxLife,
      });
    };

    for (let i = 0; i < 60; i++) spawnParticle();

    let frame = 0;
    const draw = () => {
      frame++;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (frame % 3 === 0 && particles.length < 80) spawnParticle();

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life++;
        p.x += p.vx;
        p.y += p.vy;

        const progress = p.life / p.maxLife;
        if (progress < 0.2) p.opacity = progress / 0.2;
        else if (progress > 0.8) p.opacity = (1 - progress) / 0.2;
        else p.opacity = 1;

        if (p.life >= p.maxLife) {
          particles.splice(i, 1);
          continue;
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(147, 197, 253, ${p.opacity * 0.5})`;
        ctx.fill();
      }

      ctx.strokeStyle = 'rgba(59, 130, 246, 0.03)';
      ctx.lineWidth = 1;
      const gridSize = 80;
      for (let x = 0; x < canvas.width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
      for (let y = 0; y < canvas.height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }

      animId = requestAnimationFrame(draw);
    };
    draw();

    resizeHandler = resize;
    window.addEventListener('resize', resizeHandler);
  });

  onCleanup(() => {
    cancelAnimationFrame(animId);
    if (resizeHandler) window.removeEventListener('resize', resizeHandler);
  });

  return (
    <div class="fixed inset-0 overflow-hidden">
      <div class="absolute inset-0 bg-[#020812]" />

      <Show when={props.wallpaper}>
        <div
          class="absolute inset-0 bg-cover bg-center bg-no-repeat"
          style={`background-image:url(${props.wallpaper}); filter:brightness(0.25) saturate(0.6);`}
        />
      </Show>

      <div class="absolute inset-0 overflow-hidden">
        <div
          class="aurora-1 absolute rounded-full"
          style="width:70vw;height:70vw;left:-20vw;top:-20vw;background:radial-gradient(circle, rgba(37,99,235,0.12) 0%, rgba(29,78,216,0.06) 50%, transparent 70%);filter:blur(80px);"
        />
        <div
          class="aurora-2 absolute rounded-full"
          style="width:60vw;height:60vw;right:-15vw;bottom:-10vw;background:radial-gradient(circle, rgba(124,58,237,0.1) 0%, rgba(109,40,217,0.05) 50%, transparent 70%);filter:blur(80px);"
        />
        <div
          class="aurora-3 absolute rounded-full"
          style="width:40vw;height:40vw;left:30vw;top:20vh;background:radial-gradient(circle, rgba(6,182,212,0.06) 0%, transparent 70%);filter:blur(60px);"
        />
      </div>

      <canvas ref={canvasRef} class="absolute inset-0 pointer-events-none" style="opacity:0.8;" />

      <div
        class="absolute inset-0 pointer-events-none"
        style="background:radial-gradient(ellipse at center, transparent 40%, rgba(2,8,18,0.7) 100%);"
      />
    </div>
  );
}
