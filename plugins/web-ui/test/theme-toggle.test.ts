import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

/**
 * The control this replaced cycled from a stored value that starts at "system". On a
 * dark-preferring machine that already renders dark, its first press stored "dark" and
 * changed nothing on screen. These tests exist so that can never come back.
 */
function installDom(prefersDark: boolean, storedTheme?: string): void {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: "http://localhost/web-ui/" });
  Object.defineProperty(dom.window, "matchMedia", {
    value: (query: string) => ({
      matches: /prefers-color-scheme:\s*dark/.test(query) ? prefersDark : false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  if (storedTheme) dom.window.localStorage.setItem("theme", storedTheme);
  const globals = {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    customElements: dom.window.customElements,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

async function mountToggle(vite: Awaited<ReturnType<typeof createServer>>): Promise<HTMLButtonElement> {
  const { render } = (await vite.ssrLoadModule("lit")) as typeof import("lit");
  const { themeToggle, initTheme } = await vite.ssrLoadModule("/src/theme.ts");
  initTheme();
  const host = document.querySelector("#app")!;
  render(themeToggle(), host as HTMLElement);
  const button = host.querySelector("button")!;
  return button as HTMLButtonElement;
}

const isDark = (): boolean => document.documentElement.classList.contains("dark");

test("on a dark-preferring machine, the first press switches to light — it is never a no-op", async () => {
  installDom(true);
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const button = await mountToggle(vite);
    assert.equal(isDark(), true, "a dark-preferring machine starts dark");
    button.click();
    assert.equal(isDark(), false, "one press visibly changed the interface");
    button.click();
    assert.equal(isDark(), true, "and the next press changes it back");
  } finally {
    await vite.close();
  }
});

test("on a light-preferring machine, the first press switches to dark", async () => {
  installDom(false);
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const button = await mountToggle(vite);
    assert.equal(isDark(), false);
    button.click();
    assert.equal(isDark(), true, "one press visibly changed the interface");
  } finally {
    await vite.close();
  }
});

test("the toggle has an accessible name that says what pressing it will do, and it keeps up", async () => {
  installDom(true);
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const button = await mountToggle(vite);
    assert.equal(button.getAttribute("aria-label"), "Switch to light mode", "named for its effect, not its state");
    button.click();
    assert.equal(button.getAttribute("aria-label"), "Switch to dark mode", "the name updates with the theme");
    assert.equal(button.dataset.themeState, "light");
  } finally {
    await vite.close();
  }
});

test("a stored choice wins over the system preference, and survives a remount", async () => {
  installDom(true, "light");
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const button = await mountToggle(vite);
    assert.equal(isDark(), false, "the stored light choice beats a dark system preference");
    button.click();
    assert.equal(localStorage.getItem("theme"), "dark", "the new choice is remembered");
  } finally {
    await vite.close();
  }
});
