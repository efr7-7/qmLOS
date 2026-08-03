import { writeFileSync } from "node:fs";

const HOST = "http://127.0.0.1:9222";
const WIDTH = 1440;
const BASE_HEIGHT = 900;

async function newTab(url) {
  const r = await fetch(`${HOST}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  return await r.json();
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout ${method}`));
        }
      }, 60000);
    });
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  return new Cdp(ws);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MEASURE = `(() => {
  let best = document.documentElement.scrollHeight;
  document.querySelectorAll('*').forEach((el) => {
    if (el.scrollHeight > el.clientHeight + 8 && el.clientHeight > 200) {
      const top = el.getBoundingClientRect().top + window.scrollY;
      best = Math.max(best, top + el.scrollHeight);
    }
  });
  return Math.ceil(best);
})()`;

async function measure(cdp) {
  const r = await cdp.send("Runtime.evaluate", { expression: MEASURE, returnByValue: true });
  return Number(r.result?.value) || BASE_HEIGHT;
}

async function setViewport(cdp, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });
}

async function main() {
  const [, , url, outPath, theme, mode] = process.argv;
  const tab = await newTab("about:blank");
  const cdp = await connect(tab.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await setViewport(cdp, BASE_HEIGHT);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: theme || "dark" }],
  });
  await cdp.send("Page.navigate", { url });
  await sleep(7000);

  let height = BASE_HEIGHT;
  if (mode === "full") {
    for (let i = 0; i < 4; i++) {
      const next = Math.min(8000, await measure(cdp));
      if (next <= height + 4) break;
      height = next;
      await setViewport(cdp, height);
      await sleep(1800);
    }
  }

  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelectorAll('*').forEach((el) => { if (el.scrollTop) el.scrollTop = 0; }); window.scrollTo(0, 0);`,
    returnByValue: true,
  });
  await sleep(1200);

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(outPath, Buffer.from(shot.data, "base64"));
  console.log(`WROTE ${outPath} ${WIDTH}x${height}`);
  await fetch(`${HOST}/json/close/${tab.id}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
