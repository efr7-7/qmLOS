import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

/**
 * The API pairs a refusal with a hint that says what to do instead. errMessage() only
 * ever reads e.message, so a hint left on a separate field is invisible to the person
 * who needs it — which is how "No conversations found in that export." reached users
 * without the sentence naming which export to upload.
 */
function installDom(): void {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: "http://localhost/web-ui/" });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    location: dom.window.location,
    navigator: dom.window.navigator,
  }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

async function callApi(body: unknown, status: number): Promise<{ message: string; hint?: string }> {
  installDom();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { api } = await vite.ssrLoadModule("/src/core-bridge.ts");
    const { errMessage } = await vite.ssrLoadModule("../chassis/src/errors.ts");
    try {
      await api("/api/memory/import", { method: "POST", body: "{}" });
      throw new Error("expected the call to reject");
    } catch (e) {
      return { message: errMessage(e, "fallback"), hint: (e as { hint?: string }).hint };
    }
  } finally {
    await vite.close();
  }
}

test("a refusal's hint reaches the person reading the error, not just the JSON", async () => {
  const seen = await callApi(
    {
      error: "unparsable_import",
      message: "No conversations found in that export.",
      hint: "Upload conversations.json from a Claude export (entries carry a chat_messages list) or a ChatGPT export (entries carry a mapping).",
    },
    422,
  );
  assert.match(seen.message, /No conversations found in that export\./, "the refusal is stated");
  assert.match(seen.message, /ChatGPT export/, "and the hint telling them what to upload comes with it");
  assert.match(seen.hint ?? "", /chat_messages/, "the hint is also available on its own");
});

test("an error with no hint is unchanged — no trailing separator, no undefined", async () => {
  const seen = await callApi({ error: "bad_request", message: "That file is empty." }, 400);
  assert.equal(seen.message, "That file is empty.");
  assert.equal(seen.hint, undefined);
});

test("a body with neither message nor hint still yields something readable", async () => {
  const seen = await callApi({}, 500);
  assert.equal(seen.message, "HTTP 500");
});
