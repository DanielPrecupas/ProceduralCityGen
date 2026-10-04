// Deterministic pseudo-random numbers and noise. Generation code must never call Math.random().

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16; h = Math.imul(h, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

export class SeededRandom {
  constructor(seed) {
    this.key = String(seed);
    this.state = hashString(this.key) | 0;
  }
  // mulberry32
  next() {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(n) { return Math.floor(this.next() * n); }
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[this.int(arr.length)]; }
  // Independent stream derived from the original seed (not from consumption state),
  // so each pipeline stage is reproducible when re-run on its own.
  fork(label) { return new SeededRandom(this.key + '/' + label); }
}

function lattice(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

// Gradient (Perlin-style) noise in roughly [-1, 1]. Quintic fade keeps it C2-continuous, so
// no lattice lines show up in slopes or hill shading.
export function makeNoise2D(seed) {
  const s = seed | 0;
  const grad = (ix, iy, dx, dy) => {
    const a = lattice(ix, iy, s) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fade(fx), uy = fade(fy);
    const a = grad(ix, iy, fx, fy), b = grad(ix + 1, iy, fx - 1, fy);
    const c = grad(ix, iy + 1, fx, fy - 1), d = grad(ix + 1, iy + 1, fx - 1, fy - 1);
    return (a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy) * 1.5;
  };
}

export function fbm(noise, x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x * freq + i * 17.3, y * freq - i * 9.1);
    norm += amp; amp *= gain; freq *= lacunarity;
  }
  return sum / norm;
}
