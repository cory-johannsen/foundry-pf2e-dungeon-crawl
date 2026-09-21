/**
 * Pure validation for hand-authored `narrative`-kind entries in
 * `data/dungeon-setpieces.json` (#165) — same "no PF2e compendium ships
 * this content" situation puzzles (#138) and skill challenges (#164)
 * already solved, so this mirrors `isValidPuzzleTemplate`/
 * `isValidSkillChallengeTemplate`'s existence and shape.
 *
 * Selection itself needs no dedicated function the way skill-challenge's
 * own `selectSkillChallengeTemplate` does: #163's own design already
 * anticipated giving a narrative room a `setpieceId` the same way a
 * `puzzle_or_trap` room gets one, so `dungeon-deck.mjs`'s existing,
 * generic `setpieceAt` seeded shuffle handles the pick — the same
 * selection path puzzle content has always used, never its own dedicated
 * selector.
 *
 * A narrative room, per #163's resolution model, always resolves through a
 * single Continue action (never a branch) — so "genuinely distinct in
 * shape" archetypes (#165's own explicit ask) come from which *fields*
 * each archetype carries, not from separate mechanical resolution paths:
 * `lore` (pure information, no objective hook), `ally` (an NPC contact
 * hook), `choice` (a dilemma described in prose for the table to narrate —
 * real branching buttons are a deliberately deferred follow-up), and
 * `goal` (pre-fills the run's objective textarea).
 */

const NARRATIVE_ARCHETYPES = ["lore", "ally", "choice", "goal"];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasValidOptions(options) {
  return (
    Array.isArray(options) &&
    options.length === 2 &&
    options.every(
      (o) => isNonEmptyString(o?.label) && isNonEmptyString(o?.consequence),
    )
  );
}

/**
 * True for a well-formed narrative template: `kind: "narrative"`, a known
 * `archetype`, and that archetype's own required fields present. Every
 * other archetype's fields are ignored (a `lore` entry doesn't need to
 * omit `npcName`, say) — only the active archetype's own requirements are
 * enforced, the same "only the shape that matters is checked" convention
 * `isValidSkillChallengeTemplate` already uses.
 */
export function isValidNarrativeTemplate(entry) {
  if (entry?.kind !== "narrative") return false;
  if (!NARRATIVE_ARCHETYPES.includes(entry.archetype)) return false;
  switch (entry.archetype) {
    case "lore":
      return isNonEmptyString(entry.revealText);
    case "ally":
      return isNonEmptyString(entry.npcName) && isNonEmptyString(entry.npcHook);
    case "choice":
      return hasValidOptions(entry.options);
    case "goal":
      return isNonEmptyString(entry.suggestedObjective);
    default:
      return false;
  }
}
