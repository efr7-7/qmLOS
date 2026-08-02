import { html, nothing, type TemplateResult } from "lit";

export const PLAY_HUES = [
  "var(--play-violet)",
  "var(--play-amber)",
  "var(--play-coral)",
  "var(--play-sky)",
] as const;

export function playHue(seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  return PLAY_HUES[h % PLAY_HUES.length]!;
}

export type Motif = "folder" | "file" | "clock" | "key" | "rocket" | "brain" | "cube" | "pulse";

const CELL_CLASS: Record<string, string> = {
  v: "px-violet",
  V: "px-violet soft",
  a: "px-amber",
  A: "px-amber soft",
  c: "px-coral",
  C: "px-coral soft",
  s: "px-sky",
  S: "px-sky soft",
  g: "px-green",
  G: "px-green soft",
  x: "px-sky tw tw-1",
  y: "px-amber tw tw-2",
  z: "px-coral tw tw-3",
  w: "px-violet tw tw-2",
};

const MOTIFS: Record<Motif, string[]> = {
  folder: [
    "..........x.",
    ".aaaa.......",
    ".aaaaaaaaa..",
    ".aAAAAAAAa..",
    ".aAAAAAAAa..",
    ".aAAAAAAAa..",
    ".aaaaaaaaa..",
    "z...........",
  ],
  file: [
    "..ssssss....",
    "..sSSSSss...",
    "..sSSSSsss.y",
    "..sSvvvSSs..",
    "..sSSSSSSs..",
    "..sSvvvvSs..",
    "..sSSSSSSs..",
    "z.ssssssss..",
  ],
  clock: [
    "...aaaa....x",
    "..aAAAAa....",
    ".aAAvAAAa...",
    ".aAAvAAAa...",
    ".aAAvvvAa...",
    ".aAAAAAAa...",
    "..aAAAAa....",
    "z..aaaa.....",
  ],
  key: [
    "..........x.",
    ".vvvv.......",
    ".vVVvvvvvvv.",
    ".vVVvvvvvvv.",
    ".vvvv...v.v.",
    "........v.v.",
    "y...........",
  ],
  rocket: [
    ".....cc....x",
    "....cCCc....",
    "....cCCc....",
    "...ccsscc...",
    "...cCssCc...",
    "..cccCCccc..",
    "..c.cCCc.c..",
    "y...aaaa....",
    ".....aa.....",
  ],
  brain: [
    "..vvv.vvv..x",
    ".vVVvvvVVv..",
    ".vVVVvVVVv..",
    ".vvVVVVVvv..",
    "..vVVVVVv...",
    "..vvvVvvv...",
    "z....v......",
  ],
  cube: [
    "...........x",
    ".vvvvvvvv...",
    ".vVVaaVVv...",
    ".vvvaavvv...",
    ".vVVaaVVv...",
    ".vVVaaVVv...",
    ".vvvvvvvv...",
    "z...........",
  ],
  pulse: [
    ".....cc.....",
    "....c..c...x",
    "....c..c....",
    "ggggc..cgggg",
    "y...........",
  ],
};

function motifTpl(name: Motif): TemplateResult {
  const rows = MOTIFS[name];
  const cols = rows[0]?.length ?? 0;
  const cells: TemplateResult[] = [];
  for (const row of rows) {
    for (const ch of row) {
      const cls = CELL_CLASS[ch];
      cells.push(html`<i class=${cls ? `px ${cls}` : "px"}></i>`);
    }
  }
  return html`<div class="px-art" style=${`--px-cols:${cols}`} aria-hidden="true">${cells}</div>`;
}

export function emptyPlayground(
  motif: Motif,
  title: string,
  sub: string,
  action?: TemplateResult,
): TemplateResult {
  return html`<div class="empty playground-empty">
    ${motifTpl(motif)}
    <div class="playground-empty-title">${title}</div>
    <div class="playground-empty-sub">${sub}</div>
    ${action ?? nothing}
  </div>`;
}
