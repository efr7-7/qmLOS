import { html, type TemplateResult } from "lit";
import { createElement, type IconNode } from "lucide";

export function brandName(): string {
  if (typeof document === "undefined") return "QM";
  return document.querySelector<HTMLMetaElement>('meta[name="brand-self-label"]')?.content || "QM";
}

export function brandMark(): TemplateResult {
  return html`<span class="brand-mark" aria-hidden="true"></span>`;
}

export function icon(node: IconNode, size = 18): SVGElement {
  const el = createElement(node, {
    class: "icon",
    width: size,
    height: size,
    "aria-hidden": "true",
    focusable: "false",
    "stroke-width": 1.9,
  });
  return el;
}

const ASCII_RAMP = [" ", " ", " ", " ", " ", "·", "·", "·", ":", "░", "▒"];

export function asciiField(cols: number, rows: number): string {
  const lines: string[] = [];
  for (let y = 0; y < rows; y++) {
    let line = "";
    for (let x = 0; x < cols; x++) {
      const v =
        Math.sin(x * 0.21 + y * 0.37) +
        Math.sin(x * 0.083 - y * 0.19) +
        Math.sin((x + y * 1.7) * 0.127) +
        Math.sin(Math.hypot(x - cols * 0.7, y - rows * 0.32) * 0.31);
      const t = (v + 4) / 8;
      const idx = Math.min(ASCII_RAMP.length - 1, Math.max(0, Math.floor(t * ASCII_RAMP.length)));
      line += ASCII_RAMP[idx];
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export function initials(s: string): string {
  const base = (s.split("@")[0] || s).trim();
  const parts = base.split(/[.\-_ ]+/).filter(Boolean);
  const two = parts.length >= 2 ? (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "") : base.slice(0, 2);
  return (two || "?").toUpperCase();
}

export function relTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const RENDERABLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "image/bmp",
  "image/apng",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/x-ms-bmp",
]);

export function browserRenderableImage(mimeType?: string): boolean {
  return RENDERABLE_IMAGE_TYPES.has((mimeType ?? "").split(";")[0]!.trim().toLowerCase());
}

const copyFeedback = new WeakMap<HTMLButtonElement, { html: string; timer: ReturnType<typeof setTimeout> }>();

export async function copyText(text: string, btn?: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const active = copyFeedback.get(btn);
      if (active) clearTimeout(active.timer);
      const html = active?.html ?? btn.innerHTML;
      btn.textContent = "Copied";
      const timer = setTimeout(() => {
        btn.innerHTML = html;
        copyFeedback.delete(btn);
      }, 1200);
      copyFeedback.set(btn, { html, timer });
    }
  } catch {
    void 0;
  }
}

export function actionSnippet(action: string): string {
  const s = action.trim().replace(/\s+/g, " ");
  return s.length > 48 ? `${s.slice(0, 47)}…` : s || "(no action)";
}

export function closeFormMenus(): boolean {
  let closed = false;
  document.querySelectorAll<HTMLElement>(".form-menu-control.open").forEach((control) => {
    control.classList.remove("open");
    control.querySelector<HTMLButtonElement>(".menu-button")?.setAttribute("aria-expanded", "false");
    const menu = control.querySelector<HTMLElement>(".menu-popover");
    if (menu) menu.hidden = true;
    closed = true;
  });
  return closed;
}

export function toggleFormMenu(e: Event): void {
  e.stopPropagation();
  const control = (e.currentTarget as HTMLElement).closest(".form-menu-control") as HTMLElement | null;
  if (!control) return;
  const wasOpen = control.classList.contains("open");
  closeFormMenus();
  control.classList.toggle("open", !wasOpen);
  const open = !wasOpen;
  control.querySelector<HTMLButtonElement>(".menu-button")?.setAttribute("aria-expanded", open ? "true" : "false");
  const menu = control.querySelector<HTMLElement>(".menu-popover");
  if (menu) menu.hidden = !open;
}
