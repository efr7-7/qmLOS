import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");
const examplePath = resolve(root, ".env.example");

const SECRETS = [
  "CORE_SIGNING_SECRET",
  "CAPABILITY_SECRET",
  "PORTAL_IDENTITY_SECRET",
  "CONNECTOR_SECRET_KEY",
  "SKILL_SIGNING_SECRET",
];

const force = process.argv.includes("--force");

function seed() {
  return randomBytes(32).toString("base64url");
}

let source = "";
let created = false;
if (existsSync(envPath)) {
  source = readFileSync(envPath, "utf8");
} else if (existsSync(examplePath)) {
  source = readFileSync(examplePath, "utf8");
  created = true;
} else {
  created = true;
}

const eol = source.includes("\r\n") ? "\r\n" : "\n";
const lines = source.length ? source.split(/\r?\n/) : [];
const filled = [];
const kept = [];

for (const name of SECRETS) {
  const at = lines.findIndex((line) => new RegExp(`^\\s*${name}\\s*=`).test(line));
  const current = at === -1 ? "" : (lines[at].split("=").slice(1).join("=") ?? "").trim();
  if (current && !force) {
    kept.push(name);
    continue;
  }
  const line = `${name}=${seed()}`;
  if (at === -1) lines.push(line);
  else lines[at] = line;
  filled.push(name);
}

if (filled.length || created) {
  const body = lines.join(eol);
  writeFileSync(envPath, body.endsWith(eol) ? body : `${body}${eol}`, "utf8");
}

const where = created ? "created .env" : "updated .env";
if (filled.length) console.log(`${where} — generated ${filled.length} secret(s): ${filled.join(", ")}`);
else console.log(".env already has all five signing secrets — nothing to do (use --force to rotate them)");
if (kept.length && !force) console.log(`left alone: ${kept.join(", ")}`);
console.log("Set ADMIN_GRANTS=<your-sign-in-id>:org_admin before first boot, then run `npm run dev`.");
