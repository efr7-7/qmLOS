import {
  WEIGHT_REGULAR,
  WEIGHT_BOLD,
  type GlyphAtlas,
} from "./glyph-atlas.ts";
import { sampleTrail, type TrailField } from "./trail-field.ts";

export const TWIST_RATE = 0.1;
export const CORE_FLOOR = 0.1;
export const FORMATION_SEC = 1.8;
export const STENCIL_HALO = 4;
export const FIELD_EXTENT = 1.0;

const SPACE = " ";

const easeOutQuad = (t: number) => t * (2 - t);
const mix = (a: number, b: number, t: number) => a * (1 - t) + b * t;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const twistAt = (spin: number, dist: number) =>
  (spin * TWIST_RATE) / Math.max(CORE_FLOOR, dist);

export interface Target {
  rows: string[];
  stencil: boolean[][];
}

export function carveStencil(rows: string[]): boolean[][] {
  const w = Math.max(0, ...rows.map((l) => l.length));
  return rows.map((line) => {
    const isInk = (x: number) => x >= 0 && x < w && line[x] !== undefined && line[x] !== " ";
    return Array.from({ length: w }, (_u, x) => {
      if (isInk(x) || isInk(x - 1) || isInk(x + 1)) return true;
      let left = false;
      let right = false;
      for (let d = 1; d <= STENCIL_HALO; d++) {
        if (isInk(x - d)) left = true;
        if (isInk(x + d)) right = true;
      }
      return left && right;
    });
  });
}

export function makeTarget(rows: string[]): Target {
  const w = Math.max(0, ...rows.map((l) => l.length));
  const padded = rows.map((l) => l.padEnd(w, " "));
  return { rows: padded, stencil: carveStencil(padded) };
}

export interface FieldBuffers {
  bounds: Float32Array;
  glyphUvs: Float32Array;
  colors: Float32Array;
}

export function makeBuffers(maxCells: number): FieldBuffers {
  return {
    bounds: new Float32Array(maxCells * 4),
    glyphUvs: new Float32Array(maxCells * 4),
    colors: new Float32Array(maxCells * 4),
  };
}

export interface FieldGrid {
  cols: number;
  rows: number;
  inkSize: number;
  vOffset: number;
  targetX: number;
  targetY: number;
}

export type InkMode = "rows" | "axis";

export interface InkPaint {
  stops: [number, number, number][];
  angle: number;
  flow: number;
  gradient: boolean;
  mode: InkMode;
}

const HUE_DRIFT = 0.12;
const HUE_DRIFT_SPEED = 0.6;
const SPEED_DIM = 0.55;

function rampAt(stops: [number, number, number][], t: number): [number, number, number] {
  t = t - Math.floor(t);
  const seg = t * stops.length;
  const i = Math.floor(seg) % stops.length;
  const j = (i + 1) % stops.length;
  const f = seg - Math.floor(seg);
  const a = stops[i];
  const b = stops[j];
  return [mix(a[0], b[0], f), mix(a[1], b[1], f), mix(a[2], b[2], f)];
}

export interface Shock {
  x: number;
  y: number;
  age: number;
}

const WAKE_PUSH = 0.34;
const SWIRL_GAIN = 4.5;
const TRAIL_NOISE = 0.9;
const FLARE_GAIN = 2.4;
const SHOCK_SPEED = 1.4;
const SHOCK_WIDTH = 0.13;
const SHOCK_PUSH = 0.12;
const SHOCK_FADE = 1.9;

const cellHash = (col: number, row: number) => {
  const n = Math.sin(col * 127.1 + row * 311.7) * 43758.5453;
  return n - Math.floor(n);
};

interface PaintSample {
  fx: number;
  fy: number;
  srcRow: number;
  jitter: number;
  speed: number;
  time: number;
}

function paintAt(paint: InkPaint, s: PaintSample): [number, number, number] {
  const stops = paint.stops;
  if (!paint.gradient || stops.length < 2) {
    const bright = mix(SPEED_DIM, 1, s.speed);
    const c = stops[0];
    return [c[0] * bright, c[1] * bright, c[2] * bright];
  }
  let t: number;
  if (paint.mode === "axis") {
    const ca = Math.cos(paint.angle);
    const sa = Math.sin(paint.angle);
    t = (s.fx * ca + s.fy * sa) * 0.5 + 0.5 + paint.flow;
  } else {
    t = s.srcRow + paint.flow;
  }
  t += Math.sin(s.time * HUE_DRIFT_SPEED + s.jitter * Math.PI * 2) * HUE_DRIFT * s.jitter;
  const rgb = rampAt(stops, t);
  const bright = mix(SPEED_DIM, 1, s.speed);
  return [rgb[0] * bright, rgb[1] * bright, rgb[2] * bright];
}

function pushCell(
  buf: FieldBuffers,
  atlas: GlyphAtlas,
  glyphSlot: number,
  x: number,
  baseline: number,
  rgb: [number, number, number],
  alpha: number,
  state: { count: number },
) {
  if (alpha <= 0) return;
  const o = state.count * 4;
  const uv = atlas.uvs[glyphSlot];
  buf.bounds[o] = x - atlas.pad;
  buf.bounds[o + 1] = baseline - atlas.baseline;
  buf.bounds[o + 2] = x - atlas.pad + atlas.cellW;
  buf.bounds[o + 3] = baseline - atlas.baseline + atlas.cellH;
  buf.glyphUvs[o] = uv[0];
  buf.glyphUvs[o + 1] = uv[1];
  buf.glyphUvs[o + 2] = uv[2];
  buf.glyphUvs[o + 3] = uv[3];
  buf.colors[o] = rgb[0];
  buf.colors[o + 1] = rgb[1];
  buf.colors[o + 2] = rgb[2];
  buf.colors[o + 3] = alpha;
  state.count++;
}

export interface ComposeArgs {
  grid: FieldGrid;
  atlas: GlyphAtlas;
  buffers: FieldBuffers;
  source: string[];
  target: Target;
  elapsed: number;
  paint: InkPaint;
  logo: [number, number, number];
  slotOf: (ch: string, weight: number) => number;
  trail?: TrailField;
  trailStrength?: number;
  trailFlare?: [number, number, number];
  shocks?: Shock[];
  turbulence?: number;
  wavePattern?: WavePattern;
}

export type WavePattern = "wavefront" | "ripples" | "flow" | "cloth";

const WAVE_AMP = 0.16;
const WAVE_FREQ = 2.4;
const WAVE_SPEED = 0.9;
const WAVE_DIR = Math.PI * 0.15;

const vnoise = (x: number, y: number): number => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const h = (a: number, b: number) => {
    const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const c = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
};

export function composeField(args: ComposeArgs): number {
  const { grid, atlas, buffers, source, target, elapsed, paint, logo, slotOf, trail, shocks, turbulence } = args;
  const wavePattern = args.wavePattern ?? "wavefront";
  const trailStrength = args.trailStrength ?? 1;
  const flare = args.trailFlare;
  const { sin, cos, sqrt, floor, round, exp, max, PI } = Math;
  const spin = elapsed * 0.001;
  const turbOn = !!turbulence && turbulence > 0.001;
  const tWave = elapsed * 0.001 * WAVE_SPEED;
  const waveDirX = cos(WAVE_DIR);
  const waveDirY = sin(WAVE_DIR);
  const formation = easeOutQuad(clamp01((elapsed * 0.001) / FORMATION_SEC));
  const lum = 0.299 * logo[0] + 0.587 * logo[1] + 0.114 * logo[2];
  const hi: [number, number, number] = lum < 0.5
    ? [mix(logo[0], 1, 0.5), mix(logo[1], 1, 0.5), mix(logo[2], 1, 0.5)]
    : [mix(logo[0], 0, 0.35), mix(logo[1], 0, 0.35), mix(logo[2], 0, 0.35)];
  const lines = source;
  const tw = target.rows;
  const tWidth = tw[0]?.length ?? 0;
  const state = { count: 0 };

  const trailOn = !!trail;
  const ts = { heat: 0, fx: 0, fy: 0 };
  const shockOn = !!shocks && shocks.length > 0;
  const halfW = (grid.cols * atlas.advance) / 2;
  const halfH = (grid.rows * grid.inkSize) / 2;

  for (let row = 0; row < grid.rows; row++) {
    const y = (1 - (row * 2) / grid.rows) * FIELD_EXTENT;
    const baseline = grid.vOffset + row * grid.inkSize;
    const sny = (row + 0.5) / grid.rows * 2 - 1;
    for (let col = 0; col < grid.cols; col++) {
      const x = ((col * 2) / grid.cols - 1) * FIELD_EXTENT;
      const snx = (col + 0.5) / grid.cols * 2 - 1;
      const dist = sqrt(x * x + y * y);

      let heat = 0;
      if (trailOn) {
        sampleTrail(trail!, snx, sny, ts);
        heat = ts.heat;
      }
      const twist = twistAt(spin, dist) * (1 + SWIRL_GAIN * heat * trailStrength);
      const s = sin(twist);
      const cse = cos(twist);
      const rx = x * cse + y * s;
      const ry = x * s - y * cse;

      const sampleCol = floor(((rx + 1) / 2) * grid.cols);
      const sampleRow = floor(((ry + 1) / 2) * grid.rows);
      const srcLine = lines[((sampleRow % lines.length) + lines.length) % lines.length] ?? "";
      let ch = sampleCol >= 0 && sampleCol < srcLine.length ? srcLine[sampleCol] ?? SPACE : SPACE;

      let resolved = SPACE;
      const tx = col - grid.targetX;
      const ty = row - grid.targetY;
      const inTarget = tx >= 0 && tx < tWidth && ty >= 0 && ty < tw.length;
      const inLogo = inTarget && !!target.stencil[ty]?.[tx];
      if (inLogo) {
        const wordChar = tw[ty][tx];
        if (wordChar && wordChar !== " ") {
          ch = String.fromCharCode(
            round(mix(ch.charCodeAt(0), wordChar.charCodeAt(0), formation)),
          );
          resolved = ch;
        } else if (formation > 0.5) {
          ch = SPACE;
        }
      }
      if (ch === SPACE && resolved === SPACE) continue;

      let dx = 0;
      let dy = 0;
      if (trailOn && !inLogo && heat > 0.001) {
        const noise = 1 + (cellHash(col, row) - 0.5) * TRAIL_NOISE;
        const push = WAKE_PUSH * heat * trailStrength * noise;
        dx += ts.fx * push;
        dy += ts.fy * push;
        dx += -ts.fy * push * 0.5;
        dy += ts.fx * push * 0.5;
      }
      if (shockOn && !inLogo) {
        for (let k = 0; k < shocks!.length; k++) {
          const sh = shocks![k];
          const ox = snx - sh.x;
          const oy = sny - sh.y;
          const r = sqrt(ox * ox + oy * oy);
          const ringR = sh.age * SHOCK_SPEED;
          const d = (r - ringR) / SHOCK_WIDTH;
          const crest = exp(-d * d) * exp(-sh.age * SHOCK_FADE);
          if (crest > 0.002) {
            const inv = 1 / max(0.0001, r);
            const push = SHOCK_PUSH * crest;
            dx += ox * inv * push;
            dy += oy * inv * push;
          }
        }
      }
      if (turbOn && !inLogo) {
        const a = WAVE_AMP * turbulence!;
        if (wavePattern === "wavefront") {
          const phase = (snx * waveDirX + sny * waveDirY) * WAVE_FREQ * PI - tWave * PI;
          const w = sin(phase);
          dx += a * w * waveDirX;
          dy += a * w * waveDirY;
        } else if (wavePattern === "ripples") {
          const r = sqrt(snx * snx + sny * sny);
          const w = sin(r * WAVE_FREQ * PI * 1.6 - tWave * PI);
          const inv = 1 / max(0.08, r);
          dx += a * w * snx * inv;
          dy += a * w * sny * inv;
        } else if (wavePattern === "flow") {
          const nx = vnoise(snx * 1.6 + tWave * 0.4, sny * 1.6);
          const ny = vnoise(sny * 1.6 - tWave * 0.4 + 7.3, snx * 1.6 + 3.1);
          dx += a * 1.4 * nx;
          dy += a * 1.4 * ny;
        } else {
          dx += a * 1.3 * sin(sny * WAVE_FREQ * PI * 0.9 + tWave * PI * 1.2);
          dy += a * 0.35 * sin(snx * WAVE_FREQ * PI + tWave * PI);
        }
      }

      const px = col * atlas.advance + dx * halfW;
      const by = baseline + dy * halfH;
      const fx = (col * 2) / grid.cols - 1;
      const fy = 1 - (row * 2) / grid.rows;
      const srcRow = floor(((ry + 1) / 2) * grid.rows);
      const rgb = paintAt(paint, {
        fx,
        fy,
        srcRow: (((srcRow % grid.rows) + grid.rows) % grid.rows) / grid.rows,
        jitter: cellHash(col, row),
        speed: clamp01(1 - dist),
        time: spin,
      });
      let cellRgb = rgb;
      if (flare && heat > 0.001 && !inLogo) {
        const t = clamp01(heat * FLARE_GAIN * trailStrength);
        cellRgb = [mix(rgb[0], flare[0], t), mix(rgb[1], flare[1], t), mix(rgb[2], flare[2], t)];
      }
      if (ch !== SPACE) {
        pushCell(buffers, atlas, slotOf(ch, WEIGHT_REGULAR), px, by, cellRgb, 1, state);
      }
      if (resolved !== SPACE) {
        pushCell(buffers, atlas, slotOf(resolved, WEIGHT_BOLD), px, by, logo, formation, state);
        pushCell(buffers, atlas, slotOf(resolved, WEIGHT_BOLD), px, by, hi, formation * 0.5, state);
      }
    }
  }
  return state.count;
}
