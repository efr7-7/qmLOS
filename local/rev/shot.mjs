import { writeFileSync } from "node:fs";

const HOST = "http://127.0.0.1:9222";

async function listTargets() {
  const r = await fetch(`${HOST}/json/list`);
  return await r.json();
}

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

async function main() {
  const [, , url, outPath, script, themeArg, fullArg] = process.argv;
  const tab = await newTab("about:blank");
  const cdp = await connect(tab.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  if (themeArg) {
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: themeArg }],
    });
  }
  await cdp.send("Page.navigate", { url });
  await sleep(4500);
  if (script) {
    const r = await cdp.send("Runtime.evaluate", {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
    });
    console.log("SCRIPT:", JSON.stringify(r.result?.value ?? r.exceptionDetails?.text ?? null));
    await sleep(2500);
  }
  const params = { format: "png", captureBeyondViewport: fullArg === "full" };
  if (fullArg === "full") {
    const m = await cdp.send("Page.getLayoutMetrics");
    params.clip = {
      x: 0,
      y: 0,
      width: 1440,
      height: Math.min(6000, Math.ceil(m.cssContentSize.height)),
      scale: 1,
    };
  }
  const shot = await cdp.send("Page.captureScreenshot", params);
  writeFileSync(outPath, Buffer.from(shot.data, "base64"));
  console.log("WROTE", outPath);
  await fetch(`${HOST}/json/close/${tab.id}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
