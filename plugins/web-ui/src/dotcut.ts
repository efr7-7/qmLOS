type SceneKind = "text" | "rings" | "checker" | "bars" | "columns" | "boxes";
type TransitionKind = "wipe" | "ripple" | "scatter" | "collapse" | "columns";
type StyleKind = "drift" | "grain" | "swell" | "streak";

interface Scene {
  kind: SceneKind;
  value?: string;
  transition: TransitionKind;
  palette: number;
  style: StyleKind;
}

const COLS = 42;
const HOLD_MS = 2600;
const MORPH_MS = 700;
const BRUSH = 1.6;
const CANVAS_BG = "#0b0d10";

const SCENES: Scene[] = [
  { kind: "text", value: "L", transition: "wipe", palette: 0, style: "drift" },
  { kind: "rings", transition: "ripple", palette: 1, style: "grain" },
  { kind: "columns", transition: "columns", palette: 2, style: "streak" },
  { kind: "checker", transition: "scatter", palette: 3, style: "swell" },
  { kind: "boxes", transition: "collapse", palette: 4, style: "grain" },
  { kind: "bars", transition: "wipe", palette: 5, style: "drift" },
];

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function smooth01(v: number, e0: number, e1: number): number {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
  const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
  const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
  return `rgb(${r},${g},${bl})`;
}

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

function buildPalettes(): [string, string][] {
  const accent = resolveHex(
    getComputedStyle(document.documentElement).getPropertyValue("--qm-accent"),
    "#34d9ab",
  );
  return [
    [accent, CANVAS_BG],
    ["#a78bfa", "#120f1f"],
    ["#2dd4bf", "#04201b"],
    ["#fbbf24", "#161105"],
    ["#38bdf8", "#07131d"],
    ["#fb7185", "#1a0b11"],
  ];
}

function cellMotion(
  kind: TransitionKind,
  t: number,
  dir: number,
  rand: number,
): { scale: number; dx: number; dy: number } {
  const u = Math.sin(Math.min(1, Math.max(0, t)) * Math.PI);
  switch (kind) {
    case "wipe":
      return { scale: 1, dx: u * 0.16 * -dir, dy: 0 };
    case "ripple":
      return { scale: 1 - u * 0.1, dx: 0, dy: u * -0.13 };
    case "scatter":
      return {
        scale: 1,
        dx: u * 0.18 * Math.cos(rand * Math.PI * 2),
        dy: u * 0.18 * Math.sin(rand * Math.PI * 2),
      };
    case "collapse":
      return { scale: 1 - u * 0.18, dx: 0, dy: 0 };
    case "columns":
      return { scale: 1, dx: 0, dy: u * 0.22 };
  }
}

function cellDelay(
  kind: TransitionKind,
  x: number,
  y: number,
  cols: number,
  rows: number,
  rand: number,
): number {
  const fx = cols > 1 ? x / (cols - 1) : 0;
  const fy = rows > 1 ? y / (rows - 1) : 0;
  switch (kind) {
    case "wipe":
      return Math.min(1, Math.max(0, (fx * 0.75 + fy * 0.25) * 0.85 + rand * 0.15));
    case "ripple": {
      const d = Math.hypot(fx - 0.5, fy - 0.5) / 0.707;
      return Math.min(1, d * 0.9 + rand * 0.1);
    }
    case "scatter":
      return rand;
    case "collapse": {
      const d = Math.hypot(fx - 0.5, fy - 0.5) / 0.707;
      return Math.min(1, (1 - d) * 0.85 + rand * 0.15);
    }
    case "columns":
      return Math.min(1, fx * 0.9 + rand * 0.1);
  }
}

function styleField(
  scene: Scene,
  cols: number,
  rows: number,
  t: number,
  out: Float32Array,
  prev: Scene,
): void {
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  const maxR = Math.hypot(cols, rows) / 2;
  const FLIP = 0.32;
  const stateOf = (style: StyleKind, x: number, y: number): number => {
    switch (style) {
      case "drift": {
        const a = Math.sin(x * 0.41 + y * 0.23);
        const b = Math.sin(x * 0.17 - y * 0.53 + 2.1);
        return smooth01((a + b) * 0.5, -0.15, 0.75);
      }
      case "grain": {
        const n =
          hash2(x, y) * 0.55 + hash2(x + 1, y) * 0.15 + hash2(x, y + 1) * 0.15 + hash2(x + 1, y + 1) * 0.15;
        return smooth01(n, 0.34, 0.86);
      }
      case "swell": {
        const d = Math.hypot(x - cx, y - cy) / maxR;
        const warp = Math.sin(Math.atan2(y - cy, x - cx) * 3.0) * 0.14;
        return smooth01(1 - (d + warp), 0.28, 0.92);
      }
      case "streak": {
        const s = Math.sin(x * 0.28 + y * 0.62);
        const cut = Math.sin(x * 0.09 - y * 0.11 + 1.3) * 0.5 + 0.5;
        return smooth01(s * cut, -0.05, 0.7);
      }
    }
  };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let order = 0;
      switch (scene.style) {
        case "drift":
          order = (x / cols) * 0.75 + Math.sin(y * 0.5) * 0.12 + 0.12;
          break;
        case "grain":
          order = (x / cols) * 0.55 + (y / rows) * 0.25 + hash2(x, y) * 0.2;
          break;
        case "swell":
          order = Math.hypot(x - cx, y - cy) / maxR;
          break;
        case "streak":
          order = (x / cols) * 0.8 + (y / rows) * 0.2;
          break;
      }
      const from = stateOf(prev.style, x, y);
      const to = stateOf(scene.style, x, y);
      const u = Math.min(1, Math.max(0, (t - order * (1 - FLIP)) / FLIP));
      const eased = u * u * (3 - 2 * u);
      out[y * cols + x] = from + (to - from) * eased;
    }
  }
}

function rasterize(scene: Scene, cols: number, rows: number, fontFamily: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(cols * rows)).fill(1);
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  if (scene.kind === "checker") {
    const b = Math.max(2, Math.round(cols / 14));
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if ((Math.floor(x / b) + Math.floor(y / b)) % 2 === 0) out[y * cols + x] = 0;
      }
    }
    return out;
  }
  if (scene.kind === "bars") {
    const period = 3;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (Math.floor((x + y) / period) % 2 === 0) out[y * cols + x] = 0;
      }
    }
    return out;
  }
  if (scene.kind === "columns") {
    const bw = 4;
    const bh = 3;
    for (let y = 0; y < rows; y++) {
      const band = Math.floor(y / bh);
      const shift = band % 2 === 0 ? 0 : bw / 2;
      for (let x = 0; x < cols; x++) {
        if (Math.floor((x + shift) / bw) % 2 === 0) out[y * cols + x] = 0;
      }
    }
    return out;
  }
  if (scene.kind === "boxes") {
    const period = 2.5;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const d = Math.max(Math.abs(x - cx), Math.abs(y - cy));
        if (Math.floor(d / period) % 2 === 0) out[y * cols + x] = 0;
      }
    }
    return out;
  }
  if (scene.kind === "rings") {
    const maxR = Math.hypot(cols, rows) / 2;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const d = Math.hypot(x - cx, y - cy) / maxR;
        if (Math.floor(d * 6.0) % 2 === 0) out[y * cols + x] = 0;
      }
    }
    return out;
  }
  const cv = document.createElement("canvas");
  cv.width = cols;
  cv.height = rows;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) return out;
  const text = (scene.value || "").trim();
  if (!text) return out;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, cols, rows);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let size = rows * 0.8;
  ctx.font = `700 ${size}px ${fontFamily}`;
  const maxW = cols * 0.36;
  const m = ctx.measureText(text);
  if (m.width > maxW) {
    size *= maxW / m.width;
    ctx.font = `700 ${size}px ${fontFamily}`;
  }
  const maxH = rows * 0.58;
  const mm = ctx.measureText(text);
  const gh = mm.actualBoundingBoxAscent + mm.actualBoundingBoxDescent;
  if (gh > maxH) {
    size *= maxH / gh;
    ctx.font = `700 ${size}px ${fontFamily}`;
  }
  ctx.fillText(text, cols / 2, rows / 2 + rows * 0.02);
  const data = ctx.getImageData(0, 0, cols, rows).data;
  for (let i = 0; i < cols * rows; i++) {
    if (data[i * 4] > 110) out[i] = 0;
  }
  return out;
}

class DotCut {
  private host: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private palettes: [string, string][];
  private cols = COLS;
  private rows = 12;
  private pitch = 10;
  private ox = 0;
  private oy = 0;
  private target = new Uint8Array(0);
  private live = new Float32Array(0);
  private from = new Float32Array(0);
  private delay = new Float32Array(0);
  private rnd = new Float32Array(0);
  private prog = new Float32Array(0);
  private dir = new Float32Array(0);
  private bore = new Float32Array(0);
  private styleT = 0;
  private sceneIdx = 0;
  private phase: "hold" | "morph" = "hold";
  private phaseT = 0;
  private paletteMix = 1;
  private prevPalette = 0;
  private prevScene = 0;
  private pointer: { x: number; y: number } | null = null;
  private raf = 0;
  private last = 0;
  private running = false;
  private dpr = 1;
  private ro: ResizeObserver | null = null;
  private disposed = false;
  private fontFamily = "sans-serif";

  constructor(host: HTMLElement, fontFamily?: string) {
    this.host = host;
    if (fontFamily) this.fontFamily = fontFamily;
    this.palettes = buildPalettes();
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "display:block;width:100%;height:100%";
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    if (!this.ctx) return;
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
  }

  get ok(): boolean {
    return !!this.ctx;
  }

  private applyScene(scene: Scene, instant: boolean): void {
    const next = rasterize(scene, this.cols, this.rows, this.fontFamily);
    this.from.set(this.live);
    this.target = next;
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const i = y * this.cols + x;
        this.delay[i] = cellDelay(scene.transition, x, y, this.cols, this.rows, this.rnd[i]);
      }
    }
    if (instant) {
      for (let i = 0; i < next.length; i++) this.live[i] = next[i];
      this.from.set(this.live);
    }
  }

  private resize(): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    const margin = 0.75;
    this.cols = COLS;
    this.pitch = w / (this.cols + 2 * margin);
    this.rows = Math.max(3, Math.floor((h - 2 * margin * this.pitch) / this.pitch));
    this.ox = (w - this.cols * this.pitch) / 2;
    this.oy = (h - this.rows * this.pitch) / 2;
    const n = this.cols * this.rows;
    this.target = new Uint8Array(n);
    this.live = new Float32Array(n);
    this.from = new Float32Array(n);
    this.delay = new Float32Array(n);
    this.rnd = new Float32Array(n);
    this.prog = new Float32Array(n);
    this.dir = new Float32Array(n);
    this.bore = new Float32Array(n);
    for (let i = 0; i < n; i++) this.rnd[i] = hash(i * 1.37 + 0.5);
    this.applyScene(SCENES[this.sceneIdx], true);
    if (!this.running) this.draw(0);
  }

  setPointer(clientX: number | null, clientY?: number): void {
    if (clientX === null || clientY === undefined) {
      this.pointer = null;
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    this.pointer = { x: (px - this.ox) / this.pitch, y: (py - this.oy) / this.pitch };
  }

  private advance(): void {
    this.prevScene = this.sceneIdx;
    this.sceneIdx = (this.sceneIdx + 1) % SCENES.length;
    this.prevPalette = SCENES[this.prevScene].palette;
    this.paletteMix = 0;
    this.phase = "morph";
    this.phaseT = 0;
    this.styleT = 0;
    this.applyScene(SCENES[this.sceneIdx], false);
  }

  private step(dt: number): void {
    this.phaseT += dt * 1000;
    if (this.phase === "hold" && this.phaseT >= HOLD_MS) {
      this.advance();
    } else if (this.phase === "morph" && this.phaseT >= MORPH_MS) {
      this.phase = "hold";
      this.phaseT = 0;
    }
    const p = this.phase === "morph" ? Math.min(1, this.phaseT / MORPH_MS) : 1;
    const n = this.cols * this.rows;
    for (let i = 0; i < n; i++) {
      const d = this.delay[i];
      const local = Math.min(1, Math.max(0, (p - d * 0.72) / 0.28));
      const e = easeOut(local);
      this.live[i] = this.from[i] + (this.target[i] - this.from[i]) * e;
      const changing = this.from[i] !== this.target[i] && this.phase === "morph";
      this.prog[i] = changing ? local : 0;
      this.dir[i] = this.target[i] > this.from[i] ? 1 : -1;
    }
    this.paletteMix = Math.min(1, this.paletteMix + dt * 1.6);
    this.styleT = this.phase === "morph" ? Math.min(1, this.styleT + dt / (MORPH_MS / 1000)) : 1;
    styleField(SCENES[this.sceneIdx], this.cols, this.rows, this.styleT, this.bore, SCENES[this.prevScene]);
  }

  private draw(dt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.step(dt);
    const W = this.canvas.width;
    const H = this.canvas.height;
    const s = this.dpr;
    const scene = SCENES[this.sceneIdx];
    const [cA, bA] = this.palettes[this.prevPalette % this.palettes.length];
    const [cB, bB] = this.palettes[scene.palette % this.palettes.length];
    const m = easeInOut(this.paletteMix);
    const circle = mixHex(cA, cB, m);
    const back = mixHex(bA, bB, m);
    ctx.fillStyle = back;
    ctx.fillRect(0, 0, W, H);
    const pitch = this.pitch * s;
    const r = pitch / 2;
    ctx.fillStyle = circle;
    const path = new Path2D();
    const stroke = Math.max(1.1 * s, r * 0.3);
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const i = y * this.cols + x;
        let v = this.live[i];
        if (v <= 0.004) continue;
        if (this.pointer) {
          const d = Math.hypot(x + 0.5 - this.pointer.x, y + 0.5 - this.pointer.y);
          if (d < BRUSH) v *= Math.min(1, (d / BRUSH) ** 2);
        }
        if (v <= 0.004) continue;
        const mo = cellMotion(scene.transition, this.prog[i], this.dir[i], this.rnd[i]);
        const cx = this.ox * s + (x + 0.5) * pitch + mo.dx * pitch;
        const cy = this.oy * s + (y + 0.5) * pitch + mo.dy * pitch;
        const rr = r * v * mo.scale;
        if (rr <= 0.3) continue;
        const canRing = rr > 3.2 * s;
        const bore = canRing ? (rr - stroke) * this.bore[i] : 0;
        path.moveTo(cx + rr, cy);
        path.arc(cx, cy, rr, 0, Math.PI * 2);
        if (bore > 0.4) {
          path.moveTo(cx + bore, cy);
          path.arc(cx, cy, bore, 0, Math.PI * 2, true);
        }
      }
    }
    ctx.fill(path, "evenodd");
  }

  renderStill(): void {
    this.phase = "hold";
    this.phaseT = 0;
    this.paletteMix = 1;
    this.applyScene(SCENES[this.sceneIdx], true);
    this.draw(0);
  }

  start(): void {
    if (this.running || !this.ok || this.disposed) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      const dt = Math.min((now - this.last) / 1000, 1 / 30);
      this.last = now;
      this.draw(dt);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  destroy(): void {
    this.disposed = true;
    this.stop();
    this.ro?.disconnect();
    this.ro = null;
    this.ctx = null;
    this.canvas.remove();
  }
}

export function mountDotCut(host: HTMLElement): () => void {
  const fontFamily = getComputedStyle(host).fontFamily || "sans-serif";
  const engine = new DotCut(host, fontFamily);
  if (!engine.ok) {
    engine.destroy();
    return () => undefined;
  }
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const gate = (host.closest(".signin") as HTMLElement | null) ?? host;
  const onMove = (ev: PointerEvent) => {
    engine.setPointer(ev.clientX, ev.clientY);
  };
  const onLeave = () => {
    engine.setPointer(null);
  };
  const onVisibility = () => {
    if (reduced) return;
    if (document.hidden) engine.stop();
    else engine.start();
  };
  if (reduced) {
    engine.renderStill();
  } else {
    gate.addEventListener("pointermove", onMove);
    gate.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", onVisibility);
    engine.start();
  }
  return () => {
    gate.removeEventListener("pointermove", onMove);
    gate.removeEventListener("pointerleave", onLeave);
    document.removeEventListener("visibilitychange", onVisibility);
    engine.destroy();
  };
}
