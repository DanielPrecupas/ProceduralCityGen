// A square-cell raster layout shared by all terrain/planning fields, plus field utilities.

export class Raster {
  constructor(w, h, cell) {
    this.w = w; this.h = h; this.cell = cell;
    this.n = w * h; this.width = w * cell; this.height = h * cell;
  }
  index(x, y) {
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return -1;
    return cy * this.w + cx;
  }
  centerX(i) { return ((i % this.w) + 0.5) * this.cell; }
  centerY(i) { return (Math.floor(i / this.w) + 0.5) * this.cell; }
  center(i) { return { x: this.centerX(i), y: this.centerY(i) }; }
  // Bilinear sample (cell values live at cell centres).
  sample(arr, x, y) {
    let fx = x / this.cell - 0.5, fy = y / this.cell - 0.5;
    if (fx < 0) fx = 0; else if (fx > this.w - 1) fx = this.w - 1;
    if (fy < 0) fy = 0; else if (fy > this.h - 1) fy = this.h - 1;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = x0 + 1 < this.w ? x0 + 1 : x0, y1 = y0 + 1 < this.h ? y0 + 1 : y0;
    const tx = fx - x0, ty = fy - y0;
    const a = arr[y0 * this.w + x0], b = arr[y0 * this.w + x1];
    const c = arr[y1 * this.w + x0], d = arr[y1 * this.w + x1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  }
  gradient(arr, x, y) {
    const c = this.cell;
    return [
      (this.sample(arr, x + c, y) - this.sample(arr, x - c, y)) / (2 * c),
      (this.sample(arr, x, y + c) - this.sample(arr, x, y - c)) / (2 * c),
    ];
  }
}

// Distance (in world units) from every cell to the nearest cell where mask != 0.
export function chamferDistance(mask, w, h, cell) {
  const d = new Float32Array(w * h);
  const INF = 1e9, a = cell, b = cell * Math.SQRT2;
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; let v = d[i];
    if (v === 0) continue;
    if (x > 0) v = Math.min(v, d[i - 1] + a);
    if (y > 0) {
      v = Math.min(v, d[i - w] + a);
      if (x > 0) v = Math.min(v, d[i - w - 1] + b);
      if (x < w - 1) v = Math.min(v, d[i - w + 1] + b);
    }
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; let v = d[i];
    if (v === 0) continue;
    if (x < w - 1) v = Math.min(v, d[i + 1] + a);
    if (y < h - 1) {
      v = Math.min(v, d[i + w] + a);
      if (x < w - 1) v = Math.min(v, d[i + w + 1] + b);
      if (x > 0) v = Math.min(v, d[i + w - 1] + b);
    }
    d[i] = v;
  }
  return d;
}

export function boxBlur(src, w, h, r, passes = 1) {
  let a = Float32Array.from(src), b = new Float32Array(w * h);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += a[y * w + xx]; c++; } }
      b[y * w + x] = s / c;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += b[yy * w + x]; c++; } }
      a[y * w + x] = s / c;
    }
  }
  return a;
}

// 4-connected components of mask != 0.
export function labelComponents(mask, w, h) {
  const labels = new Int32Array(w * h).fill(-1);
  const sizes = [];
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || labels[s] >= 0) continue;
    const id = sizes.length; let size = 0;
    labels[s] = id; stack.push(s);
    while (stack.length) {
      const i = stack.pop(); size++;
      const x = i % w, y = (i - x) / w;
      if (x > 0 && mask[i - 1] && labels[i - 1] < 0) { labels[i - 1] = id; stack.push(i - 1); }
      if (x < w - 1 && mask[i + 1] && labels[i + 1] < 0) { labels[i + 1] = id; stack.push(i + 1); }
      if (y > 0 && mask[i - w] && labels[i - w] < 0) { labels[i - w] = id; stack.push(i - w); }
      if (y < h - 1 && mask[i + w] && labels[i + w] < 0) { labels[i + w] = id; stack.push(i + w); }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

export function summedArea(arr, w, h) {
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += arr[y * w + x];
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
    }
  }
  return sat;
}

// Sum over the inclusive cell box, clipped to the raster.
export function boxSum(sat, w, h, x0, y0, x1, y1) {
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w - 1, x1); y1 = Math.min(h - 1, y1);
  if (x1 < x0 || y1 < y0) return 0;
  const W = w + 1;
  return sat[(y1 + 1) * W + x1 + 1] - sat[y0 * W + x1 + 1] - sat[(y1 + 1) * W + x0] + sat[y0 * W + x0];
}
