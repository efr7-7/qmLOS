/* LOS marketing site — no dependencies.
   1) DotCut: the circle-mesh hero engine, ported from the product's
      plugins/web-ui/src/dotcut.ts (plain JS, palette inlined).
   2) Pixel sprites: procedural empty-state motifs.
*/
(function () {
  "use strict";

  /* ================= DotCut ================= */

  var COLS = 42;
  var HOLD_MS = 2600;
  var MORPH_MS = 700;
  var BRUSH = 1.6;
  var CANVAS_BG = "#0b0d10";
  var ACCENT = "#34d9ab";

  var SCENES = [
    { kind: "text", value: "L", transition: "wipe", palette: 0, style: "drift" },
    { kind: "rings", transition: "ripple", palette: 1, style: "grain" },
    { kind: "columns", transition: "columns", palette: 2, style: "streak" },
    { kind: "checker", transition: "scatter", palette: 3, style: "swell" },
    { kind: "boxes", transition: "collapse", palette: 4, style: "grain" },
    { kind: "bars", transition: "wipe", palette: 5, style: "drift" },
  ];

  var PALETTES = [
    [ACCENT, CANVAS_BG],
    ["#a78bfa", "#120f1f"],
    ["#2dd4bf", "#04201b"],
    ["#fbbf24", "#161105"],
    ["#38bdf8", "#07131d"],
    ["#fb7185", "#1a0b11"],
  ];

  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  function smooth01(v, e0, e1) {
    var t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }

  function hash2(x, y) {
    var s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  }

  function hash(n) {
    var s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  }

  function mixHex(a, b, t) {
    var pa = parseInt(a.slice(1), 16);
    var pb = parseInt(b.slice(1), 16);
    var r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
    var g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
    var bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
    return "rgb(" + r + "," + g + "," + bl + ")";
  }

  function cellMotion(kind, t, dir, rand) {
    var u = Math.sin(Math.min(1, Math.max(0, t)) * Math.PI);
    switch (kind) {
      case "wipe": return { scale: 1, dx: u * 0.16 * -dir, dy: 0 };
      case "ripple": return { scale: 1 - u * 0.1, dx: 0, dy: u * -0.13 };
      case "scatter":
        return {
          scale: 1,
          dx: u * 0.18 * Math.cos(rand * Math.PI * 2),
          dy: u * 0.18 * Math.sin(rand * Math.PI * 2),
        };
      case "collapse": return { scale: 1 - u * 0.18, dx: 0, dy: 0 };
      case "columns": return { scale: 1, dx: 0, dy: u * 0.22 };
    }
    return { scale: 1, dx: 0, dy: 0 };
  }

  function cellDelay(kind, x, y, cols, rows, rand) {
    var fx = cols > 1 ? x / (cols - 1) : 0;
    var fy = rows > 1 ? y / (rows - 1) : 0;
    var d;
    switch (kind) {
      case "wipe":
        return Math.min(1, Math.max(0, (fx * 0.75 + fy * 0.25) * 0.85 + rand * 0.15));
      case "ripple":
        d = Math.hypot(fx - 0.5, fy - 0.5) / 0.707;
        return Math.min(1, d * 0.9 + rand * 0.1);
      case "scatter":
        return rand;
      case "collapse":
        d = Math.hypot(fx - 0.5, fy - 0.5) / 0.707;
        return Math.min(1, (1 - d) * 0.85 + rand * 0.15);
      case "columns":
        return Math.min(1, fx * 0.9 + rand * 0.1);
    }
    return rand;
  }

  function styleField(scene, cols, rows, t, out, prev) {
    var cx = (cols - 1) / 2;
    var cy = (rows - 1) / 2;
    var maxR = Math.hypot(cols, rows) / 2;
    var FLIP = 0.32;
    function stateOf(style, x, y) {
      switch (style) {
        case "drift": {
          var a = Math.sin(x * 0.41 + y * 0.23);
          var b = Math.sin(x * 0.17 - y * 0.53 + 2.1);
          return smooth01((a + b) * 0.5, -0.15, 0.75);
        }
        case "grain": {
          var n = hash2(x, y) * 0.55 + hash2(x + 1, y) * 0.15 + hash2(x, y + 1) * 0.15 + hash2(x + 1, y + 1) * 0.15;
          return smooth01(n, 0.34, 0.86);
        }
        case "swell": {
          var d = Math.hypot(x - cx, y - cy) / maxR;
          var warp = Math.sin(Math.atan2(y - cy, x - cx) * 3.0) * 0.14;
          return smooth01(1 - (d + warp), 0.28, 0.92);
        }
        case "streak": {
          var s = Math.sin(x * 0.28 + y * 0.62);
          var cut = Math.sin(x * 0.09 - y * 0.11 + 1.3) * 0.5 + 0.5;
          return smooth01(s * cut, -0.05, 0.7);
        }
      }
      return 0;
    }
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        var order = 0;
        switch (scene.style) {
          case "drift": order = (x / cols) * 0.75 + Math.sin(y * 0.5) * 0.12 + 0.12; break;
          case "grain": order = (x / cols) * 0.55 + (y / rows) * 0.25 + hash2(x, y) * 0.2; break;
          case "swell": order = Math.hypot(x - cx, y - cy) / maxR; break;
          case "streak": order = (x / cols) * 0.8 + (y / rows) * 0.2; break;
        }
        var from = stateOf(prev.style, x, y);
        var to = stateOf(scene.style, x, y);
        var u = Math.min(1, Math.max(0, (t - order * (1 - FLIP)) / FLIP));
        var eased = u * u * (3 - 2 * u);
        out[y * cols + x] = from + (to - from) * eased;
      }
    }
  }

  function rasterize(scene, cols, rows, fontFamily) {
    var out = new Uint8Array(cols * rows).fill(1);
    var cx = (cols - 1) / 2;
    var cy = (rows - 1) / 2;
    var x, y, d;
    if (scene.kind === "checker") {
      var b = Math.max(2, Math.round(cols / 14));
      for (y = 0; y < rows; y++) for (x = 0; x < cols; x++) {
        if ((Math.floor(x / b) + Math.floor(y / b)) % 2 === 0) out[y * cols + x] = 0;
      }
      return out;
    }
    if (scene.kind === "bars") {
      for (y = 0; y < rows; y++) for (x = 0; x < cols; x++) {
        if (Math.floor((x + y) / 3) % 2 === 0) out[y * cols + x] = 0;
      }
      return out;
    }
    if (scene.kind === "columns") {
      var bw = 4, bh = 3;
      for (y = 0; y < rows; y++) {
        var band = Math.floor(y / bh);
        var shift = band % 2 === 0 ? 0 : bw / 2;
        for (x = 0; x < cols; x++) {
          if (Math.floor((x + shift) / bw) % 2 === 0) out[y * cols + x] = 0;
        }
      }
      return out;
    }
    if (scene.kind === "boxes") {
      for (y = 0; y < rows; y++) for (x = 0; x < cols; x++) {
        d = Math.max(Math.abs(x - cx), Math.abs(y - cy));
        if (Math.floor(d / 2.5) % 2 === 0) out[y * cols + x] = 0;
      }
      return out;
    }
    if (scene.kind === "rings") {
      var maxR = Math.hypot(cols, rows) / 2;
      for (y = 0; y < rows; y++) for (x = 0; x < cols; x++) {
        d = Math.hypot(x - cx, y - cy) / maxR;
        if (Math.floor(d * 6.0) % 2 === 0) out[y * cols + x] = 0;
      }
      return out;
    }
    var cv = document.createElement("canvas");
    cv.width = cols;
    cv.height = rows;
    var ctx = cv.getContext("2d", { willReadFrequently: true });
    if (!ctx) return out;
    var text = (scene.value || "").trim();
    if (!text) return out;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cols, rows);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var size = rows * 0.8;
    ctx.font = "700 " + size + "px " + fontFamily;
    var maxW = cols * 0.36;
    var m = ctx.measureText(text);
    if (m.width > maxW) {
      size *= maxW / m.width;
      ctx.font = "700 " + size + "px " + fontFamily;
    }
    var maxH = rows * 0.58;
    var mm = ctx.measureText(text);
    var gh = mm.actualBoundingBoxAscent + mm.actualBoundingBoxDescent;
    if (gh > maxH) {
      size *= maxH / gh;
      ctx.font = "700 " + size + "px " + fontFamily;
    }
    ctx.fillText(text, cols / 2, rows / 2 + rows * 0.02);
    var data = ctx.getImageData(0, 0, cols, rows).data;
    for (var i = 0; i < cols * rows; i++) {
      if (data[i * 4] > 110) out[i] = 0;
    }
    return out;
  }

  function DotCut(host, fontFamily) {
    this.host = host;
    this.fontFamily = fontFamily || "sans-serif";
    this.cols = COLS;
    this.rows = 12;
    this.pitch = 10;
    this.ox = 0;
    this.oy = 0;
    this.target = new Uint8Array(0);
    this.live = new Float32Array(0);
    this.from = new Float32Array(0);
    this.delay = new Float32Array(0);
    this.rnd = new Float32Array(0);
    this.prog = new Float32Array(0);
    this.dir = new Float32Array(0);
    this.bore = new Float32Array(0);
    this.styleT = 0;
    this.sceneIdx = 0;
    this.phase = "hold";
    this.phaseT = 0;
    this.paletteMix = 1;
    this.prevPalette = 0;
    this.prevScene = 0;
    this.pointer = null;
    this.raf = 0;
    this.last = 0;
    this.running = false;
    this.dpr = 1;
    this.disposed = false;
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "display:block;width:100%;height:100%";
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    if (!this.ctx) return;
    this.resize();
    var self = this;
    this.ro = new ResizeObserver(function () { self.resize(); });
    this.ro.observe(host);
  }

  DotCut.prototype.ok = function () { return !!this.ctx; };

  DotCut.prototype.applyScene = function (scene, instant) {
    var next = rasterize(scene, this.cols, this.rows, this.fontFamily);
    this.from.set(this.live);
    this.target = next;
    for (var y = 0; y < this.rows; y++) {
      for (var x = 0; x < this.cols; x++) {
        var i = y * this.cols + x;
        this.delay[i] = cellDelay(scene.transition, x, y, this.cols, this.rows, this.rnd[i]);
      }
    }
    if (instant) {
      for (var j = 0; j < next.length; j++) this.live[j] = next[j];
      this.from.set(this.live);
    }
  };

  DotCut.prototype.resize = function () {
    if (!this.ctx || this.disposed) return;
    var w = this.host.clientWidth;
    var h = this.host.clientHeight;
    if (!w || !h) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    var margin = 0.75;
    this.cols = COLS;
    this.pitch = w / (this.cols + 2 * margin);
    this.rows = Math.max(3, Math.floor((h - 2 * margin * this.pitch) / this.pitch));
    this.ox = (w - this.cols * this.pitch) / 2;
    this.oy = (h - this.rows * this.pitch) / 2;
    var n = this.cols * this.rows;
    this.target = new Uint8Array(n);
    this.live = new Float32Array(n);
    this.from = new Float32Array(n);
    this.delay = new Float32Array(n);
    this.rnd = new Float32Array(n);
    this.prog = new Float32Array(n);
    this.dir = new Float32Array(n);
    this.bore = new Float32Array(n);
    for (var i = 0; i < n; i++) this.rnd[i] = hash(i * 1.37 + 0.5);
    this.applyScene(SCENES[this.sceneIdx], true);
    if (!this.running) this.draw(0);
  };

  DotCut.prototype.setPointer = function (clientX, clientY) {
    if (clientX === null || clientY === undefined) {
      this.pointer = null;
      return;
    }
    var rect = this.canvas.getBoundingClientRect();
    var px = clientX - rect.left;
    var py = clientY - rect.top;
    this.pointer = { x: (px - this.ox) / this.pitch, y: (py - this.oy) / this.pitch };
  };

  DotCut.prototype.advance = function () {
    this.prevScene = this.sceneIdx;
    this.sceneIdx = (this.sceneIdx + 1) % SCENES.length;
    this.prevPalette = SCENES[this.prevScene].palette;
    this.paletteMix = 0;
    this.phase = "morph";
    this.phaseT = 0;
    this.styleT = 0;
    this.applyScene(SCENES[this.sceneIdx], false);
  };

  DotCut.prototype.step = function (dt) {
    this.phaseT += dt * 1000;
    if (this.phase === "hold" && this.phaseT >= HOLD_MS) {
      this.advance();
    } else if (this.phase === "morph" && this.phaseT >= MORPH_MS) {
      this.phase = "hold";
      this.phaseT = 0;
    }
    var p = this.phase === "morph" ? Math.min(1, this.phaseT / MORPH_MS) : 1;
    var n = this.cols * this.rows;
    for (var i = 0; i < n; i++) {
      var d = this.delay[i];
      var local = Math.min(1, Math.max(0, (p - d * 0.72) / 0.28));
      var e = easeOut(local);
      this.live[i] = this.from[i] + (this.target[i] - this.from[i]) * e;
      var changing = this.from[i] !== this.target[i] && this.phase === "morph";
      this.prog[i] = changing ? local : 0;
      this.dir[i] = this.target[i] > this.from[i] ? 1 : -1;
    }
    this.paletteMix = Math.min(1, this.paletteMix + dt * 1.6);
    this.styleT = this.phase === "morph" ? Math.min(1, this.styleT + dt / (MORPH_MS / 1000)) : 1;
    styleField(SCENES[this.sceneIdx], this.cols, this.rows, this.styleT, this.bore, SCENES[this.prevScene]);
  };

  DotCut.prototype.draw = function (dt) {
    var ctx = this.ctx;
    if (!ctx) return;
    this.step(dt);
    var W = this.canvas.width;
    var H = this.canvas.height;
    var s = this.dpr;
    var scene = SCENES[this.sceneIdx];
    var pa = PALETTES[this.prevPalette % PALETTES.length];
    var pb = PALETTES[scene.palette % PALETTES.length];
    var m = easeInOut(this.paletteMix);
    var circle = mixHex(pa[0], pb[0], m);
    var back = mixHex(pa[1], pb[1], m);
    ctx.fillStyle = back;
    ctx.fillRect(0, 0, W, H);
    var pitch = this.pitch * s;
    var r = pitch / 2;
    ctx.fillStyle = circle;
    var path = new Path2D();
    var stroke = Math.max(1.1 * s, r * 0.3);
    for (var y = 0; y < this.rows; y++) {
      for (var x = 0; x < this.cols; x++) {
        var i = y * this.cols + x;
        var v = this.live[i];
        if (v <= 0.004) continue;
        if (this.pointer) {
          var pd = Math.hypot(x + 0.5 - this.pointer.x, y + 0.5 - this.pointer.y);
          if (pd < BRUSH) v *= Math.min(1, Math.pow(pd / BRUSH, 2));
        }
        if (v <= 0.004) continue;
        var mo = cellMotion(scene.transition, this.prog[i], this.dir[i], this.rnd[i]);
        var cx = this.ox * s + (x + 0.5) * pitch + mo.dx * pitch;
        var cy = this.oy * s + (y + 0.5) * pitch + mo.dy * pitch;
        var rr = r * v * mo.scale;
        if (rr <= 0.3) continue;
        var canRing = rr > 3.2 * s;
        var bore = canRing ? (rr - stroke) * this.bore[i] : 0;
        path.moveTo(cx + rr, cy);
        path.arc(cx, cy, rr, 0, Math.PI * 2);
        if (bore > 0.4) {
          path.moveTo(cx + bore, cy);
          path.arc(cx, cy, bore, 0, Math.PI * 2, true);
        }
      }
    }
    ctx.fill(path, "evenodd");
  };

  DotCut.prototype.renderStill = function () {
    this.phase = "hold";
    this.phaseT = 0;
    this.paletteMix = 1;
    this.applyScene(SCENES[this.sceneIdx], true);
    this.draw(0);
  };

  DotCut.prototype.start = function () {
    if (this.running || !this.ok() || this.disposed) return;
    this.running = true;
    this.last = performance.now();
    var self = this;
    function tick(now) {
      if (!self.running) return;
      var dt = Math.min((now - self.last) / 1000, 1 / 30);
      self.last = now;
      self.draw(dt);
      self.raf = requestAnimationFrame(tick);
    }
    this.raf = requestAnimationFrame(tick);
  };

  DotCut.prototype.stop = function () {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  };

  function mountDotCut() {
    var host = document.getElementById("dotcut");
    if (!host) return;
    var fontFamily = getComputedStyle(document.body).fontFamily || "sans-serif";
    var engine = new DotCut(host, fontFamily);
    if (!engine.ok()) return;
    var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      engine.renderStill();
      return;
    }
    var gate = host.closest(".hero") || host;
    gate.addEventListener("pointermove", function (ev) {
      engine.setPointer(ev.clientX, ev.clientY);
    });
    gate.addEventListener("pointerleave", function () {
      engine.setPointer(null);
    });
    var heroVisible = true;
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        heroVisible = entries[0].isIntersecting;
        if (!heroVisible) engine.stop();
        else if (!document.hidden) engine.start();
      }, { threshold: 0.02 }).observe(gate);
    }
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) engine.stop();
      else if (heroVisible) engine.start();
    });
    engine.start();
  }

  /* ================= pixel sprites ================= */
  /* Recreations of the app's empty-state motifs.
     '.' empty · 'x' body hue · 'o' detail · 'f' flame/extra */

  var SPRITES = {
    folder: {
      map: [
        "..........",
        ".xxxx.....",
        ".xxxxxxxx.",
        ".xoooooox.",
        ".xoooooox.",
        ".xoooooox.",
        ".xxxxxxxx.",
        "..........",
      ],
      colors: { x: "#fbbf24", o: "rgba(251,191,36,0.28)" },
    },
    clock: {
      map: [
        "...xxx...",
        "..x...x..",
        ".x..o..x.",
        "x...o...x",
        "x...oo..x",
        "x.......x",
        ".x.....x.",
        "..x...x..",
        "...xxx...",
      ],
      colors: { x: "#38bdf8", o: "#e9edf3" },
    },
    rocket: {
      map: [
        "....x....",
        "...xxx...",
        "...xxx...",
        "..xxxxx..",
        "..xxoxx..",
        "..xxxxx..",
        ".xxxxxxx.",
        ".x.xxx.x.",
        "...f.f...",
        "....f....",
      ],
      colors: { x: "#fb7185", o: "#e9edf3", f: "#fbbf24" },
    },
    pulse: {
      map: [
        ".....o.......",
        ".....o.......",
        "....o.o......",
        "xxxx...o.xxxx",
        ".......o.....",
        "........o....",
        ".............",
      ],
      colors: { x: "#a78bfa", o: "#34d9ab" },
    },
  };

  function buildSprites() {
    var nodes = document.querySelectorAll(".sprite[data-sprite]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var def = SPRITES[el.getAttribute("data-sprite")];
      if (!def) continue;
      var rows = def.map.length;
      var cols = def.map[0].length;
      el.style.gridTemplateColumns = "repeat(" + cols + ", var(--px, 9px))";
      el.style.gridTemplateRows = "repeat(" + rows + ", var(--px, 9px))";
      var frag = document.createDocumentFragment();
      for (var y = 0; y < rows; y++) {
        for (var x = 0; x < cols; x++) {
          var ch = def.map[y][x];
          var cell = document.createElement("span");
          if (ch !== "." && def.colors[ch]) cell.style.background = def.colors[ch];
          frag.appendChild(cell);
        }
      }
      el.appendChild(frag);
    }
  }

  /* ================= boot ================= */

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      mountDotCut();
      buildSprites();
    });
  } else {
    mountDotCut();
    buildSprites();
  }
})();
