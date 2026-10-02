// #555: does the first corridor tile outside a door sit in the door's own column/row? Built on the REAL scene.
const MODULE_ID = 'pf2e-dungeon-crawl';
const CELL = 100;

/** Door walls whose outside cell (the cell just beyond the door, away from its room) holds no corridor tile.
 * Each result: `{ kind: 'uncovered'|'ambiguous', face, coords, flags, offset, hidden }`; `offset` is the signed
 * cell distance (along the door's line) to the nearest tile, null when none within 2. */
export function doorCorridorMismatches(layout, scene) {
  const tiles = scene.tiles.filter((t) => t.width === CELL && t.height === CELL);
  // Corridor tiles are anchored at their center, so a tile at x=30250 occupies cell 302.
  const tileCells = new Set(tiles.map((t) => `${Math.floor(t.x / CELL)},${Math.floor(t.y / CELL)}`));
  const rects = Object.values(layout.rect);
  const inRoom = (cx, cy) => rects.some((r) => cx >= r.gx && cx < r.gx + r.gw && cy >= r.gy && cy < r.gy + r.gh);
  const out = [];
  for (const d of scene.walls.filter((w) => w.door)) {
    const [x1, y1, x2, y2] = d.c;
    const flags = d.flags?.[MODULE_ID] ?? {};
    const horizontal = y1 === y2;
    const lo = Math.min(horizontal ? x1 : y1, horizontal ? x2 : y2);
    const hi = Math.max(horizontal ? x1 : y1, horizontal ? x2 : y2);
    const line = (horizontal ? y1 : x1) / CELL;
    const side = (k) => {
      const cells = [];
      for (let c = Math.floor(lo / CELL); c < Math.ceil(hi / CELL); c += 1) cells.push(horizontal ? [c, line + k] : [line + k, c]);
      return cells;
    };
    const A = side(-1); // north / west of the line
    const B = side(0); // south / east of the line
    const aIn = A.some(([x, y]) => inRoom(x, y));
    const bIn = B.some(([x, y]) => inRoom(x, y));
    const face = horizontal ? (aIn ? 'south' : 'north') : (aIn ? 'east' : 'west');
    const outside = aIn && !bIn ? B : bIn && !aIn ? A : null;
    if (!outside) { out.push({ kind: 'ambiguous', face, coords: d.c, flags }); continue; }
    if (outside.every(([x, y]) => tileCells.has(`${x},${y}`))) continue;
    const [ox, oy] = outside[0];
    let offset = null;
    for (const k of [-1, 1, -2, 2]) {
      if (tileCells.has(horizontal ? `${ox + k},${oy}` : `${ox},${oy + k}`)) { offset = k; break; }
    }
    out.push({ kind: 'uncovered', face, coords: d.c, flags, offset, hidden: !!flags.dungeonHiddenDoorForEdge });
  }
  return out;
}
