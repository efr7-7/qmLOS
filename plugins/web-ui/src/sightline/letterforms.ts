export type Stroke = Array<[number, number]>;

export interface Letter {
  width: number;
  strokes: Stroke[];
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number, n = 48): Stroke {
  const pts: Stroke = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

function bezier(
  p0: [number, number],
  c1: [number, number],
  c2: [number, number],
  p3: [number, number],
  n = 40,
): Stroke {
  const pts: Stroke = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1],
    ]);
  }
  return pts;
}

export const LETTERS: Record<string, Letter> = {
  L: {
    width: 0.58,
    strokes: [
      [
        [0.04, 0.02],
        [0.04, 0.98],
        [0.58, 0.98],
      ],
    ],
  },
  O: {
    width: 0.96,
    strokes: [arc(0.48, 0.5, 0.44, -Math.PI / 2, (3 * Math.PI) / 2)],
  },
  S: {
    width: 0.76,
    strokes: [
      [
        ...bezier([0.71, 0.09], [0.5, -0.02], [0.06, 0.0], [0.06, 0.25]),
        ...bezier([0.06, 0.25], [0.06, 0.48], [0.7, 0.52], [0.7, 0.75]),
        ...bezier([0.7, 0.75], [0.7, 1.0], [0.26, 1.02], [0.05, 0.91]),
      ],
    ],
  },
};

export interface PlannedStroke {
  points: Stroke;
  length: number;
  cumStart: number;
}

export function planWord(
  word: string,
  x: number,
  y: number,
  em: number,
  tracking: number,
): { strokes: PlannedStroke[]; total: number; width: number } {
  const strokes: PlannedStroke[] = [];
  let cursor = x;
  let total = 0;
  for (const ch of word) {
    const letter = LETTERS[ch];
    if (!letter) continue;
    for (const raw of letter.strokes) {
      const pts: Stroke = raw.map(([px, py]) => [cursor + px * em, y + py * em]);
      let length = 0;
      for (let i = 1; i < pts.length; i++) {
        length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      }
      strokes.push({ points: pts, length, cumStart: total });
      total += length;
    }
    cursor += letter.width * em + tracking * em;
  }
  return { strokes, total, width: cursor - tracking * em - x };
}
