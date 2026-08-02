import { planWord, type PlannedStroke } from "./letterforms.ts";

const GROUND = "#0b0d10";
const DRAW_MS = 2200;
const JITTER = 0.4;
const HORIZON = 0.62;

interface Target {
  x: number;
  y: number;
  vx: number;
  vy: number;
  label: string;
}

function resolveAccent(): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--qm-accent").trim() || "#34d9ab";
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) return "#34d9ab";
  probe.fillStyle = "#34d9ab";
  probe.fillStyle = raw;
  return String(probe.fillStyle);
}

function withAlpha(hex: string, alpha: number): string {
  if (hex.startsWith("rgb")) return hex.replace(/rgba?\(([^)]+?)(?:,[^,)]+)?\)/, `rgba($1, ${alpha})`);
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export function mountSightline(host: HTMLElement): () => void {
  const accent = resolveAccent();
  host.style.setProperty("--gate-accent", accent);
  host.style.setProperty("--gate-ground", GROUND);

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
  if (!reduced) canvas.style.cursor = "none";
  host.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const decay = document.createElement("canvas");
  const dctx = decay.getContext("2d");
  if (!ctx || !dctx) {
    canvas.style.background = GROUND;
    return () => canvas.remove();
  }

  let dpr = 1;
  let W = 0;
  let H = 0;
  let word: ReturnType<typeof planWord> | null = null;
  let start = 0;
  let raf = 0;
  let running = false;
  let disposed = false;
  const pointer = { x: -1, y: -1, active: false };

  const targets: Target[] = [
    { x: 0.18, y: 0.2, vx: 0.012, vy: 0.004, label: "TRK-041 · 12.4M TOK" },
    { x: 0.78, y: 0.3, vx: -0.008, vy: 0.006, label: "TRK-107 · CACHE 74%" },
    { x: 0.6, y: 0.14, vx: 0.006, vy: -0.003, label: "TRK-233 · $2.61/OUT" },
  ];

  function resize(): void {
    const r = host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.round(r.width * dpr);
    H = Math.round(r.height * dpr);
    canvas.width = W;
    canvas.height = H;
    decay.width = W;
    decay.height = H;
    const em = Math.min(W * 0.115, H * 0.28);
    const probe = planWord("LOS", 0, 0, em, 0.22);
    word = planWord("LOS", (W - probe.width) / 2, H * 0.3 - em / 2, em, 0.22);
    if (!running && !disposed) drawFrame(reduced ? DRAW_MS + 4000 : performance.now() - start);
  }

  function strokePass(c: CanvasRenderingContext2D, path: PlannedStroke[], upTo: number, jx: number, jy: number): void {
    const passes: Array<[number, string]> = [
      [10 * dpr * 0.5, withAlpha(accent, 0.07)],
      [2.6 * dpr * 0.5, withAlpha(accent, 0.85)],
      [1.1 * dpr * 0.5, "rgba(240, 255, 250, 0.9)"],
    ];
    for (const [width, style] of passes) {
      c.lineWidth = width;
      c.strokeStyle = style;
      c.lineCap = "round";
      c.lineJoin = "round";
      for (const s of path) {
        if (s.cumStart >= upTo) break;
        const budget = upTo - s.cumStart;
        c.beginPath();
        let used = 0;
        c.moveTo(s.points[0][0] + jx, s.points[0][1] + jy);
        for (let i = 1; i < s.points.length; i++) {
          const seg = Math.hypot(s.points[i][0] - s.points[i - 1][0], s.points[i][1] - s.points[i - 1][1]);
          if (used + seg > budget) {
            const t = (budget - used) / seg;
            c.lineTo(
              s.points[i - 1][0] + (s.points[i][0] - s.points[i - 1][0]) * t + jx,
              s.points[i - 1][1] + (s.points[i][1] - s.points[i - 1][1]) * t + jy,
            );
            used = budget;
            break;
          }
          used += seg;
          c.lineTo(s.points[i][0] + jx, s.points[i][1] + jy);
        }
        c.stroke();
      }
    }
  }

  function beamPos(upTo: number): [number, number] | null {
    if (!word) return null;
    for (const s of word.strokes) {
      if (upTo < s.cumStart || upTo > s.cumStart + s.length) continue;
      let remain = upTo - s.cumStart;
      for (let i = 1; i < s.points.length; i++) {
        const seg = Math.hypot(s.points[i][0] - s.points[i - 1][0], s.points[i][1] - s.points[i - 1][1]);
        if (remain <= seg) {
          const t = seg ? remain / seg : 0;
          return [
            s.points[i - 1][0] + (s.points[i][0] - s.points[i - 1][0]) * t,
            s.points[i - 1][1] + (s.points[i][1] - s.points[i - 1][1]) * t,
          ];
        }
        remain -= seg;
      }
    }
    return null;
  }

  function drawField(c: CanvasRenderingContext2D, now: number): void {
    const hy = H * HORIZON;
    c.strokeStyle = withAlpha(accent, 0.13);
    c.lineWidth = 1 * dpr * 0.5;
    c.beginPath();
    c.moveTo(0, hy);
    c.lineTo(W, hy);
    c.stroke();

    c.strokeStyle = withAlpha(accent, 0.05);
    const vx = W / 2;
    for (let i = -6; i <= 6; i++) {
      c.beginPath();
      c.moveTo(vx, hy);
      c.lineTo(vx + i * W * 0.16, H + H * 0.06);
      c.stroke();
    }
    for (let i = 1; i <= 6; i++) {
      const t = i / 6;
      const y = hy + (H - hy) * t * t;
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(W, y);
      c.stroke();
    }

    c.font = `${9 * dpr}px ui-monospace, monospace`;
    for (const tg of targets) {
      const px = tg.x * W;
      const py = tg.y * H;
      const near =
        pointer.active && Math.hypot(pointer.x - px, pointer.y - py) < 70 * dpr;
      const a = near ? 0.95 : 0.4;
      c.strokeStyle = withAlpha(accent, a);
      c.lineWidth = 1.1 * dpr * 0.5;
      const r = 5 * dpr;
      c.beginPath();
      c.moveTo(px, py - r);
      c.lineTo(px + r, py);
      c.lineTo(px, py + r);
      c.lineTo(px - r, py);
      c.closePath();
      c.stroke();
      c.fillStyle = withAlpha(accent, near ? 0.85 : 0.3);
      c.fillText(tg.label, px + 10 * dpr, py + 3 * dpr);
      if (!reduced) {
        dctx!.fillStyle = withAlpha(accent, 0.5);
        dctx!.fillRect(px - dpr, py - dpr, 2 * dpr, 2 * dpr);
      }
    }
  }

  function drawReticle(c: CanvasRenderingContext2D): void {
    if (!pointer.active || !word) return;
    const { x, y } = pointer;
    const cx = word ? (word.strokes[0].points[0][0] + word.width / 2) : W / 2;
    const cy = H * 0.34;
    dctx!.strokeStyle = withAlpha(accent, 0.1);
    dctx!.lineWidth = 1 * dpr * 0.5;
    dctx!.beginPath();
    dctx!.moveTo(x, y);
    dctx!.lineTo(cx, cy);
    dctx!.stroke();

    c.strokeStyle = withAlpha(accent, 0.9);
    c.lineWidth = 1.1 * dpr * 0.5;
    const g = 6 * dpr;
    const l = 17 * dpr;
    c.beginPath();
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      c.moveTo(x + dx * g, y + dy * g);
      c.lineTo(x + dx * l, y + dy * l);
    }
    c.stroke();
    c.beginPath();
    c.arc(x, y, 8.5 * dpr, 0, Math.PI * 2);
    c.stroke();

    const az = ((x / W) * 90 - 45).toFixed(1);
    const el = (-(y / H) * 30 + 15).toFixed(1);
    c.fillStyle = withAlpha(accent, 0.65);
    c.font = `${9 * dpr}px ui-monospace, monospace`;
    c.fillText(`AZ ${az.padStart(5, "0")} / EL ${el}`, x + 22 * dpr, y - 14 * dpr);
  }

  function drawFrame(elapsed: number): void {
    if (!ctx || !dctx || !word) return;
    dctx.globalCompositeOperation = "destination-out";
    dctx.fillStyle = "rgba(0,0,0,0.055)";
    dctx.fillRect(0, 0, W, H);
    dctx.globalCompositeOperation = "source-over";

    ctx.fillStyle = GROUND;
    ctx.fillRect(0, 0, W, H);
    drawField(ctx, elapsed);
    ctx.drawImage(decay, 0, 0);

    const progress = easeInOut(Math.min(1, elapsed / DRAW_MS));
    const upTo = word.total * progress;
    const jx = reduced || progress < 1 ? 0 : (Math.random() - 0.5) * JITTER * dpr * 2;
    const jy = reduced || progress < 1 ? 0 : (Math.random() - 0.5) * JITTER * dpr * 2;
    strokePass(ctx, word.strokes, upTo, jx, jy);

    if (progress < 1) {
      const head = beamPos(upTo);
      if (head) {
        dctx.fillStyle = withAlpha(accent, 0.6);
        dctx.beginPath();
        dctx.arc(head[0], head[1], 2.2 * dpr, 0, Math.PI * 2);
        dctx.fill();
        ctx.fillStyle = "rgba(245, 255, 252, 0.95)";
        ctx.beginPath();
        ctx.arc(head[0], head[1], 2.6 * dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = withAlpha(accent, 0.25);
        ctx.beginPath();
        ctx.arc(head[0], head[1], 7 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (elapsed > DRAW_MS + 150) {
      const sub = Math.min(1, (elapsed - DRAW_MS - 150) / 600);
      ctx.fillStyle = withAlpha(accent, 0.55 * sub);
      ctx.font = `${10.5 * dpr}px ui-monospace, monospace`;
      const label = "L I N E   O F   S I G H T";
      const m = ctx.measureText(label);
      ctx.fillText(label, (W - m.width) / 2, H * 0.3 + Math.min(W * 0.115, H * 0.28) + 34 * dpr);
    }

    drawReticle(ctx);
  }

  function tick(now: number): void {
    if (!running) return;
    if (!start) start = now;
    for (const tg of targets) {
      tg.x += (tg.vx / 60) * 0.1;
      tg.y += (tg.vy / 60) * 0.1;
      if (tg.x < 0.06 || tg.x > 0.92) tg.vx *= -1;
      if (tg.y < 0.06 || tg.y > HORIZON - 0.08) tg.vy *= -1;
    }
    drawFrame(now - start);
    raf = requestAnimationFrame(tick);
  }

  function startLoop(): void {
    if (running || disposed || reduced) return;
    running = true;
    raf = requestAnimationFrame(tick);
  }
  function stopLoop(): void {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  const gate = host.closest(".signin") ?? host;
  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    pointer.x = (e.clientX - r.left) * dpr;
    pointer.y = (e.clientY - r.top) * dpr;
    pointer.active = true;
  };
  const onLeave = () => {
    pointer.active = false;
  };
  const onVis = () => {
    if (document.hidden) stopLoop();
    else {
      start = 0;
      startLoop();
    }
  };
  gate.addEventListener("pointermove", onMove as EventListener);
  gate.addEventListener("pointerleave", onLeave);
  document.addEventListener("visibilitychange", onVis);

  const ro = new ResizeObserver(() => resize());
  ro.observe(host);
  resize();
  if (reduced) drawFrame(DRAW_MS + 4000);
  else startLoop();

  return () => {
    disposed = true;
    stopLoop();
    ro.disconnect();
    gate.removeEventListener("pointermove", onMove as EventListener);
    gate.removeEventListener("pointerleave", onLeave);
    document.removeEventListener("visibilitychange", onVis);
    canvas.remove();
  };
}
