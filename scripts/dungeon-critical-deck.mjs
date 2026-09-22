/**
 * PF2e's own `pf2e.criticaldeck` compendium (#28): a real Foundry
 * `JournalEntry` pack of 106 documents -- 53 "Critical Hit Deck #<n>", 53
 * "Critical Fumble Deck #<n>" -- each carrying one page whose
 * `pages[0].text.content` is HTML bundling ~4 sub-entries
 * (`<h1>name</h1><blockquote>effect html</blockquote><p><code>category</code></p>`).
 * On a Strike or spell-attack roll's crit/fumble, dungeon-combat.mjs's three
 * outcome-branching call sites draw one sub-entry at random from the
 * matching deck/category, auto-apply whichever of its directives parse
 * cleanly, and post the full card text to chat regardless -- so the GM can
 * hand-adjudicate anything left unparsed.
 *
 * Split pure/impure the same way dungeon-sound.mjs does: `parseDeckEntry`
 * and `pickSubentry` are pure and unit-testable against real fixture HTML
 * (no live Foundry needed); `drawAndApplyCriticalCard` is the one impure
 * orchestrator that touches `game.packs`, `Roll`, `fromUuid`, actor
 * mutators, and `ChatMessage.create`.
 *
 * Directive scope (see #50 for what's deliberately NOT covered here):
 *   - `@Damage[<formula>]` -- rolled via `Roll` (same pattern
 *     `setAbilityRecharge` already uses) and applied via
 *     `actor.applyDamage({damage: total, token})`.
 *   - `@UUID[Compendium.pf2e.conditionitems.Item.<Name>]` (braced label with
 *     a trailing number, or bare) -- a condition, applied via
 *     `actor.increaseCondition(slug, ...)`. Slug convention matches
 *     `parseConditionsByOutcome` in agent-candidates.mjs exactly:
 *     `name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/(^-|-$)/g, '')`.
 *   - `@UUID[Compendium.pf2e.other-effects.Item.<Name>]{...}` -- an
 *     arbitrary Effect item, applied via the exact `fromUuid` ->
 *     `.toObject()` -> `createEmbeddedDocuments("Item", [...])` pattern
 *     `castBuffSpellAndApply` already uses.
 *   - Any other `@UUID[...]` (spells-srd, actionspf2e, ...), `@Localize[...]`
 *     (persistent damage, #50), `@Check[...]`, and bare prose with no
 *     directive at all are never auto-applied -- flavor text only.
 *   - Weapon/item HP damage ("Your weapon takes...", "the weapon is
 *     Broken...") is deliberately skipped even when it wraps an otherwise
 *     eligible `@Damage`/`@UUID` directive: there's no creature-damage
 *     precedent in this file for item damage to reuse, and applying it to a
 *     creature would just be wrong.
 *
 * Subject detection walks back from each directive to the start of its
 * *sentence* (the text since the last `.`), then takes the right-most
 * subject-phrase match in that window -- not just a sentence-initial check
 * -- because one sentence can carry several directives sharing one subject
 * clause (confirmed live against critical-hit-deck-40's "Sliced Hand": two
 * conditions, one "the target is" clause). "your weapon"/"the weapon"/
 * "your item"/"the item" always wins over a bare "you"/"your" match at the
 * same or an earlier position, since the alternation tries the more
 * specific phrases first. No match in the window at all -- an ambiguous or
 * third-party subject like "an ally" -- always skips, never guesses.
 *
 * A skipped directive does NOT cancel its sub-entry: whichever other
 * directives on that same sub-entry parse cleanly still apply, and the
 * full, unmodified effect HTML is always posted to chat either way.
 */

const CONDITION_UUID_PREFIX = "Compendium.pf2e.conditionitems.Item.";
const EFFECT_UUID_PREFIX = "Compendium.pf2e.other-effects.Item.";

const ENTRY_RE =
  /<h1>([\s\S]*?)<\/h1>\s*<blockquote>([\s\S]*?)<\/blockquote>\s*<p>\s*<code>([\s\S]*?)<\/code>\s*<\/p>/g;

const DIRECTIVE_RE = /@(\w+)\[((?:[^[\]]|\[[^[\]]*\])*)\](?:\{([^}]*)\})?/g;

// Rightmost match wins -- ordered most- to least-specific so "your weapon"
// is preferred over the bare "your" it also contains.
const SUBJECT_RE =
  /\b(your weapon|the weapon|your item|the item|the target|your target|you|your)\b/gi;

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The right-most subject-phrase match in `window` (the text since the
 * start of the directive's own sentence), classified into who an
 * auto-applicable directive should target -- or `"skip"` when nothing
 * matches (ambiguous/third-party subject) or the match is about a
 * weapon/item rather than a creature. */
function detectSubject(window) {
  let lastPhrase = null;
  SUBJECT_RE.lastIndex = 0;
  let match;
  while ((match = SUBJECT_RE.exec(window))) {
    lastPhrase = match[1].toLowerCase();
  }
  if (!lastPhrase) return "skip";
  if (lastPhrase.includes("weapon") || lastPhrase.includes("item"))
    return "skip";
  if (lastPhrase.includes("target")) return "target";
  return "self";
}

/** Same slug convention as `parseConditionsByOutcome` in
 * agent-candidates.mjs (~line 537) -- matched exactly rather than invented
 * fresh, so a condition parsed off a crit-deck card slugs identically to
 * one parsed off a spell description. */
function slugifyConditionName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** A condition's `{name, value}` from either its braced label ("Sickened
 * 3" -> name "Sickened", value 3; "Fatigued" -> value null) or, when there's
 * no braces at all, the bare Item name off the UUID path itself. */
function parseConditionNameAndValue(uuidTail, brace) {
  const label = brace != null ? brace.trim() : uuidTail;
  const withValue = /^(.+?)\s+(\d+)$/.exec(label);
  if (withValue) return { name: withValue[1], value: Number(withValue[2]) };
  return { name: label, value: null };
}

function findSentenceStart(text, endIndex) {
  const lastPeriod = text.lastIndexOf(".", endIndex - 1);
  return lastPeriod === -1 ? 0 : lastPeriod + 1;
}

function buildDirective(keyword, bracketContent, brace, window, raw) {
  if (keyword === "Damage") {
    const subject = detectSubject(window);
    if (subject === "skip") return { type: "skip", raw, reason: "subject" };
    return { type: "damage", formula: bracketContent.trim(), target: subject };
  }

  if (keyword === "UUID") {
    const uuid = bracketContent.trim();

    if (uuid.startsWith(CONDITION_UUID_PREFIX)) {
      const subject = detectSubject(window);
      if (subject === "skip") return { type: "skip", raw, reason: "subject" };
      const tail = uuid.slice(CONDITION_UUID_PREFIX.length);
      const { name, value } = parseConditionNameAndValue(tail, brace);
      return {
        type: "condition",
        slug: slugifyConditionName(name),
        value,
        target: subject,
      };
    }

    if (uuid.startsWith(EFFECT_UUID_PREFIX)) {
      const subject = detectSubject(window);
      if (subject === "skip") return { type: "skip", raw, reason: "subject" };
      return {
        type: "effect",
        uuid,
        label: brace != null ? brace.trim() : null,
        target: subject,
      };
    }

    // Any other compendium (spells-srd, actionspf2e, ...) is never
    // auto-applied, regardless of subject.
    return { type: "skip", raw, reason: "other-uuid" };
  }

  if (keyword === "Localize") return { type: "skip", raw, reason: "localize" };

  // @Check, @Template, or anything else this format grows later.
  return { type: "skip", raw, reason: "unsupported" };
}

/** Walks `effectHtml` left to right and returns every directive found, in
 * order -- `{type: 'damage'|'condition'|'effect'|'skip', ...}`. Pure: takes
 * only the sub-entry's own effect HTML, no live Foundry dependency. */
export function extractDirectives(effectHtml) {
  const plain = stripTags(effectHtml);
  const matches = Array.from(
    plain.matchAll(new RegExp(DIRECTIVE_RE.source, "g")),
  );
  if (!matches.length) return [];

  // Sentence-boundary detection must ignore periods that are part of a
  // directive's own text -- a Compendium UUID path is full of them (e.g.
  // "Compendium.pf2e.conditionitems.Item.Enfeebled") -- confirmed against
  // critical-hit-deck-40's "Sliced Hand", where a second condition sharing
  // an earlier directive's "the target is" clause was wrongly treated as
  // its own sentence starting mid-UUID. Mask every directive span's
  // periods before scanning for sentence starts; the masked copy stays
  // the same length so `match.index` positions still line up, and the
  // (unmasked) `plain` text is still what each subject window is sliced
  // from.
  let masked = plain;
  for (const m of matches) {
    const maskedSpan = m[0].replace(/\./g, " ");
    masked =
      masked.slice(0, m.index) +
      maskedSpan +
      masked.slice(m.index + m[0].length);
  }

  return matches.map((match) => {
    const [raw, keyword, bracketContent, brace] = match;
    const sentenceStart = findSentenceStart(masked, match.index);
    const window = plain.slice(sentenceStart, match.index);
    return buildDirective(keyword, bracketContent, brace, window, raw);
  });
}

/** Parses one deck document's page HTML into its sub-entries --
 * `{name, category, effectHtml, directives}` -- in document order. Not
 * always exactly 4 per card, per #28's own confirmed-live sample data.
 * Pure. */
export function parseDeckEntry(html) {
  const entries = [];
  const re = new RegExp(ENTRY_RE);
  let match;
  while ((match = re.exec(html))) {
    const [, nameHtml, effectHtml, categoryHtml] = match;
    entries.push({
      name: stripTags(nameHtml),
      category: stripTags(categoryHtml),
      effectHtml: effectHtml.trim(),
      directives: extractDirectives(effectHtml),
    });
  }
  return entries;
}

/** Picks one sub-entry uniformly at random from `subentries` matching
 * `category` -- or, defensively, uniformly across every sub-entry
 * regardless of category if none match (shouldn't happen given #28's fixed
 * category sets, but a card format change shouldn't hard-fail a draw).
 * `rng` is injectable for deterministic tests, same convention
 * trap-library.mjs/encounter-roster.mjs already use. */
export function pickSubentry(subentries, category, rng = Math.random) {
  if (!subentries?.length) return null;
  const matching = subentries.filter((s) => s.category === category);
  const pool = matching.length ? matching : subentries;
  const index = Math.min(Math.floor(rng() * pool.length), pool.length - 1);
  return pool[index];
}

const HIT_DAMAGE_TYPE_CATEGORY = {
  bludgeoning: "Bludgeoning",
  piercing: "Piercing",
  slashing: "Slashing",
};

/** The Hit deck's category for a landed critical -- one of PF2e's three
 * physical damage types Title-Cased, or "Bomb or Spell" for anything else
 * (an energy/other damage type, or no weapon damage type at all -- the
 * spell-attack-roll call site has no `strike`). */
export function hitDeckCategory(damageType) {
  return (
    HIT_DAMAGE_TYPE_CATEGORY[(damageType ?? "").toLowerCase()] ??
    "Bomb or Spell"
  );
}

/** The Fumble deck's category for a fumbled attack roll -- `isRanged` wins
 * over `isUnarmed` (a ranged unarmed strike doesn't exist in PF2e, but if
 * it somehow did, Ranged is still the more specific signal for a fumble
 * deck built around delivery method). Everything else is Melee. */
export function fumbleDeckCategory({
  isRanged = false,
  isUnarmed = false,
} = {}) {
  if (isRanged) return "Ranged";
  if (isUnarmed) return "Unarmed";
  return "Melee";
}

function pageTextContent(doc) {
  const pages = Array.isArray(doc.pages)
    ? doc.pages
    : (doc.pages?.contents ?? []);
  return pages[0]?.text?.content ?? "";
}

/** Applies one already-classified directive and returns a short summary of
 * what happened (or `null` for a skip / a directive whose target actor
 * isn't available). `combatant` is the attacker (self), `target` is who
 * they struck -- either can be the applicable actor, since a Fumble card
 * can still target-direct an effect (confirmed live, critical-fumble-deck-2
 * "Overthink It"). Deliberately does not call `applyDefeatIfReducedToZero`:
 * crit-deck damage is flavor-scale (bleed, minor bludgeoning), not a
 * designed lethal blow, and that helper lives in dungeon-combat.mjs, not
 * here. */
async function applyDirective(directive, { combatant, target }) {
  if (directive.type === "skip") return null;

  const who = directive.target === "self" ? combatant : target;
  const actor = who?.actor;
  if (!actor) return null;
  const token = who?.token;

  if (directive.type === "damage") {
    const roll = await new Roll(directive.formula).evaluate();
    await actor.applyDamage({ damage: roll.total, token });
    return {
      type: "damage",
      formula: directive.formula,
      total: roll.total,
      target: directive.target,
    };
  }

  if (directive.type === "condition") {
    await actor.increaseCondition(
      directive.slug,
      directive.value != null ? { value: directive.value } : undefined,
    );
    return {
      type: "condition",
      slug: directive.slug,
      value: directive.value,
      target: directive.target,
    };
  }

  if (directive.type === "effect") {
    const effectDoc = await fromUuid(directive.uuid);
    if (!effectDoc) return null;
    await actor.createEmbeddedDocuments("Item", [effectDoc.toObject()]);
    return { type: "effect", name: effectDoc.name, target: directive.target };
  }

  return null;
}

function buildChatContent({ combatant, deckKind, chosen }) {
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  const deckLabel = deckKind === "hit" ? "Critical Hit" : "Critical Fumble";
  const header = game.i18n.format("PF2EDC.Dungeon.Combat.CriticalDeckChat", {
    name: esc(combatant?.name ?? ""),
    deckLabel,
    cardName: esc(chosen.name),
    category: esc(chosen.category),
  });
  // The effect HTML is posted as-is: it carries the same @Damage/@UUID
  // enricher markup PF2e's own chat log re-enriches on render, same as
  // every other directive-bearing string this module ever hands
  // ChatMessage.create (see castBuffSpellAndApply's sibling chat cards).
  return `${header}${chosen.effectHtml}`;
}

/**
 * Draws one sub-entry from the live `pf2e.criticaldeck` pack's Hit or
 * Fumble deck (`deckKind: 'hit'|'fumble'`), filtered to `category`,
 * auto-applies whichever of its directives resolve cleanly, and posts the
 * full card to chat. `combatant` is the attacker whose Strike/spell-attack
 * just crit or fumbled; `target` is who they rolled against. Returns
 * `{subentry, applied}` or `null` if the pack isn't available or has
 * nothing to draw from -- deliberately a soft no-op rather than throwing,
 * since a missing/renamed compendium shouldn't break the surrounding
 * combat resolution.
 */
export async function drawAndApplyCriticalCard(
  deckKind,
  category,
  { combatant, target } = {},
) {
  const pack = game.packs?.get("pf2e.criticaldeck");
  if (!pack) return null;

  const namePrefix =
    deckKind === "hit" ? "Critical Hit Deck #" : "Critical Fumble Deck #";
  const docs = (await pack.getDocuments?.()) ?? [];
  const deckDocs = docs.filter((doc) =>
    (doc.name ?? "").startsWith(namePrefix),
  );
  const subentries = deckDocs.flatMap((doc) =>
    parseDeckEntry(pageTextContent(doc)),
  );
  if (!subentries.length) return null;

  const chosen = pickSubentry(subentries, category);
  if (!chosen) return null;

  const applied = [];
  for (const directive of chosen.directives) {
    const outcome = await applyDirective(directive, { combatant, target });
    if (outcome) applied.push(outcome);
  }

  await ChatMessage.create({
    content: buildChatContent({ combatant, deckKind, chosen }),
  });

  return { subentry: chosen, applied };
}
