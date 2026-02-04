export function mulberry32(seed: number) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickOne<T>(arr: T[], rng: () => number): T {
  if (arr.length === 0) throw new Error("pickOne called with empty array");
  const idx = Math.floor(rng() * arr.length);
  return arr[Math.min(idx, arr.length - 1)];
}
