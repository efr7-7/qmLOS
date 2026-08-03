import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const env = Object.fromEntries(
  readFileSync("D:/qmLOS/.env", "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const CORE_SECRET = env.CORE_SIGNING_SECRET;
const PORTAL_SECRET = env.PORTAL_IDENTITY_SECRET;

export function mintPortal(p, ttlMs = 300000) {
  const payload = Buffer.from(JSON.stringify({ p, n: p, exp: Date.now() + ttlMs })).toString("base64url");
  return `${payload}.${createHmac("sha256", PORTAL_SECRET).update(payload).digest("base64url")}`;
}

function nonced(pathWithQuery) {
  const u = new URL(pathWithQuery, "http://core.local");
  u.searchParams.set("_sourceAuthNonce", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return `${u.pathname}${u.search}`;
}

export async function core(method, pathWithQuery, body, asPrincipal) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const p = nonced(pathWithQuery);
  const nowSec = Math.floor(Date.now() / 1000);
  const canonical = `${method}\n${p}\n${raw}`;
  const headers = {
    "content-type": "application/json",
    "x-timestamp": String(nowSec),
    "x-signature": `v0=${createHmac("sha256", CORE_SECRET).update(`v0:${nowSec}:${canonical}`).digest("hex")}`,
  };
  if (asPrincipal) headers["x-portal-identity"] = mintPortal(asPrincipal);
  const r = await fetch(`http://localhost:8085${p}`, { method, headers, ...(raw ? { body: raw } : {}) });
  return { status: r.status, text: await r.text() };
}
