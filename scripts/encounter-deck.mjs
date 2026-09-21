/**
 * The abstract "Encounter Deck" from The Book of Many Things (5e), translated
 * to PF2e's level-relative encounter math.
 *
 * This module knows nothing about Foundry or the PF2e bestiary — it only
 * shuffles and resolves an abstract deck of slots. Turning a resolved slot
 * into an actual creature is `encounter-roster.mjs`'s job. Splitting it this
 * way means the shuffle/special-card logic (the part with real rules
 * consequences) is fully unit-testable without a live world.
 *
 * PF2e has no CR, so instead of an absolute challenge rating each creature
 * slot carries a `levelOffset` — the creature's level relative to the party's
 * — matching the GM Core's "Building Creature Encounters" XP-by-relative-level
 * table (see encounter-roster.mjs).
 */
import { splitmix32, seedFromString, shuffle } from './prng.mjs';

// Friend's level offset ("1-2 below party level" per the book) is fixed
// rather than randomised, for predictability. Twins drawn together are
// bumped to party level regardless of their pre-draw offset, since the book
// calls that pairing a climactic fight. Both are tunable constants, not rules.
const FRIEND_LEVEL_OFFSET = -1;
const TWIN_PAIR_LEVEL_OFFSET = 0;

// How often a plain creature slot is swapped for a Noncombat Encounter or
// Goal card when the deck is built. Low, since most decks should stay
// straightforwardly martial — tune freely.
const NONCOMBAT_CHANCE = 0.15;
const GOAL_CHANCE = 0.10;

/**
 * The 15 creature slots that make up most of a deck, per the book's "ten to
 * fifteen monsters... half the level of the characters to 2 higher" guidance.
 * `group` slots that share an id fight together when both are drawn
 * (identical creatures, per the book's primary example); `countsAs` slots are
 * a single card standing in for several weak creatures. Composition —
 * exactly which offsets, how many grouped/countsAs — is a tunable starting
 * point, not a balanced-for-every-table constant.
 */
const CREATURE_SLOT_TEMPLATES = [
  { levelOffset: -2, group: 'skirmishers' },
  { levelOffset: -2, group: 'skirmishers' },
  { levelOffset: -1, countsAs: 3 },
  { levelOffset: -1 },
  { levelOffset: -1 },
  { levelOffset: -1 },
  { levelOffset: 0 },
  { levelOffset: 0 },
  { levelOffset: 0 },
  { levelOffset: 0, group: 'pack' },
  { levelOffset: 0, group: 'pack' },
  { levelOffset: 1 },
  { levelOffset: 1 },
  { levelOffset: 1, countsAs: 2 },
  { levelOffset: 2 }
];

function makeRand(seed) {
  if (seed == null) return Math.random;
  return typeof seed === 'string' ? splitmix32(seedFromString(seed)) : splitmix32(seed >>> 0);
}

/**
 * Build a fresh 20-slot encounter deck: the 15 creature slots above, plus one
 * each of Friend, Lurker, a linked Twin pair, and Draw Two — with a small
 * chance of a Noncombat Encounter or Goal card swapped in for a plain
 * creature slot. Deterministic for a given seed, like `dealCelticCross`.
 */
export function buildEncounterDeck({ seed } = {}) {
  const rand = makeRand(seed);
  let n = 0;
  const nextId = (kind) => `${kind}-${n++}`;

  const slots = CREATURE_SLOT_TEMPLATES.map((tpl) => ({ id: nextId('creature'), kind: 'creature', ...tpl }));

  slots.push({ id: nextId('friend'), kind: 'friend', levelOffset: FRIEND_LEVEL_OFFSET });
  slots.push({ id: nextId('lurker'), kind: 'lurker', levelOffset: 0 });
  const twinA = nextId('twin');
  const twinB = nextId('twin');
  slots.push({ id: twinA, kind: 'twin', levelOffset: 1, twinPairId: twinB });
  slots.push({ id: twinB, kind: 'twin', levelOffset: 1, twinPairId: twinA });
  slots.push({ id: nextId('draw_two'), kind: 'draw_two' });

  // Noncombat/Goal swap in for a plain (ungrouped, non-multiple) creature
  // slot, so the deck size never changes and groups/multiples stay intact.
  const plainCreatureIndexes = slots
    .map((s, i) => (s.kind === 'creature' && !s.group && !s.countsAs ? i : -1))
    .filter((i) => i >= 0);

  const maybeSwap = (kind, chance) => {
    if (!plainCreatureIndexes.length || rand() >= chance) return;
    const pick = Math.floor(rand() * plainCreatureIndexes.length);
    const idx = plainCreatureIndexes.splice(pick, 1)[0];
    slots[idx] = { id: nextId(kind), kind };
  };
  maybeSwap('noncombat', NONCOMBAT_CHANCE);
  maybeSwap('goal', GOAL_CHANCE);

  return slots;
}

/**
 * Draw slots off the front of `queue` until `budget` is spent, expanding the
 * budget for Friend (+2, to determine foes) and Draw Two/Three/Four
 * (permanently discarded, +N replacements). Shared by the main draw and the
 * lone-twin replacement draw below.
 */
function drawBudget(queue, byId, budget, permanentlyDiscarded) {
  const drawn = [];
  while (budget > 0) {
    const id = queue.shift();
    if (id == null) break;
    const slot = byId.get(id);
    budget -= 1;
    if (slot.kind === 'friend') {
      budget += 2;
    } else if (slot.kind === 'draw_two' || slot.kind === 'draw_three' || slot.kind === 'draw_four') {
      permanentlyDiscarded.push(slot.id);
      budget += { draw_two: 2, draw_three: 3, draw_four: 4 }[slot.kind];
      continue;
    }
    drawn.push(slot);
  }
  return drawn;
}

/**
 * Resolve an explicit draw order into the special-card outcomes. Exported
 * separately from `dealEncounter` so tests can hand it a crafted order
 * instead of fighting a shuffle to exercise Friend/Lurker/Twin/Draw-N.
 */
export function resolveDraws(deckSlots, order, partySize) {
  const byId = new Map(deckSlots.map((s) => [s.id, s]));
  const queue = order.slice();
  const permanentlyDiscarded = [];

  let drawnSlots = drawBudget(queue, byId, partySize, permanentlyDiscarded);

  // A lone twin is shuffled back and replaced (the book: "shuffle it back
  // into the deck and form the encounter as normal"). Repeat in case the
  // replacement is itself a lone twin; bounded so a hand-built test deck
  // can't loop forever.
  for (let guard = 0; guard < 5; guard += 1) {
    const lone = drawnSlots.find((s) => s.kind === 'twin'
      && !drawnSlots.some((o) => o.id === s.twinPairId));
    if (!lone) break;
    drawnSlots = drawnSlots.filter((s) => s !== lone);
    queue.push(lone.id);
    drawnSlots = drawnSlots.concat(drawBudget(queue, byId, 1, permanentlyDiscarded));
  }

  const friend = drawnSlots.find((s) => s.kind === 'friend') ?? null;
  const lurker = drawnSlots.find((s) => s.kind === 'lurker') ?? null;
  const noncombat = drawnSlots.find((s) => s.kind === 'noncombat') ?? null;
  const goal = drawnSlots.find((s) => s.kind === 'goal') ?? null;
  const twinDrawn = drawnSlots.filter((s) => s.kind === 'twin');
  const twins = twinDrawn.length === 2
    ? twinDrawn.map((s) => ({ ...s, levelOffset: TWIN_PAIR_LEVEL_OFFSET }))
    : null;
  const foes = drawnSlots.filter((s) => s.kind === 'creature');

  return {
    resolved: { foes, friend, lurker, twins, noncombat, goal, permanentlyDiscarded },
    remainingIds: queue
  };
}

/**
 * Shuffle and deal an encounter for a party of `partySize`, per the book:
 * "draw a number of cards equal to the number of characters in the party."
 *
 * `remainingIds` lets a caller hand in an already-partially-depleted deck
 * instead of always starting fresh — the seam a future persistent per-scene
 * deck needs. Phase 1 never passes it.
 */
export function dealEncounter(deckSlots, { seed, partySize, remainingIds = null } = {}) {
  const rand = makeRand(seed);
  const pool = remainingIds ?? deckSlots.map((s) => s.id);
  const order = shuffle(pool, rand);
  return resolveDraws(deckSlots, order, partySize);
}
