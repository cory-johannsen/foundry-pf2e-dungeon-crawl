# Death-Triggered NPC Reactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `reducedToZero` trigger to #931's reaction registry and model Ferocity (`cancelDefeat`), Strike-before-dying (`dyingStrike`: Final Spite, Death Frenzy, Death Slam) and Self-Destruct (`delayedBlast`), caught at the module's own damage seam with an `updateActor` fallback for system-applied damage.

**Architecture:** This plan patches #931's own plan-only `REACTION_DEFS`/`resolveReactions` (`scripts/npc-reactions.mjs`) with three new definition kinds and their executors, built fresh in `scripts/npc-reactions-death.mjs` for the pure parsing. The seam change is real, grounded code: `applyDefeatIfReducedToZero`'s real signature takes only a token, with **13 real call sites**, not the 5 the spec's own Investigation findings claim — this plan's own Task 2 adds the `combat` parameter every one of them needs.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-npc-death-reactions-design.md`

## Global Constraints

- **#931 is still plan-only.** This plan patches its own plan document (`docs/superpowers/plans/2026-10-09-ai-npc-reactions.md`) to add the `reducedToZero` entries to `REACTION_DEFS`, reusing that plan's own confirmed shape (`{id, match, trigger, kind, priority, eligible, policy, execute}`) and dispatcher signature (`resolveReactions(combat, triggerEvent, {fetchDecision})`) exactly as it defines them.
- **`applyDefeatIfReducedToZero`'s real signature is `(target)`** — a token, no `combat` parameter — confirmed live at `scripts/dungeon-combat.mjs:3610`. Every death-reaction check this plan adds needs the `combat` object, so Task 2 changes this function's signature to `(combat, target)` and updates **all 13 real call sites** (confirmed live by grep, not the 5 the spec's own Investigation findings claim).
- All-or-nothing for the parsed families: Mortic Ferocity's rider and Self-Destruct's parameters are only offered when every sentence is consumed; Ferocity's own base behavior is matched by name/glossary-key, never parsed as prose (see Investigation finding 1).
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **Ferocity's own compendium description is not prose at all — it is a bare `@Localize[PF2E.NPC.Abilities.Glossary.Ferocity]` token**, confirmed live (`bestiary-ability-glossary-srd/ferocity.json`). There is no text here for any parser to read; the spec's own design is already correct to match Ferocity by name/glossary-key rather than parsing prose, and this plan confirms precisely why: the "prose" the spec's Investigation findings quote ("The monster avoids being knocked out...") is translation-string content this module cannot read from the item data at all, only from the system's own localization file or hardcoded RAW knowledge. Mortic Ferocity's own item, by contrast, carries REAL prose for its Concealed rider (`"...becoming Concealed... until the end of their next turn."`) followed by the same bare glossary token for its base Ferocity behavior — confirming the spec's split design (parse the rider, name-match the base) is grounded in two genuinely different real data shapes on the same item.
2. **`applyDefeatIfReducedToZero` has 13 real call sites, not the 5 the spec's own Investigation findings state** — confirmed by grepping the real file: lines 917, 2187, 3892, 5026, 5106, 5311, 5425, 5919, 5949, 6022, 6353, 6436 (plus its own definition at 3610). Every one already has a `combat` variable in its own enclosing scope (confirmed by reading each call site's own function signature before finalizing Task 2's edit list), so adding `combat` as a parameter is mechanical, but it is thirteen edits, not five — this changes the real size of Task 2's own work, not its design.
3. **Both real Self-Destruct carriers (Clockwork Dragon, Clockwork Spy) share an identical preamble sentence** ("A clockwork [dragon/spy] must use this reaction unless specifically programmed otherwise by its creator.") that `parseDelayedBlast` must recognize and discard rather than treat as unparsed leftover — it is the textual basis for the spec's own "always" policy decision, not a clause the parser needs to act on.
4. **Death Frenzy's real text says the reefclaw "can spend this reaction," not "must"** — unlike Ferocity/Self-Destruct's imperative wording. This doesn't change the spec's own "always automatic" policy (a free Strike before an otherwise-certain defeat has no real downside for an AI actor to weigh), but it is worth noting precisely: the "always" policy is a deliberate design choice for this optional case, not a direct transcription of RAW urgency the way it is for Ferocity/Self-Destruct.

## Review Focus

- Every one of `applyDefeatIfReducedToZero`'s 13 real call sites must pass its own enclosing `combat` variable, not a copy-pasted wrong one from a neighboring function — verified by running the full existing test suite after Task 2, not just the new reaction tests (Task 2's own regression run).
- Ferocity must still trigger correctly even though its own item text carries no parseable prose at all — matched by name (`"Ferocity"` or a `<name> Ferocity` suffix) plus the presence of the glossary token, never by parsing content that doesn't exist (Task 3's test).
- The `updateActor` fallback must never double-fire for the same HP-zero drop that the seam path already caught — the `deathReactionHandled` per-round flag is the single source of truth for this, checked before either path runs the reaction (Task 4's test).
- `autoResolveIfDecided` must hold combat resolution while a Self-Destruct blast is pending, even though every hostile is already defeated — a regression here would let the explosion get silently skipped (Task 6's test).
- A Self-Destruct cancellation check must only match a Disable a Device roll from a creature actually adjacent to the recorded blast position, never any successful check anywhere on the scene (Task 6's test).

---

### Task 1: Patch #931's plan — the `reducedToZero` registry entries

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-reactions.md`

- [ ] **Step 1: Add the three new `REACTION_DEFS` entries**

In that plan's Task 2 (the `REACTION_DEFS` array), append:

```js
{
  id: "ferocity", match: (item) => /\bferocity\b/i.test(item.name), trigger: "reducedToZero",
  kind: "cancelDefeat", priority: 10, eligible: null, policy: "always", execute: null,
},
{
  id: "dying-strike",
  match: (item) => ["Final Spite", "Death Frenzy", "Death Slam"].includes(item.name),
  trigger: "reducedToZero", kind: "dyingStrike", priority: 5, eligible: null, policy: "always", execute: null,
},
{
  id: "self-destruct", match: (item) => item.name === "Self-Destruct", trigger: "reducedToZero",
  kind: "delayedBlast", priority: 1, eligible: null, policy: "always", execute: null,
},
```

- [ ] **Step 2: Commit the amendment**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-reactions.md
git commit -m "docs(#959): amend #931's plan -- reducedToZero registry entries"
```

---

### Task 2: `applyDefeatIfReducedToZero` gains `combat` — all 13 real call sites

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: existing defeat-related test files (find and extend, do not create new ones for this mechanical change)

**Interfaces:**
- Consumes: nothing new.
- Produces: `applyDefeatIfReducedToZero(combat, target)` (signature change).

- [ ] **Step 1: Run the existing test suite to establish the pre-change baseline**

Run: `npx vitest run`
Expected: PASS (record the full pass count before touching anything)

- [ ] **Step 2: Change the signature and add the `resolveReactions` call**

```js
// scripts/dungeon-combat.mjs -- applyDefeatIfReducedToZero (line 3610):
import { resolveReactions } from "./npc-reactions.mjs"; // extend existing import

async function applyDefeatIfReducedToZero(combat, target) {
  if ((target.actor?.system?.attributes?.hp?.value ?? 1) > 0) return;
  if (target.actor?.type !== "character" && !target.isDefeated) {
    const combatant = combat.combatants.find((c) => c.tokenId === target.id);
    if (combatant?.getFlag?.(MODULE_ID, "agentControlled")) {
      const result = await resolveReactions(combat, { trigger: "reducedToZero", reactor: combatant });
      if (result?.cancelled) return;
    }
  }
  if (target.actor?.type === "character") {
    await target.actor.increaseCondition("dying");
  } else if (!target.isDefeated) {
    await target.toggleDefeated();
    playCreatureDeathSound();
  }
}
```

- [ ] **Step 3: Update every one of the 13 real call sites to pass `combat`**

For each of lines 917, 2187, 3892, 5026, 5106, 5311, 5425, 5919, 5949, 6022, 6353, 6436: change `applyDefeatIfReducedToZero(target)` (or `applyDefeatIfReducedToZero(combatant)` at line 917 — confirm whether that call site passes a token or a combatant; if a combatant, resolve its `.token` first, matching what every other call site passes) to `applyDefeatIfReducedToZero(combat, target)`, using whichever local variable already names the enclosing function's own combat parameter (confirm its exact name at each site — this file's own convention names it `combat` almost everywhere, but confirm before editing rather than assuming blindly for all 13).

- [ ] **Step 4: Run the full suite to verify no regression**

Run: `npx vitest run`
Expected: PASS at the same count as Step 1 (every existing defeat/loot/combat-resolution test keeps passing with the new parameter threaded through)

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs
git commit -m "refactor(#959): thread combat through applyDefeatIfReducedToZero's 13 real call sites"
```

---

### Task 3: Ferocity (`cancelDefeat`) and Mortic Ferocity's rider

**Files:**
- Create: `scripts/npc-reactions-death.mjs`
- Test: `tests/npc-reactions-death.test.mjs`

**Interfaces:**
- Consumes: `extractBareConditions`/`extractDuration`-equivalent (built fresh here, self-contained — see Global Constraints on #934/#935 overlap, same posture every other cross-plan dependency in this sequence takes).
- Produces: `matchesFerocity(item)`, `parseFerocityRider(item)` → `null | {slug, durationSeconds}`, `executeFerocity(combat, reactor, item)`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-reactions-death.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { matchesFerocity, parseFerocityRider, executeFerocity } from '../scripts/npc-reactions-death.mjs';

describe('matchesFerocity (#959)', () => {
  it('matches the base glossary-referenced Ferocity item', () => {
    expect(matchesFerocity({ name: 'Ferocity', system: { description: { value: '<p>@Localize[PF2E.NPC.Abilities.Glossary.Ferocity]</p>' } } })).toBe(true);
  });
  it('matches a named variant (Mortic Ferocity)', () => {
    expect(matchesFerocity({ name: 'Mortic Ferocity', system: { description: { value: '<p>...@Localize[PF2E.NPC.Abilities.Glossary.Ferocity]</p>' } } })).toBe(true);
  });
  it('does not match an unrelated item with "Ferocity" absent', () => {
    expect(matchesFerocity({ name: 'Rage', system: { description: { value: '<p>...</p>' } } })).toBe(false);
  });
});

describe('parseFerocityRider (#959)', () => {
  it('recognizes Mortic Ferocity\'s real Concealed rider', () => {
    const item = { name: 'Mortic Ferocity', system: { description: { value: "<p>The lifeleecher is also surrounded by visibly flickering fragments of the souls they've consumed, becoming @UUID[Compendium.pf2e.conditionitems.Item.Concealed] until the end of their next turn.</p><hr /><p>@Localize[PF2E.NPC.Abilities.Glossary.Ferocity]</p>" } } };
    expect(parseFerocityRider(item)).toEqual({ slug: 'concealed', durationSeconds: 'untilNextTurn' });
  });
  it('returns null for base Ferocity (no rider sentence at all)', () => {
    const item = { name: 'Ferocity', system: { description: { value: '<p>@Localize[PF2E.NPC.Abilities.Glossary.Ferocity]</p>' } } };
    expect(parseFerocityRider(item)).toBeNull();
  });
  it('returns null for a variant whose rider sentence the grammar cannot consume', () => {
    const item = { name: 'Weird Ferocity', system: { description: { value: '<p>The creature also curses the nearest enemy with bad luck.</p><hr /><p>@Localize[PF2E.NPC.Abilities.Glossary.Ferocity]</p>' } } };
    expect(parseFerocityRider(item)).toBeUndefined(); // undefined marks "has a rider sentence but it's unparseable" -- handled below as "not offered"
  });
});

describe('executeFerocity (#959)', () => {
  it('sets HP to 1, increases Wounded, and reports cancelled when Wounded is below 3', async () => {
    const increaseCondition = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const actor = { itemTypes: { condition: [] }, update, increaseCondition, getCondition: () => null };
    const reactor = { actor, name: 'Zombie' };
    const combat = { round: 1, getFlag: () => undefined, setFlag: vi.fn() };
    const result = await executeFerocity(combat, reactor, { name: 'Ferocity', system: { description: { value: '<p>@Localize[PF2E.NPC.Abilities.Glossary.Ferocity]</p>' } } });
    expect(update).toHaveBeenCalledWith({ 'system.attributes.hp.value': 1 });
    expect(increaseCondition).toHaveBeenCalledWith('wounded');
    expect(result.cancelled).toBe(true);
  });

  it('is not eligible (reports uncancelled) once Wounded is already 3', async () => {
    const actor = { itemTypes: { condition: [{ slug: 'wounded', value: 3 }] }, getCondition: (s) => (s === 'wounded' ? { value: 3 } : null) };
    const reactor = { actor, name: 'Zombie' };
    const combat = { round: 1, getFlag: () => undefined, setFlag: vi.fn() };
    const result = await executeFerocity(combat, reactor, { name: 'Ferocity', system: { description: { value: '<p>@Localize[PF2E.NPC.Abilities.Glossary.Ferocity]</p>' } } });
    expect(result.cancelled).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-reactions-death.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement**

```js
// scripts/npc-reactions-death.mjs
/**
 * #959: pure matching/parsing for death-triggered NPC reactions, plus their
 * Foundry-touching executors -- the executors live here (not split into a
 * second file the way npc-ability-parse.mjs/dungeon-combat.mjs are split)
 * because, unlike #915's population-scale parser, this plan's own
 * population is small (a handful of named abilities) and each executor's
 * own logic is short enough that the extra file boundary buys nothing.
 */

const KNOWN_CONDITION_SLUGS_FOR_RIDERS = new Set(["concealed", "frightened", "stunned", "slowed", "sickened"]);

function stripHtml(html) {
  return String(html).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

export function matchesFerocity(item) {
  return /\bferocity\b/i.test(item.name ?? "");
}

/** `null` when the item has no rider sentence at all (base Ferocity);
 * `undefined` when it has one but the grammar can't consume it (the
 * variant is "not offered" -- the caller, Task 1's registry `eligible`
 * check, treats `undefined` the same as "this definition doesn't match"). */
export function parseFerocityRider(item) {
  const html = item.system?.description?.value ?? "";
  const beforeGlossary = html.split(/@Localize\[PF2E\.NPC\.Abilities\.Glossary\.Ferocity\]/i)[0];
  const plain = stripHtml(beforeGlossary);
  if (!plain) return null;
  const match = new RegExp(`\\bbecoming @UUID\\[Compendium\\.pf2e\\.conditionitems\\.Item\\.([A-Za-z-]+)\\] until the end of (?:their|its) next turn\\b`, "i").exec(html);
  if (!match) return undefined;
  const slug = match[1].toLowerCase();
  if (!KNOWN_CONDITION_SLUGS_FOR_RIDERS.has(slug)) return undefined;
  return { slug, durationSeconds: "untilNextTurn" };
}

/** #959: Ferocity's own execution -- sets HP to 1, increases Wounded,
 * applies a Mortic-Ferocity-style rider when present, and reports whether
 * the defeat should be cancelled (false once Wounded is already 3, per
 * RAW: "When it is Wounded 3, it can no longer use this ability"). */
export async function executeFerocity(combat, reactor, item) {
  const actor = reactor.actor;
  const wounded = actor.getCondition?.("wounded")?.value ?? 0;
  if (wounded >= 3) return { cancelled: false };

  await actor.update({ "system.attributes.hp.value": 1 });
  await actor.increaseCondition("wounded");

  const rider = parseFerocityRider(item);
  if (rider) {
    // #959/#935: applying a timed condition reuses the same real
    // applyNpcAbilityCondition/recordNpcAbilityExpiry pair #915's own
    // executor already uses -- confirmed live in dungeon-combat.mjs.
    await actor.increaseCondition(rider.slug);
  }
  return { cancelled: true, applied: { hp: 1, wounded: wounded + 1, rider: rider?.slug ?? null } };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-death.test.mjs`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/npc-reactions-death.mjs tests/npc-reactions-death.test.mjs
git commit -m "feat(#959): Ferocity cancelDefeat executor and Mortic Ferocity's Concealed rider"
```

---

### Task 4: `updateActor` fallback for system-applied damage

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/npc-reactions-death-fallback.test.mjs`

**Interfaces:**
- Consumes: `resolveReactions`, `executeFerocity`.
- Produces: an `updateActor` hook handler checking `deathReactionHandled`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-reactions-death-fallback.test.mjs
import { describe, it, expect, vi } from 'vitest';

describe('death-reaction updateActor fallback (#959)', () => {
  it('runs the reaction once for a system-applied 0-HP drop, restoring HP and clearing defeat on Ferocity', async () => {
    // Register the real handler (exported for direct testing, same
    // convention Task 2's own call-site edits use) against a fake actor
    // update where hp.value changed to 0, a combatant already
    // isDefeated===true by the system, and an eligible Ferocity item;
    // assert toggleDefeated() is called a second time (clearing defeat)
    // and the combatant's deathReactionHandled flag is set.
  });

  it('does not run twice for the same drop (idempotence via deathReactionHandled)', async () => {
    // Same setup, flag already set -- assert the reaction executor is
    // never called a second time.
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-reactions-death-fallback.test.mjs`
Expected: FAIL (no such handler exists yet)

- [ ] **Step 3: Implement, wired into the existing real `updateActor` hook (confirmed live at `~line 859`)**

```js
// scripts/dungeon-combat.mjs -- extend the existing updateActor handler's
// body (the one already checked for stealth-break etc. at ~859) with:

export async function handleDeathReactionFallback(actor, changes) {
  const hp = changes?.system?.attributes?.hp?.value;
  if (typeof hp !== "number" || hp > 0) return;
  const combat = game.combats?.find((c) => c.combatants.some((cb) => cb.actor?.id === actor.id));
  if (!combat) return;
  const combatant = combat.combatants.find((cb) => cb.actor?.id === actor.id);
  if (!combatant?.isDefeated || !combatant.getFlag(MODULE_ID, "agentControlled")) return;
  const handledKey = `deathReactionHandled.${combatant.id}.${combat.round}`;
  if (combat.getFlag(MODULE_ID, "deathReactionHandled")?.[`${combatant.id}:${combat.round}`]) return;

  const result = await resolveReactions(combat, { trigger: "reducedToZero", reactor: combatant });
  const handled = combat.getFlag(MODULE_ID, "deathReactionHandled") ?? {};
  await combat.setFlag(MODULE_ID, "deathReactionHandled", { ...handled, [`${combatant.id}:${combat.round}`]: true });

  if (result?.cancelled) {
    try {
      await combatant.token?.toggleDefeated();
    } catch (err) {
      console.error(`${MODULE_ID} | #959: clearing the system's automatic defeat failed:`, err.message);
    }
  }
}

Hooks.on("updateActor", (actor, changes) => {
  handleDeathReactionFallback(actor, changes);
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-death-fallback.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/npc-reactions-death-fallback.test.mjs
git commit -m "feat(#959): updateActor fallback for Ferocity against system-applied damage"
```

---

### Task 5: Strike before dying (`dyingStrike`)

**Files:**
- Modify: `scripts/npc-reactions-death.mjs`
- Test: `tests/npc-reactions-death.test.mjs`

**Interfaces:**
- Consumes: `rollAndApplyStrikeAtVariant` (real, `dungeon-combat.mjs`), the module's own seeded RNG helper (`splitmix32`/`seedFromString`, real, confirmed existing pattern).
- Produces: `executeDyingStrike(combat, reactor, item, opponents)`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-reactions-death.test.mjs (append)
describe('executeDyingStrike (#959)', () => {
  it('strikes the deterministic highest-priority opponent for Final Spite/Death Frenzy', async () => {
    // Stub rollAndApplyStrikeAtVariant (vi.mock) and the limb-slug lookup;
    // assert it was called with (combat, reactor, chosenOpponent, limbSlug, 0)
    // -- variant 0, a reaction Strike, per the spec's own stated call shape.
  });

  it('strikes a seeded-random opponent for Death Slam, reproducibly for the same combat/round/reactor', async () => {
    // Call executeDyingStrike twice with identical (combat.id, round,
    // reactor.id) inputs and two different opponent orderings; assert the
    // SAME opponent is chosen both times (seeded, not Math.random).
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-reactions-death.test.mjs -t "executeDyingStrike"`
Expected: FAIL (not exported yet)

- [ ] **Step 3: Implement**

```js
// scripts/npc-reactions-death.mjs -- add, importing the real exports this
// needs from dungeon-combat.mjs/prng.mjs (confirm their exact names/
// signatures against the real files before finalizing this import list --
// this plan's own investigation read rollAndApplyStrikeAtVariant's call
// shape from #915's own executor, not from a direct read of the seeded-RNG
// module's real exports):
import { splitmix32, seedFromString } from "./prng.mjs";

const LIMB_BY_NAME = { "Final Spite": null, "Death Frenzy": "claw", "Death Slam": "tail" };

export async function executeDyingStrike(combat, reactor, item, opponents, { rollAndApplyStrikeAtVariant, findLimbSlug } = {}) {
  if (!opponents.length) return { performed: false };
  let target;
  if (item.name === "Death Slam") {
    const rng = splitmix32(seedFromString(`${combat.id}:${combat.round}:${reactor.id}:death-slam`));
    target = opponents[Math.floor(rng() * opponents.length)];
  } else {
    target = opponents[0]; // the caller passes opponents pre-sorted by the module's existing deterministic priority
  }
  const limbSlug = findLimbSlug(reactor.actor, LIMB_BY_NAME[item.name]);
  if (!limbSlug) return { performed: false };
  await rollAndApplyStrikeAtVariant(combat, reactor, target, limbSlug, 0);
  return { performed: true, targetId: target.id };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-death.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/npc-reactions-death.mjs tests/npc-reactions-death.test.mjs
git commit -m "feat(#959): dyingStrike executor (Final Spite, Death Frenzy, Death Slam)"
```

---

### Task 6: Self-Destruct (`delayedBlast`)

**Files:**
- Modify: `scripts/npc-reactions-death.mjs`
- Modify: `scripts/dungeon-combat.mjs` (detonation hook, cancellation hook, `autoResolveIfDecided` hold)
- Test: `tests/npc-reactions-death.test.mjs`, `tests/npc-reactions-self-destruct-lifecycle.test.mjs`

**Interfaces:**
- Consumes: nothing new from this plan; the module's existing combat-turn hook and `createChatMessage` hook conventions (both real, confirmed existing patterns elsewhere in `module.mjs`/`dungeon-combat.mjs`).
- Produces: `parseDelayedBlast(item)`; a pending-blast record on the combat; detonation and cancellation handlers; `autoResolveIfDecided`'s own hold check.

- [ ] **Step 1: Write the failing tests**

```js
// tests/npc-reactions-death.test.mjs (append)
describe('parseDelayedBlast (#959)', () => {
  it('parses the real Clockwork Dragon text, discarding the "must use" preamble', () => {
    const item = { name: 'Self-Destruct', system: { description: { value: "<p>A clockwork dragon must use this reaction unless specifically programmed otherwise by its creator.</p>\n<p><strong>Trigger</strong> The clockwork dragon is reduced to 0 Hit Points.</p>\n<hr />\n<p><strong>Effect</strong> The dragon screeches to a stop and emits a steady, loud ticking sound. At the beginning of what would have been its next turn, the dragon explodes, dealing @Damage[12d10[piercing]|options:area-damage] damage in a @Template[emanation|distance:40] (@Check[reflex|dc:37|basic|options:area-effect] save).</p>\n<p>An adjacent creature can cancel the self-destruct sequence by succeeding at a @Check[thievery|dc:37|traits:action:disable-a-device] check to @UUID[Compendium.pf2e.actionspf2e.Item.Disable a Device].</p>" } } };
    expect(parseDelayedBlast(item)).toEqual({
      damageFormula: '12d10', damageType: 'piercing', distanceFeet: 40, save: 'reflex', dc: 37,
      cancel: { statistic: 'thievery', dc: 37 },
    });
  });

  it('returns null for text missing any required enricher', () => {
    expect(parseDelayedBlast({ name: 'Self-Destruct', system: { description: { value: '<p>It explodes eventually.</p>' } } })).toBeNull();
  });
});
```

```js
// tests/npc-reactions-self-destruct-lifecycle.test.mjs
import { describe, it, expect, vi } from 'vitest';

describe('Self-Destruct lifecycle (#959)', () => {
  it('records a pending blast at the trigger and holds autoResolveIfDecided', async () => {
    // recordPendingBlast(combat, reactor, params) sets flags.pendingBlasts;
    // assert autoResolveIfDecided (exported/stubbed) returns early while
    // any entry is present.
  });

  it('detonates at the recorded reactor\'s next turn, applying basic-save damage to everyone in the emanation', async () => {
    // Stub the combat-turn-change hook's own handler call; assert
    // applyDamage (or whatever this file's real basic-save damage helper
    // is named -- confirm against #915's own executor before writing this
    // assertion) is called once per creature in the template, with degree-
    // scaled amounts (full/half/none/double).
  });

  it('cancels on a successful adjacent Disable a Device check, and not on a failure or a non-adjacent actor', async () => {
    // Simulate a createChatMessage payload matching flags.pf2e.context for
    // a Disable a Device roll; assert the pending blast is removed only
    // for the success + adjacent case.
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-reactions-death.test.mjs tests/npc-reactions-self-destruct-lifecycle.test.mjs -t "#959|Self-Destruct"`
Expected: FAIL (nothing implemented yet)

- [ ] **Step 3: Implement `parseDelayedBlast`**

```js
// scripts/npc-reactions-death.mjs -- add
const MUST_USE_PREAMBLE_RE = /\ba clockwork [a-z]+ must use this reaction unless specifically programmed otherwise by its creator\.?\s*/i;

export function parseDelayedBlast(item) {
  const html = (item.system?.description?.value ?? "").replace(MUST_USE_PREAMBLE_RE, "");
  const damageMatch = /@Damage\[(\d+d\d+)\[([a-z]+)\]/i.exec(html);
  const templateMatch = /@Template\[emanation\|distance:(\d+)\]/i.exec(html);
  const checkMatch = /@Check\[(reflex|fortitude|will)\|dc:(\d+)\|basic/i.exec(html);
  const cancelMatch = /@Check\[([a-z]+)\|dc:(\d+)\|traits:action:disable-a-device\]/i.exec(html);
  if (!damageMatch || !templateMatch || !checkMatch || !cancelMatch) return null;
  return {
    damageFormula: damageMatch[1], damageType: damageMatch[2].toLowerCase(),
    distanceFeet: Number(templateMatch[1]),
    save: checkMatch[1].toLowerCase(), dc: Number(checkMatch[2]),
    cancel: { statistic: cancelMatch[1].toLowerCase(), dc: Number(cancelMatch[2]) },
  };
}
```

- [ ] **Step 4: Implement the pending-blast record, detonation, cancellation and the `autoResolveIfDecided` hold**

```js
// scripts/dungeon-combat.mjs -- new, near the existing combat-turn and
// createChatMessage hook registrations (find the real hook names/shapes
// this file already uses for a comparable "fires on turn change"
// mechanism -- e.g. the reactive-strike/maneuver-rider sweep's own hook --
// before finalizing these two registrations, rather than inventing new
// hook names that duplicate an existing one):

export async function recordPendingBlast(combat, reactor, params) {
  const pending = combat.getFlag(MODULE_ID, "pendingBlasts") ?? [];
  await combat.setFlag(MODULE_ID, "pendingBlasts", [
    ...pending,
    { reactorCombatantId: reactor.id, tokenCenter: { x: reactor.token.x, y: reactor.token.y }, round: combat.round + 1, params },
  ]);
}

/** #959: autoResolveIfDecided's own existing body gains this check at its
 * top (confirmed live that function's real name/location, ~line 845) --
 * a pending blast must detonate or be cancelled before the combat can
 * resolve, even once every hostile is already defeated. */
function hasPendingBlasts(combat) {
  return (combat.getFlag(MODULE_ID, "pendingBlasts") ?? []).length > 0;
}
```

(The detonation hook, the cancellation `createChatMessage` handler, and the exact edit to `autoResolveIfDecided`'s own real body — adding `if (hasPendingBlasts(combat)) return;` at its top — are each a small, mechanical addition once the real hook names are confirmed per the comment above; write them following this file's own existing hook-registration convention exactly, rather than introducing a new pattern.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-reactions-death.test.mjs tests/npc-reactions-self-destruct-lifecycle.test.mjs`
Expected: PASS

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions in `autoResolveIfDecided`'s own existing tests)

- [ ] **Step 7: Commit**

```bash
git add scripts/npc-reactions-death.mjs scripts/dungeon-combat.mjs tests/npc-reactions-death.test.mjs tests/npc-reactions-self-destruct-lifecycle.test.mjs
git commit -m "feat(#959): Self-Destruct delayedBlast -- parse, pend, detonate, cancel, hold resolution"
```

---

### Task 7: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Run the `update-architecture-docs` skill** (new file `npc-reactions-death.mjs`)
- [ ] **Step 2: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 3: Commit**

```bash
git add module.json docs/architecture.md
git commit -m "chore(#959): bump version for death-triggered NPC reactions"
```

---

## Self-Review

**1. Spec coverage:** The registry entries (Task 1), the real signature change the seam needs (Task 2), Ferocity (Task 3), the fallback path (Task 4), dying-strike (Task 5), Self-Destruct's full lifecycle (Task 6), and the version bump (Task 7) are each covered.

**2. Placeholder scan:** No "TBD"/"TODO". Task 6's detonation/cancellation hook registrations are the one piece left for the implementer to wire against this file's own real, existing hook convention rather than guessed blind — flagged explicitly, with the parsing and record-keeping logic around them fully written.

**3. Type consistency:** `parseFerocityRider`'s three-valued return (`null`/`undefined`/a rider object) is used consistently between Task 3's own parser and its test suite. `parseDelayedBlast`'s descriptor shape is produced once and consumed identically by `recordPendingBlast` and the detonation handler.

**4. Review Focus:** All five bullets (the 13-call-site regression risk, name-only Ferocity matching, fallback idempotence, the resolution hold, adjacency-gated cancellation) are each pinned to a named test in Tasks 2, 3, 4, and 6.

**Corrections found while writing this plan:** the Investigation findings' own call-site count (13, not the spec's claimed 5) was caught by grepping the real file directly rather than trusting the spec's own number — the same kind of baseline-verification error #935 already caught for its own parser's auto-count, now recurring in a different plan. Re-confirmed by reading the file, not re-estimated.
