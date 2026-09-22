/**
 * GM-facing chat reminders for a landed Strike's rider effects and critical
 * specialization (#36) -- chat-reminder-only, deliberately: converting these
 * into real mechanical automation (auto-rolling a Grapple check for `grab`,
 * etc.) is tracked separately in #51, one mechanic at a time starting with
 * Grab.
 *
 * Research behind this file (see the #36 progress comment for the fuller
 * write-up):
 *   - `strike.item.system.attackEffects.value` is a real array of ability
 *     slugs on a strike item (confirmed live against the bestiary mirror --
 *     `grab` alone appears 901 times, plus `improved-grab`, `knockdown`,
 *     `push`, `drain-life`, etc). PF2e's own `Actor#getAttackEffects`
 *     (pf2e.mjs) does something very similar already -- matches each slug
 *     against `(item.slug ?? sluggify(item.name)) === slug` on the actor's
 *     own non-`melee`-type items, falling back to the bestiary-ability-
 *     glossary-srd compendium -- and folds the result into the *attack-roll*
 *     message's own GM-visibility notes, unconditionally (not gated on
 *     hit/outcome). This module's own lookup is independent of that: it's
 *     gated on an actual hit (matching #36's ask), doesn't hit a compendium
 *     (keeps the lookup pure and synchronous), and posts as its own clearly
 *     GM-flagged message rather than relying on players never noticing a
 *     GM-visibility note buried in the public attack card.
 *   - Critical specialization is PF2e's own `CritSpecRuleElement`
 *     (pf2e.mjs, ~line 42704). Confirmed by reading that source directly:
 *     the note it attaches (title `PF2E.Actor.Creature.CriticalSpecialization`,
 *     selector `strike-damage`, outcome `["criticalSuccess"]`) is consumed
 *     by `WeaponDamagePF2e.calculate` and ends up in the **damage** roll
 *     ChatMessage's `flags.pf2e.context.notes` -- NOT the attack-roll
 *     message this module reads `outcome` from. The attack-roll message's
 *     own notes come from a different synthetic entirely
 *     (`extractNotes(actor.synthetics.rollNotes, ...)` plus the
 *     `getAttackEffects` notes above); nothing in that path ever reads
 *     `actor.synthetics.criticalSpecializations`, which is the only place
 *     `CritSpecRuleElement` writes to. #36's own text assumed both landed on
 *     the same message read right after the attack roll -- corrected here
 *     after tracing both code paths, the same kind of assumption-correction
 *     the issue's persistent-damage research already did. Practically: the
 *     rider-effect check runs right after the attack roll (all it needs is
 *     the strike item + actor items), but the critical-specialization check
 *     has to run after `strike.damage()` has created its own message, since
 *     that's the message that actually carries the note. Live verification
 *     against a running world wasn't reachable this session (relay reports
 *     no client registered), so this relies on the static pf2e.mjs source
 *     read above plus unit tests against real bestiary fixture data.
 */

const CRIT_SPEC_NOTE_TITLE = "PF2E.Actor.Creature.CriticalSpecialization";

/** Same default-mode behavior as pf2e.mjs's own `sluggify()` (camelCase
 * boundary -> hyphen, lowercase, strip apostrophes, collapse anything
 * non-alphanumeric into a single hyphen) -- only needed here as a fallback
 * for an actor item with no `system.slug` at all, same as PF2e's own
 * `getAttackEffects` falls back to `sluggify(item.name)`. */
function slugifyName(name) {
  return String(name ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** An item's own slug, the same fallback chain #36 describes: a real
 * `system.slug` field first (the common case), a top-level `.slug` (how a
 * live PF2e Item document's own getter exposes it), and finally a
 * slugified name for an item that has neither. */
function itemSlug(item) {
  return item?.system?.slug ?? item?.slug ?? slugifyName(item?.name);
}

/** The actor item carrying rider ability `slug`, or `null`. Deliberately
 * excludes `type === "melee"` items -- a strike's own synthetic melee item
 * can incidentally share its rider's slug (see the "grab" strike whose own
 * `system.slug` is also "grab" in the test fixtures), and matching that
 * would misreport the strike as its own rider ability. PF2e's own
 * `Actor#getAttackEffects` excludes the same type for the same reason. */
function findRiderAbilityItem(slug, actorItems) {
  return (
    actorItems.find(
      (item) => item?.type !== "melee" && itemSlug(item) === slug,
    ) ?? null
  );
}

/**
 * Every rider effect a strike carries, matched against the attacking
 * actor's own items -- pure, so it's testable without a live Foundry strike
 * or actor. `strike` is the `system.actions` entry this module already
 * works with elsewhere (`strike.item.system.attackEffects.value`);
 * `actorItems` is the attacker's `actor.items` (or an equivalent plain
 * array in tests).
 *
 * Returns one entry per slug in `attackEffects.value`, in order:
 *   - `{ slug, found: true, name, description }` when a matching ability
 *     item was found (`description` is that item's own
 *     `system.description.value`, left as HTML -- see this file's header
 *     for why raw HTML rather than stripped text).
 *   - `{ slug, found: false }` when no matching item exists on this actor,
 *     so the GM still gets the slug named rather than nothing at all.
 */
export function extractRiderEffects(strike, actorItems = []) {
  const slugs = strike?.item?.system?.attackEffects?.value ?? [];
  return slugs.map((slug) => {
    const item = findRiderAbilityItem(slug, actorItems);
    if (!item) return { slug, found: false };
    return {
      slug,
      found: true,
      name: item.name,
      description: item.system?.description?.value ?? null,
    };
  });
}

/**
 * The critical-specialization note on a chat message's data, if PF2e's own
 * system already attached one -- pure, testable with a fixture object (no
 * live Foundry message). `messageData` is whatever shape a ChatMessage
 * document's own data exposes (`{ flags: { pf2e: { context: { notes } } } }`
 * -- confirmed against pf2e.mjs, see this file's header). Identified by
 * `title === "PF2E.Actor.Creature.CriticalSpecialization"`, the one literal
 * string `CritSpecRuleElement#getEffect` always uses for it regardless of
 * weapon group or `alternate` mode. Returns `{ title, text }` (both still
 * i18n keys/raw text at this point -- localization is the orchestrator's
 * job, same as PF2e's own `RollNotePF2e#toHTML` localizes at render time)
 * or `null` if this message carries no such note.
 */
export function extractCriticalSpecializationNote(messageData) {
  const notes = messageData?.flags?.pf2e?.context?.notes ?? [];
  const note = notes.find((n) => n?.title === CRIT_SPEC_NOTE_TITLE);
  if (!note) return null;
  return { title: note.title, text: note.text };
}

function escapeHtml(value) {
  return foundry.utils.escapeHTML?.(String(value)) ?? String(value);
}

async function whisperGm(content) {
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  await ChatMessage.create({ content, whisper: gmIds });
}

/**
 * On a hit (`success`/`criticalSuccess`), whispers the GM one reminder
 * listing every rider effect `strike` carries -- a matched ability's name
 * and description, or (per #36) just the bare slug when no matching item
 * was found so the GM isn't left with nothing. Posts nothing when the
 * strike carries no `attackEffects` at all, matching #36's "don't spam
 * empty reminders."
 */
export async function postStrikeRiderReminder(combatant, strike, outcome) {
  if (outcome !== "success" && outcome !== "criticalSuccess") return;
  const riders = extractRiderEffects(strike, combatant?.actor?.items ?? []);
  if (riders.length === 0) return;

  const attacker = escapeHtml(combatant?.name ?? "Attacker");
  const lines = riders.map((rider) => {
    if (rider.found) {
      return `<p><strong>Rider effect (${attacker}):</strong> ${escapeHtml(rider.name)}</p>${rider.description ?? ""}`;
    }
    return `<p><strong>Rider effect (${attacker}):</strong> ${escapeHtml(rider.slug)} (no matching ability item found on this actor — check its stat block manually)</p>`;
  });
  await whisperGm(lines.join(""));
}

const GRAB_RIDER_SLUGS = new Set(["grab", "improved-grab", "tongue-grab"]);

/**
 * #51's first mechanized rider (of #36's chat-reminder-only set): on a hit
 * whose strike carries `grab`/`improved-grab`/`tongue-grab`, rolls the
 * attacker's own Athletics check against the target's Fortitude DC and, on
 * success, applies the Grabbed condition -- PF2e's real Grapple-attempt
 * resolution these abilities trigger. Deliberately a baseline resolution
 * only: `improved-grab`'s "grab a second target simultaneously" / "no hand
 * needs to be free" wording, and `tongue-grab`'s reach/release rules, are
 * NOT modeled -- all three get the same Athletics-vs-Fortitude-DC ->
 * Grabbed treatment. `knockdown`, `push`, `drain-life` and the rest of
 * #51's slug list are untouched here; each is its own follow-up mechanic
 * per that issue's own scope.
 *
 * Only fires on an actual hit (`success`/`criticalSuccess`), matching
 * `postStrikeRiderReminder`'s own gate, and only when both an Athletics
 * statistic (attacker) and a Fortitude DC (target) actually exist -- a
 * creature with no `skills.athletics` (some incorporeal/mindless
 * creatures) or a target with no `saves.fortitude` safely no-ops rather
 * than throwing. No dialog-suppression wrapping here: both call sites
 * (`rollAndApplyStrike`/`rollAndApplyStrikeAtVariant` in
 * dungeon-combat.mjs) already suppress check/damage dialogs for their
 * whole strike sequence before this ever runs -- the same reason
 * `postStrikeRiderReminder`/`drawCriticalCardForStrike` alongside it don't
 * re-wrap either.
 *
 * Returns the Grapple attempt's own outcome (distinct from `outcome`, the
 * Strike's own attack-roll outcome this was gated on), or `null` when
 * nothing was rolled at all.
 */
export async function resolveGrabRider(combatant, target, strike, outcome) {
  if (outcome !== "success" && outcome !== "criticalSuccess") return null;
  const riders = extractRiderEffects(strike, combatant?.actor?.items ?? []);
  if (!riders.some((rider) => GRAB_RIDER_SLUGS.has(rider.slug))) return null;

  const athletics = combatant?.actor?.skills?.athletics;
  const fortitudeDc = target?.actor?.saves?.fortitude?.dc?.value;
  if (!athletics || fortitudeDc == null) return null;

  await athletics.roll({ dc: { value: fortitudeDc }, createMessage: true });
  const grappleOutcome =
    game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;

  const attacker = escapeHtml(combatant?.name ?? "Attacker");
  if (grappleOutcome === "success" || grappleOutcome === "criticalSuccess") {
    await target.actor.increaseCondition("grabbed");
    await whisperGm(
      `<p><strong>Grapple (${attacker}):</strong> Athletics check succeeded — target is now Grabbed.</p>`,
    );
  } else {
    await whisperGm(
      `<p><strong>Grapple (${attacker}):</strong> Athletics check failed — target is not Grabbed.</p>`,
    );
  }
  return grappleOutcome;
}

/**
 * On a critical hit only, re-posts PF2e's own already-computed critical-
 * specialization note (see this file's header for where it actually lives)
 * as its own clearly GM-flagged reminder, rather than leaving it buried in
 * the standard damage card. Does NOT recompute eligibility itself -- only
 * ever re-surfaces a note PF2e's own system already attached.
 *
 * `messageData` defaults to the most recently created message
 * (`game.messages.contents.at(-1)`) -- the damage message, at the point
 * this is meant to be called from (see the 2 call sites in
 * dungeon-combat.mjs) -- but takes an explicit message for testing.
 */
export async function postCriticalSpecializationReminder(
  combatant,
  outcome,
  messageData = game.messages?.contents?.at(-1),
) {
  if (outcome !== "criticalSuccess") return;
  const note = extractCriticalSpecializationNote(messageData);
  if (!note) return;

  const attacker = escapeHtml(combatant?.name ?? "Attacker");
  const title = escapeHtml(game.i18n.localize(note.title));
  const text = game.i18n.localize(note.text);
  await whisperGm(`<p><strong>${title} (${attacker}):</strong></p>${text}`);
}
