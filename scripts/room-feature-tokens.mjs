/**
 * Interactable room-feature prop tokens (#611/#623): a player-visible,
 * player-targetable scene object for a treasure/puzzle/skill-challenge
 * room, replacing the sidebar-only trigger those rooms used to have.
 * Pure data + a builder — no Foundry documents touched here; dungeon-scene.mjs
 * is the one place that turns this into a real Actor/Token (same pure/glue
 * split cover-items.mjs already uses for its own scene-prop actors).
 */
export const ROOM_FEATURE_TOKEN_TYPES = {
  treasure: { name: "Treasure Chest", img: "icons/svg/chest.svg" },
  puzzle: { name: "Puzzle Mechanism", img: "icons/svg/clockwork.svg" },
  skill_challenge: { name: "Challenge Marker", img: "icons/svg/dice-target.svg" },
};

const MODULE_ID = "pf2e-dungeon-crawl";

/** Full Actor-creation payload for one room-feature prop — a PF2e `loot`
 * actor (needs no HP/combat schema, confirmed live), flagged with its own
 * kind and room id so module.mjs's `targetToken` handler can tell which
 * room/feature was interacted with without any further lookup. */
export function buildRoomFeatureTokenActorData(kind, roomId) {
  const type = ROOM_FEATURE_TOKEN_TYPES[kind];
  if (!type) throw new Error(`Unknown room-feature kind: ${kind}`);
  return {
    name: type.name,
    type: "loot",
    img: type.img,
    prototypeToken: { texture: { src: type.img } },
    flags: {
      [MODULE_ID]: { roomFeatureKind: kind, roomFeatureRoomId: roomId },
    },
  };
}
