import { createRenderer, type Renderer } from "./renderer.ts";
import { buildAtlas, type GlyphAtlas } from "./glyph-atlas.ts";
import {
  composeField,
  FORMATION_SEC,
  makeBuffers,
  makeTarget,
  type ExcludeRect,
  type FieldBuffers,
  type FieldGrid,
  type InkPaint,
} from "./vortex-field.ts";
import { depositTrail, makeTrailField, stepTrail } from "./trail-field.ts";

export const LOS_ROWS = [
  "██         ████████   ████████",
  "██         ██    ██   ██      ",
  "██         ██    ██   ██      ",
  "██         ██    ██   ████████",
  "██         ██    ██         ██",
  "██         ██    ██         ██",
  "████████   ████████   ████████",
];

const SOURCE_LINES = [
  "every agent here carries its own memory, its own keys, its own narrow slice of the org's trust",
  "a budget is not a suggestion. when the meter runs dry the turn is refused, politely, in writing",
  "tokens are metered the way water is metered",
  "you can read the cost of a merged pull request down to the last cached token",
  "the engines sit side by side, sonnet next to the local runner, and the ledger doesn't care which one answered",
  "memory survives the session. what the agent learned on tuesday it still knows in the winter",
  "keys live in the keychain, scoped, revocable, never pasted into a prompt again",
  "every turn is a line item",
  "the org sees its own thinking itemized: who asked, which engine, what it cost, what shipped",
  "an agent that overspends is an agent that stops. the refusal is the feature",
  "cost per merged pr, cost per answered question, cost per quiet friday night",
  "the scheduler wakes them, the ledger watches them, the gate lets you in",
  "self-hosted, which is to say: your machines, your weights, your bill",
  "nothing here phones home. the meter is yours to read",
];

const BASE_ROWS = 22;
const ZOOM = 0.72;
const GROUND = "#0b0d10";
const ACCENT_FALLBACK = "#34d9ab";
const INK_BASE = "#2a3b36";
const INK_MIX = 0.58;
const LOGO_LIFT = 0.08;
const FLARE_LIFT = 0.75;
const SCANLINE = 0;
const ABERRATION = 0;
const CURVATURE = 0;
const TRAIL_STRENGTH = 1.3;
const VEL_SMOOTH = 0.35;

type Rgb = [number, number, number];

function resolveHex(value: string, fallback: string): string {
  const v = value.trim();
  if (!v) return fallback;
  const cv = document.createElement("canvas");
  cv.width = 1;
  cv.height = 1;
  const ctx = cv.getContext("2d");
  if (!ctx) return fallback;
  ctx.fillStyle = "#000";
  ctx.fillStyle = v;
  const out = String(ctx.fillStyle);
  return /^#[0-9a-f]{6}$/i.test(out) ? out : fallback;
}

function hexToRgb01(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const GLYPHS = [...Array.from({ length: 95 }, (_u, i) => String.fromCharCode(32 + i)), "█"];
const GLYPH_LOOKUP = new Map(GLYPHS.map((g, i) => [g, i]));
const SPACE_SLOT = GLYPH_LOOKUP.get(" ") ?? 0;
const slotOf = (ch: string, weight: number) =>
  weight * GLYPHS.length + (GLYPH_LOOKUP.get(ch) ?? SPACE_SLOT);

export function mountSwirl(host: HTMLElement): () => void {
  const accentHex = resolveHex(
    getComputedStyle(document.documentElement).getPropertyValue("--qm-accent"),
    ACCENT_FALLBACK,
  );
  const surface = host.parentElement;
  if (surface) {
    surface.style.setProperty("--gate-accent", accentHex);
    surface.style.setProperty("--gate-ground", GROUND);
  }

  const accent = hexToRgb01(accentHex);
  const bg = hexToRgb01(GROUND);
  const ink = mixRgb(hexToRgb01(INK_BASE), accent, INK_MIX);
  const logo = mixRgb([1, 1, 1], accent, LOGO_LIFT);
  const flare = mixRgb(accent, [1, 1, 1], FLARE_LIFT);
  const paint: InkPaint = { stops: [ink], angle: 0, flow: 0, gradient: false, mode: "rows" };

  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;width:100%;height:100%";
  host.appendChild(canvas);

  const renderer: Renderer | null = createRenderer(canvas);
  if (!renderer) {
    canvas.style.background = GROUND;
    return () => {
      canvas.remove();
    };
  }

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const target = makeTarget(LOS_ROWS);
  const trail = makeTrailField();

  let atlas: GlyphAtlas | null = null;
  let grid: FieldGrid | null = null;
  let buffers: FieldBuffers | null = null;
  let cw = 0;
  let ch = 0;

  let raf = 0;
  let running = false;
  let disposed = false;
  let startTime = performance.now();
  let last = startTime;

  const pointer = { active: false, nx: 0, ny: 0, px: 0, py: 0, pt: 0, vx: 0, vy: 0 };

  const measureExclude = (): ExcludeRect | null => {
    const btn = gate.querySelector(".gate-ascii-btn");
    if (!btn) return null;
    const cr = canvas.getBoundingClientRect();
    if (!cr.width || !cr.height) return null;
    const b = btn.getBoundingClientRect();
    if (!b.width || !b.height) return null;
    const sx = cw / cr.width;
    const sy = ch / cr.height;
    const pad = 14;
    return {
      x0: (b.left - cr.left - pad) * sx,
      y0: (b.top - cr.top - pad) * sy,
      x1: (b.right - cr.left + pad) * sx,
      y1: (b.bottom - cr.top + pad) * sy,
    };
  };

  const drawFrame = (elapsed: number) => {
    if (!atlas || !grid || !buffers) return;
    const count = composeField({
      grid,
      atlas,
      buffers,
      source: SOURCE_LINES,
      target,
      elapsed,
      paint,
      logo,
      slotOf,
      trail,
      trailStrength: TRAIL_STRENGTH,
      trailFlare: flare,
      exclude: measureExclude(),
    });
    renderer.drawField(count, grid, buffers, bg);
    renderer.drawCrt(elapsed * 0.001, cw, ch, {
      scanline: SCANLINE,
      aberration: ABERRATION,
      curvature: CURVATURE,
      bg,
    });
  };

  const resize = () => {
    if (disposed) return;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = Math.round(w * dpr);
    ch = Math.round(h * dpr);
    const rows = Math.max(8, Math.round(BASE_ROWS / ZOOM));
    atlas = buildAtlas(renderer.gl, renderer.glyphTex, renderer.scratch, GLYPHS, Math.max(8, Math.round(ch / rows)));
    const gridRows = Math.max(target.rows.length, Math.ceil(ch / atlas.inkSize) + 1);
    const cols = Math.floor(cw / atlas.advance);
    grid = {
      cols,
      rows: gridRows,
      inkSize: atlas.inkSize,
      vOffset: Math.round((ch - gridRows * atlas.inkSize) / 2),
      targetX: Math.max(0, Math.round((cols - (target.rows[0]?.length ?? 0)) / 2)),
      targetY: Math.max(0, Math.round((gridRows - target.rows.length) / 2)),
    };
    buffers = makeBuffers(gridRows * cols * 3);
    renderer.allocCells(buffers);
    renderer.resizeTargets(cw, ch);
    if (reduced) drawFrame(FORMATION_SEC * 1000 + 1);
  };

  const tick = (now: number) => {
    if (!running) return;
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    if (pointer.active && dt > 0) {
      depositTrail(trail, pointer.nx, pointer.ny, pointer.vx, pointer.vy, dt);
    }
    stepTrail(trail, dt);
    drawFrame(now - startTime);
    raf = requestAnimationFrame(tick);
  };

  const start = () => {
    if (running || disposed) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  };

  const stop = () => {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  let pausedAt = 0;
  const onVisibility = () => {
    if (document.hidden) {
      pausedAt = performance.now();
      stop();
    } else {
      startTime += performance.now() - pausedAt;
      start();
    }
  };

  const gate = (host.closest(".signin") as HTMLElement | null) ?? host;
  const onMove = (ev: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const nx = Math.max(-1, Math.min(1, ((ev.clientX - rect.left) / rect.width) * 2 - 1));
    const ny = Math.max(-1, Math.min(1, ((ev.clientY - rect.top) / rect.height) * 2 - 1));
    const t = performance.now();
    if (pointer.active) {
      const dt = Math.max(0.004, (t - pointer.pt) / 1000);
      const ivx = (nx - pointer.px) / dt;
      const ivy = (ny - pointer.py) / dt;
      pointer.vx += (ivx - pointer.vx) * VEL_SMOOTH;
      pointer.vy += (ivy - pointer.vy) * VEL_SMOOTH;
    } else {
      pointer.vx = 0;
      pointer.vy = 0;
    }
    pointer.active = true;
    pointer.nx = nx;
    pointer.ny = ny;
    pointer.px = nx;
    pointer.py = ny;
    pointer.pt = t;
  };
  const onLeave = () => {
    pointer.active = false;
  };

  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  if (!reduced) {
    gate.addEventListener("pointermove", onMove);
    gate.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", onVisibility);
    start();
  }

  return () => {
    disposed = true;
    stop();
    ro.disconnect();
    gate.removeEventListener("pointermove", onMove);
    gate.removeEventListener("pointerleave", onLeave);
    document.removeEventListener("visibilitychange", onVisibility);
    renderer.dispose();
    canvas.remove();
  };
}
