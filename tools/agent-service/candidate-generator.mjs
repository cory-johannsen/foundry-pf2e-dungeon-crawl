import { nodeFetch } from "./node-fetch.mjs";
import { readEnvOrDotenv } from "./env.mjs";

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * #910: the response schema is built per request from the vocabulary
 * actually sent -- `type`/`slug` are constrained to the (deduped) values
 * present in that call's own vocabulary (maneuvers, feat/class actions
 * and/or #915's NPC save abilities), never a fixed list. `targetId` is nullable because self-effect
 * feat picks (stances, Rage, other one-action self-buffs -- #914) target
 * the actor itself. Foundry still
 * re-validates every pick against the exact vocabulary entries it sent.
 */
function buildSchema(vocabulary) {
  const types = [...new Set(vocabulary.map((v) => v.type))];
  const slugs = [...new Set(vocabulary.map((v) => v.slug))];
  return {
    type: "object",
    properties: {
      picks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: types },
            slug: { type: "string", enum: slugs },
            targetId: { type: ["string", "null"] },
            rationale: { type: "string", description: "One short sentence explaining the pick." },
          },
          required: ["type", "slug", "targetId", "rationale"],
        },
      },
    },
    required: ["picks"],
  };
}

function userMessageContent(context, vocabulary) {
  return `You are proposing tactical options (combat maneuvers, feat/class actions and monster special abilities) for an AI-controlled combatant's turn in a Pathfinder 2e combat. Pick a tactically sensible subset of the vocabulary below (zero or more) — never propose anything not listed in it.\n\nEntries with type "feat" are the combatant's own feats/class actions. kind "selfEffect" entries (stances, Rage and other self-buffs) apply a lasting effect to the combatant itself (send targetId null): each one's effectSummary says what the effect does (e.g. "+attack, +damage dice", "resist fire", "temp HP"), its durationLabel how long it lasts, and its frequencyLabel (when not null) how often it can be used — choose a buff by what it does for this fight, prefer raising a stance or buff early in the round when a fight is on, and remember only one stance can be active at a time. kind "composite" entries (Sudden Charge, Lunge, Twin Feint) are Strike-based actions against the listed targetId. kind "targetedSelfEffect" entries (Hunt Prey, Devise a Stratagem) mark the listed targetId as the combatant's chosen foe (send that targetId): Hunt Prey makes it the ranger's prey for the rest of the fight (only one prey at a time), Devise a Stratagem rolls a d20 that replaces the combatant's next Strike roll against it this round -- pick one only when the combatant will go on to attack that creature. Entries with type "npcAbility" are the combatant's own monster special abilities -- a saving throw that inflicts conditions (frightened, stunned, ...) on every creature in affectedIds: summary gives the save, DC, area and what each outcome does. An area entry has targetId null (send null); a single-target entry names its targetId. Prefer one that affects several enemies or lands a strong condition. Respect each entry's action cost.\n\nContext:\n${JSON.stringify(context, null, 2)}\n\nVocabulary (every legal (type, slug, targetId) option this turn):\n${JSON.stringify(vocabulary, null, 2)}`;
}

/**
 * #909: the reasoning-model stage of the maneuver pipeline — always
 * litellm (never provider-selectable, mirroring customization-generator.mjs:
 * this needs genuine structured generation over a variable-shaped
 * vocabulary, not a fixed single choice, so Laya's typed choice/score/bool
 * questions don't fit here any more than they fit flavor-customization).
 * Foundry is the authoritative validator of the returned picks against the
 * vocabulary it sent (see scripts/agent-candidates.mjs's
 * buildManeuverCandidates) — this function trusts the schema and the
 * model's own restraint, nothing more.
 */
export async function generateCombatCandidates(
  context,
  vocabulary,
  {
    baseUrl = readEnvOrDotenv("LITELLM_BASE_URL") ?? "http://litellm:4000/v1",
    apiKey = readEnvOrDotenv("LITELLM_API_KEY"),
    timeoutMs = Number(readEnvOrDotenv("LITELLM_COMBAT_CANDIDATES_TIMEOUT_MS")) || DEFAULT_TIMEOUT_MS,
    fetchImpl = nodeFetch,
  } = {},
) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "reasoning",
      messages: [{ role: "user", content: userMessageContent(context, vocabulary) }],
      tools: [
        {
          type: "function",
          function: {
            name: "propose_candidates",
            description: "Propose a tactically sensible subset of the offered maneuver/feat/monster-ability vocabulary.",
            parameters: buildSchema(vocabulary),
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "propose_candidates" } },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`candidate-generator: request failed (${res.status}): ${errBody}`);
  }

  const payload = await res.json();
  const rawArguments = payload.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!rawArguments) throw new Error("candidate-generator: no propose_candidates tool call in response");
  try {
    return JSON.parse(rawArguments);
  } catch (err) {
    throw new Error(`candidate-generator: tool call arguments were not valid JSON: ${err.message}`);
  }
}
