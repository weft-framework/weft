export const WEAVE_WIDTH = 1152;
const WARP_GAP = 24;
const ROW_GAP = 22;
const TOP = 24;
export const MIN_ROWS = 6;

export interface WeftThread {
  y: number;
  d: string;
  over: { x: number; y1: number; y2: number }[];
}

export function warpXs(): number[] {
  const xs: number[] = [];
  for (let x = WARP_GAP / 2; x < WEAVE_WIDTH; x += WARP_GAP) xs.push(x);
  return xs;
}

export function weaveHeight(rows: number): number {
  return TOP * 2 + (Math.max(rows, MIN_ROWS) - 1) * ROW_GAP;
}

export function thread(row: number): WeftThread {
  const y = TOP + row * ROW_GAP;
  const xs = warpXs();
  const lift = (j: number) => ((row + j) % 2 === 0 ? 2.5 : -2.5);
  let d = `M0 ${y}`;
  let prevX = 0;
  let prevY = y;
  for (let j = 0; j < xs.length; j++) {
    const x = xs[j];
    const ty = y + lift(j);
    const mid = (prevX + x) / 2;
    d += ` C${mid} ${prevY} ${mid} ${ty} ${x} ${ty}`;
    prevX = x;
    prevY = ty;
  }
  d += ` C${(prevX + WEAVE_WIDTH) / 2} ${prevY} ${(prevX + WEAVE_WIDTH) / 2} ${y} ${WEAVE_WIDTH} ${y}`;
  const over = xs.filter((_, j) => lift(j) > 0).map((x) => ({ x, y1: y - 6.5, y2: y + 6.5 }));
  return { y, d, over };
}
