/**
 * Selects a real trap-tagged hazard from PF2e's own `pf2e.hazards`
 * compendium for a `puzzle_or_trap` room resolved to a trap (#135) — same
 * pattern `encounter-roster.mjs`'s `pickCreature` already uses for combat
 * rooms: a level-tolerance bestiary query against real official content,
 * not new trap content invented per room. `dungeon-scene.mjs`'s
 * `populateSlotTrap` is the one place this gets turned into an actual
 * spawned Actor/Token, same split every other selection-vs-Foundry-glue
 * pair in this module keeps (`encounter-deck.mjs`/`encounter-roster.mjs`,
 * `cover-items.mjs`/`foundry-api.mjs`'s `spawnCoverItems`).
 *
 * "Runtime generation," per #135's own request to make this a deliberate
 * call rather than an assumption: this module does *not* rescale a picked
 * trap's own DC/damage to fit the party's exact level. #134's own
 * automation already only runs a trap's Strike/disable-check as PF2e wrote
 * them — hand-rescaling a compendium Actor's derived stats (a Strike's
 * damage formula, a disable check's DC) risks silently breaking that math
 * for a saving that a slightly wider level-tolerance search already
 * mostly buys for free, the same trade `pickCreature` already makes for
 * creatures. True parametrization is a possible future refinement, not
 * assumed away — just not what "generation" means here in v1.
 */

// Wider than encounter-roster.mjs's LEVEL_TOLERANCE (1): only 24 trap-tagged
// entries exist across the whole -1..23 level range, versus a full
// multi-thousand-creature bestiary — a narrower band would starve most
// queries to empty. Confirmed against pf2e.hazards live (#134).
const LEVEL_TOLERANCE = 3;

/**
 * `{pack, id, name, level, traits, automatable}` for the trap-tagged
 * hazard chosen for a room, or `null` if `pf2e.hazards` has nothing within
 * tolerance of `partyLevel + levelOffsetBias` — the caller (`populateSlotTrap`)
 * falls back to the room's own hand-authored setpiece stub in that case,
 * per #135's "only fall back to a stub the compendium genuinely doesn't
 * cover."
 *
 * Prefers an automatable candidate (`classifyTrap(...).automatable`,
 * #134) when the level-filtered pool has one, so the room's trap is
 * actually playable through the mechanical engine rather than picked
 * blind — falls back to the full pool (GM-narrated) only when *none* of
 * the candidates in range are automatable, rather than never picking a
 * trap at all just because it needs manual GM narration.
 */
export async function selectTrap({
  api,
  partyLevel,
  levelOffsetBias = 0,
  rng = Math.random,
}) {
  const minLevel = partyLevel + levelOffsetBias - LEVEL_TOLERANCE;
  const maxLevel = partyLevel + levelOffsetBias + LEVEL_TOLERANCE;
  const pool = await api.findHazards({ minLevel, maxLevel });
  if (!pool.length) return null;

  const classified = await Promise.all(
    pool.map(async (hazard) => ({
      ...hazard,
      automatable:
        (await api.classifyHazard({ pack: hazard.pack, id: hazard.id }))
          ?.automatable ?? false,
    })),
  );
  const automatable = classified.filter((h) => h.automatable);
  const candidates = automatable.length ? automatable : classified;
  return candidates[Math.floor(rng() * candidates.length)];
}
