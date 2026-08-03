import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const env = Object.fromEntries(
  readFileSync("D:/qmLOS/.env", "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const SECRET = env.PORTAL_IDENTITY_SECRET;

export function mint(p, ttlMs = 300000) {
  const payload = Buffer.from(JSON.stringify({ p, n: p, exp: Date.now() + ttlMs })).toString("base64url");
  return `${payload}.${createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
}

export async function portal(as, method, path, body) {
  const r = await fetch(`http://localhost:8096${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-portal-identity": mint(as),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, text: await r.text() };
}

export const ENV = env;
