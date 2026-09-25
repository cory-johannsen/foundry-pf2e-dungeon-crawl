import { readEnvOrDotenv } from "./env.mjs";

const DEFAULT_COMBAT_REASONING_CANDIDATE_THRESHOLD = 8;

/** "reasoning" when the acting combatant has more candidate actions to
 * weigh than the threshold, else "fast". candidates.length is a proxy for
 * tactical decision complexity (more ready strikes/spells/postures),
 * not narrative importance — see #136 for a real importance signal this
 * is deliberately not waiting on. */
export function selectCombatTier(
  context,
  {
    threshold = Number(readEnvOrDotenv("COMBAT_REASONING_CANDIDATE_THRESHOLD")) ||
      DEFAULT_COMBAT_REASONING_CANDIDATE_THRESHOLD,
  } = {},
) {
  return context.candidates.length > threshold ? "reasoning" : "fast";
}

const REASONING_CUSTOMIZATION_KINDS = new Set(["skill_challenge", "puzzle", "narrative"]);

/** trap/treasure (short, low-stakes flavor) get "fast"; skill_challenge/
 * puzzle/narrative (more player-facing, more substantive) get "reasoning".
 * An unrecognized kind defaults to "fast" rather than throwing — kind
 * validation is server.mjs's job (KNOWN_KINDS), not this pure
 * classifier's. */
export function selectCustomizationTier(kind) {
  return REASONING_CUSTOMIZATION_KINDS.has(kind) ? "reasoning" : "fast";
}
