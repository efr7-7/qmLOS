import { html, render, type TemplateResult } from "lit";
import { Moon, Sun } from "lucide";
import { icon } from "./ui";

/**
 * Theme ownership.
 *
 * This replaces mini-lit's <theme-toggle>, which cycled ["light","dark"] from a stored
 * value that starts at "system". On a machine that prefers dark — the default this app
 * is designed for — "system" already renders dark, and the first click stored "dark":
 * visually nothing happened, and only the second click did anything. A control whose
 * first press appears to do nothing reads as broken.
 *
 * We cycle from what is *on screen* rather than from what is stored, so one press always
 * flips the interface. The "theme" storage key and the `dark` class on <html> are kept
 * identical to before, so anything else reading either keeps working.
 */
export type Theme = "light" | "dark";

const KEY = "theme";
const listeners = new Set<() => void>();

function stored(): Theme | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null; // private mode / storage disabled — fall back to the system preference
  }
}

function systemPrefers(): Theme {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** What the user is actually looking at right now. */
export function activeTheme(): Theme {
  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) return "dark";
  return stored() ?? systemPrefers();
}

export function applyTheme(): void {
  if (typeof document === "undefined") return;
  const theme = stored() ?? systemPrefers();
  document.documentElement.classList.toggle("dark", theme === "dark");
  for (const notify of listeners) notify();
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* still apply for this session even if we cannot remember it */
  }
  if (typeof document !== "undefined") document.documentElement.classList.toggle("dark", theme === "dark");
  for (const notify of listeners) notify();
}

/** Flip away from whatever is on screen, so the first press always visibly does something. */
export function toggleTheme(): Theme {
  const next: Theme = activeTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function initTheme(): void {
  if (typeof window === "undefined") return;
  applyTheme();
  // Follow the OS only while the user has not made a choice of their own.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!stored()) applyTheme();
  });
}

/**
 * The control. It is a real button with an accessible name that states what pressing it
 * will do, which the element it replaces did not have.
 */
function labelFor(theme: Theme): string {
  return theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
}

export function themeToggle(onToggle?: (theme: Theme) => void): TemplateResult {
  const active = activeTheme();
  return html`<button
    class="icon-btn subtle theme-toggle"
    type="button"
    title=${labelFor(active)}
    aria-label=${labelFor(active)}
    data-theme-state=${active}
    @click=${(e: Event) => {
      const next = toggleTheme();
      // Repaint in place rather than asking the shell to re-render: the control stays
      // correct wherever it is mounted, and pressing it can never be a no-op.
      const button = e.currentTarget as HTMLButtonElement;
      button.title = labelFor(next);
      button.setAttribute("aria-label", labelFor(next));
      button.dataset.themeState = next;
      render(icon(next === "dark" ? Sun : Moon, 17), button);
      onToggle?.(next);
    }}
  >
    ${icon(active === "dark" ? Sun : Moon, 17)}
  </button>`;
}
