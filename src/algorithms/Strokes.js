// Strokes ("natural streets"): chains of street segments that continue one another through
// intersections with little change of direction. Used twice: by the hierarchy stage to build
// Corridors, and by the analysis module to measure corridor continuity of any network.

// segs[i] = { a, b, da: [x, y], db: [x, y], len }: node ids and the unit direction in which the
// segment LEAVES each end. Returns strokes as ordered lists [{ seg, from }] (`from` = the node
// the stroke enters the segment at) with their length and the deflection at each join.
export function buildStrokes(nodeCount, segs, { maxDeflection = 0.52, canPair = null, penalty = null } = {}) {
  const at = Array.from({ length: nodeCount }, () => []);
  segs.forEach((s, i) => { if (s.a === s.b) return; at[s.a].push(i * 2); at[s.b].push(i * 2 + 1); });
  const link = new Int32Array(segs.length * 2).fill(-1), bend = new Float32Array(segs.length * 2);
  const dir = (arm) => (arm & 1 ? segs[arm >> 1].db : segs[arm >> 1].da);
  for (const arms of at) {
    if (arms.length < 2) continue;
    const pairs = [];
    for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) {
      const p = dir(arms[i]), q = dir(arms[j]);
      const defl = Math.acos(Math.max(-1, Math.min(1, -(p[0] * q[0] + p[1] * q[1]))));
      if (defl > maxDeflection || (canPair && !canPair(segs[arms[i] >> 1], segs[arms[j] >> 1]))) continue;
      pairs.push([defl + (penalty ? penalty(segs[arms[i] >> 1], segs[arms[j] >> 1]) : 0), defl, arms[i], arms[j]]);
    }
    pairs.sort((x, y) => x[0] - y[0] || x[2] - y[2] || x[3] - y[3]);
    for (const [, defl, p, q] of pairs) if (link[p] < 0 && link[q] < 0) { link[p] = q; link[q] = p; bend[p] = bend[q] = defl; }
  }
  const used = new Uint8Array(segs.length), strokes = [];
  const walk = (startArm) => { // startArm = the unlinked (or arbitrary) end the stroke starts from
    const items = [], bends = [];
    let arm = startArm, length = 0;
    for (;;) {
      const si = arm >> 1;
      if (used[si]) break;
      used[si] = 1;
      items.push({ seg: si, from: arm & 1 ? segs[si].b : segs[si].a });
      length += segs[si].len;
      const far = arm ^ 1;
      if (link[far] < 0) break;
      bends.push(bend[far]);
      arm = link[far];
    }
    if (items.length) strokes.push({ items, length, bends });
  };
  for (let arm = 0; arm < segs.length * 2; arm++) if (link[arm] < 0 && !used[arm >> 1]) walk(arm);
  for (let i = 0; i < segs.length; i++) if (!used[i]) walk(i * 2); // closed loops
  return strokes;
}
