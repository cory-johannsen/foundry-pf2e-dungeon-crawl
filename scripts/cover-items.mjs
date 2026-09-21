/**
 * Destructible cover items (#96): crates, barrels, and rubble randomly placed
 * in a dungeon room for tactical cover during its encounter.
 *
 * Everything here is pure — data tables and functions operating on plain
 * values, no Foundry documents touched directly. `foundry-api.mjs`'s
 * `spawnCoverItems` is the one place that turns `buildCoverItemActorData`'s
 * output into a real Actor/Token, and `dungeon-combat.mjs`'s cover-bonus
 * wiring is the one place `coverBlocksLineOfFire` and `COVER_EFFECT_DATA`
 * get used against a live combat — same pure/glue split this module uses
 * everywhere else (dungeon-layout.mjs, pathfinding.mjs, placement.mjs).
 *
 * "Destructible" needs no hand-rolled damage/destruction logic of its own:
 * a PF2e hazard actor with real `system.attributes.hp`/`hardness` is fully
 * attackable and damageable through Foundry's own normal target-and-strike
 * flow and PF2e's own built-in hardness/damage-reduction handling, the same
 * as any other actor — this file only needs to build a correctly-shaped one.
 *
 * Hardness/HP values below are a deliberate, simple approximation of PF2e's
 * generic "hardness and hit points of objects by material and size"
 * guidelines (GM Core), not a citation of a specific named stat block —
 * they haven't been checked against a live PF2e system, so treat them as a
 * reasonable starting point a GM can freely retune, not gospel.
 */
import { splitmix32, seedFromString } from "./prng.mjs";

export const MODULE_ID = "deck-of-many-more-things";

export const COVER_ITEM_TYPES = {
  crate: {
    id: "crate",
    name: "Wooden Crate",
    img: `modules/${MODULE_ID}/assets/cover/crate.png`,
    hardness: 5,
    hp: 20,
    brokenThreshold: 10,
  },
  barrel: {
    id: "barrel",
    name: "Barrel",
    img: `modules/${MODULE_ID}/assets/cover/barrel.png`,
    hardness: 5,
    hp: 20,
    brokenThreshold: 10,
  },
  rubble: {
    id: "rubble",
    name: "Rubble Pile",
    img: `modules/${MODULE_ID}/assets/cover/rubble.png`,
    hardness: 8,
    hp: 40,
    brokenThreshold: 20,
  },
};

const COVER_ITEM_IDS = Object.keys(COVER_ITEM_TYPES);

/** Flat AC for an unattended, stationary object with no active defense —
 * PF2e's own generic guideline for this category, not the type's own trait
 * (a hazard has none by default). Overridable per spawn if a room ever wants
 * a tougher obstacle. */
export const COVER_ITEM_AC = 5;

/** 0 to `maxCount` cover-item type ids to place in a room, deterministic for
 * a given `seed` (the encounter's own seed, so a reroll of the same
 * encounter reshuffles cover too, and a re-inspected past encounter is
 * reproducible). Independent of room size/exact geometry on purpose — actual
 * placement (and how many of those chosen actually fit) is the caller's own
 * job once it knows the room and what's already standing in it. */
export function chooseCoverItemTypes(seed, maxCount = 3) {
  const rand = splitmix32(seedFromString(`${seed}-cover`));
  const count = Math.floor(rand() * (maxCount + 1));
  const chosen = [];
  for (let i = 0; i < count; i += 1) {
    chosen.push(COVER_ITEM_IDS[Math.floor(rand() * COVER_ITEM_IDS.length)]);
  }
  return chosen;
}

/** Raw PF2e hazard Actor data for one cover item — a minimal, "simple"
 * (non-complex) unattended hazard: real HP/hardness so PF2e's own damage
 * pipeline handles destruction, no attacks or stealth of its own since it
 * never acts. `disposition` is Foundry's own token disposition constant
 * (NEUTRAL by default — a crate isn't anyone's ally or enemy). */
export function buildCoverItemActorData(typeId, { disposition = 0 } = {}) {
  const type = COVER_ITEM_TYPES[typeId];
  if (!type) throw new Error(`Unknown cover item type ${typeId}`);
  return {
    name: type.name,
    type: "hazard",
    img: type.img,
    system: {
      details: {
        description: { value: "" },
        level: { value: 0 },
        isComplex: false,
      },
      attributes: {
        hp: {
          value: type.hp,
          max: type.hp,
          brokenThreshold: type.brokenThreshold,
        },
        hardness: type.hardness,
        ac: { value: COVER_ITEM_AC },
        stealth: { value: null },
      },
      traits: { value: [], rarity: "common" },
    },
    prototypeToken: {
      width: 1,
      height: 1,
      texture: { src: type.img },
      disposition,
      displayBars: 30, // CONST.TOKEN_DISPLAY_MODES.HOVER -- a literal, not the live global, so this stays plain-data/testable
      bar1: { attribute: "attributes.hp" },
    },
    flags: { [MODULE_ID]: { coverItem: typeId } },
  };
}

/** Every integer grid cell a Bresenham-style line from `a` to `b` passes
 * through, `a` and `b` both included — the line-of-fire an attack is
 * presumed to travel along for cover purposes. Supercover (both cells of a
 * diagonal half-step are included, not just one arbitrarily) so a cover item
 * sitting exactly on a shallow diagonal isn't missed on a coin-flip. */
export function lineCells(a, b) {
  const cells = [];
  let x = a.gx;
  let y = a.gy;
  const dx = Math.abs(b.gx - a.gx);
  const dy = -Math.abs(b.gy - a.gy);
  const sx = a.gx < b.gx ? 1 : -1;
  const sy = a.gy < b.gy ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    cells.push({ gx: x, gy: y });
    if (x === b.gx && y === b.gy) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return cells;
}

/** Whether a cover item stands between `attacker` and `target` (both
 * `{gx, gy}` cells) — true if any `coverCells` entry lies strictly between
 * them on their line of fire (the attacker's and target's own cells are
 * excluded, so standing an item exactly on the target's square, or the
 * attacker's own, doesn't grant the target cover from itself). */
export function coverBlocksLineOfFire(attacker, target, coverCells) {
  if (!coverCells.length) return false;
  const covered = new Set(coverCells.map((c) => `${c.gx},${c.gy}`));
  const path = lineCells(attacker, target);
  for (let i = 1; i < path.length - 1; i += 1) {
    if (covered.has(`${path[i].gx},${path[i].gy}`)) return true;
  }
  return false;
}

/** A temporary PF2e effect granting the standard +2 circumstance bonus to
 * AC — PF2e's own `FlatModifier` rule element, the same mechanism this
 * system already uses for every other flat bonus/penalty (documented,
 * stable API, not something this project is inventing). Created on a
 * target immediately before a strike roll and deleted immediately after
 * (dungeon-combat.mjs), so it never outlives the one roll it was for. */
export const COVER_EFFECT_DATA = {
  name: "Cover",
  type: "effect",
  img: "icons/environment/settlement/shield.webp",
  system: {
    description: {
      value:
        "Standing behind cover, granting a +2 circumstance bonus to AC against this attack.",
    },
    tokenIcon: { show: false },
    duration: { value: -1, unit: "unlimited", expiry: null, sustained: false },
    rules: [
      {
        key: "FlatModifier",
        selector: "ac",
        type: "circumstance",
        value: 2,
        label: "Cover",
      },
    ],
  },
};
