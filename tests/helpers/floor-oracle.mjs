// tests/helpers/floor-oracle.mjs
// Flood-fill model of "can a token walk across this floor" (#427). Floors are unit-cell
// rectangles, walls are axis-aligned segments on integer coordinates; a cell key is "x,y".
export function buildFloorModel(floors, walls) {
  const cells = new Set();
  for (const f of floors) {
    for (let x = f.gx; x < f.gx + f.gw; x += 1) for (let y = f.gy; y < f.gy + f.gh; y += 1) cells.add(`${x},${y}`);
  }
  // vertical wall unit edges at x between cells (x-1,y) and (x,y); horizontal at y between (x,y-1) and (x,y)
  const vWall = new Set();
  const hWall = new Set();
  for (const w of walls) {
    if (w.x1 === w.x2) {
      for (let y = Math.min(w.y1, w.y2); y < Math.max(w.y1, w.y2); y += 1) vWall.add(`${w.x1},${y}`);
    } else {
      for (let x = Math.min(w.x1, w.x2); x < Math.max(w.x1, w.x2); x += 1) hWall.add(`${x},${w.y1}`);
    }
  }
  const blocked = (ax, ay, bx, by) => (ax !== bx
    ? vWall.has(`${Math.max(ax, bx)},${ay}`)
    : hWall.has(`${ax},${Math.max(ay, by)}`));
  return {
    reach(start) {
      const seen = new Set([start]);
      const q = [start];
      while (q.length) {
        const [x, y] = q.shift().split(',').map(Number);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const k = `${x + dx},${y + dy}`;
          if (seen.has(k) || !cells.has(k) || blocked(x, y, x + dx, y + dy)) continue;
          seen.add(k);
          q.push(k);
        }
      }
      return seen;
    },
  };
}
