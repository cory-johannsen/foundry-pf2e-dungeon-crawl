/**
 * Where a summoned creature stands.
 *
 * Everything summoned used to land one square east of the character, which is
 * fine until it happens twice. Drawing Monstrosity and then Skull put a Large
 * witchwarg and an avatar of death on the same square, because each draw
 * measured from the character and neither looked at what was already there.
 *
 * So the square is searched for rather than computed: outward from the
 * character in rings, taking the first place the creature actually fits. A
 * Huge creature needs a three-by-three hole and will pass over gaps a Medium
 * one would have taken.
 *
 * All of this works in grid squares rather than pixels. Foundry stores token
 * positions in pixels and sizes in squares, and mixing the two is how a Large
 * creature ends up half a square off the grid.
 */

/** Do two footprints share any square? */
export function overlaps(a, b) {
  return a.gx < b.gx + b.gw && a.gx + a.gw > b.gx
      && a.gy < b.gy + b.gh && a.gy + a.gh > b.gy;
}

/** The squares a token covers, from its pixel position and its size. */
export function footprint(token, grid) {
  return {
    gx: Math.round((token.x ?? 0) / grid),
    gy: Math.round((token.y ?? 0) / grid),
    gw: Math.max(1, Math.round(token.width ?? 1)),
    gh: Math.max(1, Math.round(token.height ?? 1))
  };
}

/**
 * The nearest empty place for a creature of this size, searched ring by ring.
 *
 * The rings are square rather than circular — Chebyshev distance — because
 * that is how a grid measures adjacency, and a creature that appears
 * diagonally adjacent is as close as one that appears orthogonally.
 *
 * Returns null when nothing within `maxRing` fits, which the caller should
 * treat as "put it where it was going to go anyway": a creature placed on top
 * of something is still better than a card that silently does nothing.
 */
export function freeSpot({ occupied = [], gx, gy, gw = 1, gh = 1, maxRing = 8 } = {}) {
  for (let r = 1; r <= maxRing; r += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        // The ring's edge only; its interior was covered by a smaller r.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const spot = { gx: gx + dx, gy: gy + dy, gw, gh };
        if (!occupied.some((o) => overlaps(spot, o))) return spot;
      }
    }
  }
  return null;
}

/**
 * The nearest empty place for a creature of this size, WITHIN a fixed
 * rectangle — for dropping a dungeon encounter inside a specific generated
 * room rather than beside a focus token. Searches outward from the rect's
 * own center, same ring logic as freeSpot, but a candidate spot that would
 * spill outside the rect's bounds is rejected outright rather than merely
 * preferred against. Returns null when the room genuinely has no room left,
 * same "place it anyway" contract as freeSpot.
 */
export function freeSpotInRect({ occupied = [], rect, gw = 1, gh = 1 } = {}) {
  const cx = Math.round(rect.gx + rect.gw / 2);
  const cy = Math.round(rect.gy + rect.gh / 2);
  const maxRing = Math.max(rect.gw, rect.gh);
  for (let r = 0; r <= maxRing; r += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const spot = { gx: cx + dx, gy: cy + dy, gw, gh };
        if (spot.gx < rect.gx || spot.gy < rect.gy
          || spot.gx + gw > rect.gx + rect.gw || spot.gy + gh > rect.gy + rect.gh) continue;
        if (!occupied.some((o) => overlaps(spot, o))) return spot;
      }
    }
  }
  return null;
}

/**
 * The party's level, for cards that threaten everyone rather than one person.
 *
 * PF2e keeps an actual party actor, which is the right source: it knows who is
 * adventuring and leaves out the GM's test dummies. Falling back to every
 * character in the world would have counted an eighth-level actor named Nobody
 * as a party member and quadrupled what Monstrosity summons.
 */
export function partyLevelFrom(members) {
  const levels = (members ?? [])
    .map((m) => m?.system?.details?.level?.value)
    .filter((l) => Number.isFinite(l));
  if (!levels.length) return null;
  return Math.round(levels.reduce((a, b) => a + b, 0) / levels.length);
}
