import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = "D:/qmLOS/local/qa";
const PORT = 9533;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=C:/Users/elyss/AppData/Local/Temp/claude/qa-shot-profile`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1440,900",
  "--headless=new", "--hide-scrollbars", "--enable-unsafe-swiftshader", "about:blank",
], { stdio: "ignore" });

let wsUrl;
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (r.ok) wsUrl = (await r.json()).webSocketDebuggerUrl;
  } catch { /* retry */ }
  if (!wsUrl) await sleep(400);
}
if (!wsUrl) { console.error("no cdp"); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { if (pending.delete(id)) rej(new Error(`${method} timeout`)); }, 30_000);
  });

const { targetId } = await send("Target.createTarget", { url: "http://localhost:8096/" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1200, deviceScaleFactor: 2, mobile: false }, sessionId);
await sleep(9000);

const evalx = async (expr) =>
  (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId))?.result?.value;

const shot = async (name) => {
  const s = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, "base64"));
};

const nav = process.argv[2] ?? "Governance";
console.log("nav ->", nav, await evalx(`(() => { const rows=[...document.querySelectorAll('.navrow')]; const r=rows.find(x=>x.textContent.trim().startsWith(${JSON.stringify(nav)})); if(r){r.click();return true;} return [...document.querySelectorAll('.navrow')].map(x=>x.textContent.trim()); })()`));
await sleep(4000);
await shot(`qa-${nav.toLowerCase()}-1`);

const step = process.argv[3];
if (step) {
  console.log("step ->", await evalx(step));
  await sleep(3500);
  await shot(`qa-${nav.toLowerCase()}-2`);
}

console.log("done");
ws.close();
chrome.kill();
process.exit(0);
