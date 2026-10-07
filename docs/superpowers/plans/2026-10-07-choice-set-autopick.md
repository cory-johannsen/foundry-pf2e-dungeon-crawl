# ChoiceSet Auto-Pick For Generated Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #897 — an item or creature drawn/spawned by this module can carry a PF2e `ChoiceSet` rule element whose choice is never resolved, leaving `flags.pf2e.rulesSelections` empty for a value PF2e's own system expects to be set.

**Premise correction (confirmed by direct, live investigation this session, re-confirmed with the owner before proceeding):** The issue's own named example — Spellstrike Ammunition — does not actually exhibit this. Checked live: "Spellstrike Ammunition (Type I)" in `pf2e.equipment-srd` has an empty `system.rules` array; its own "choice" (which spell to hold) happens entirely through normal spellcasting during use ("Activate 2, Cast a Spell"), never a creation-time prompt. The *general* concern is real, though: a live search found **27 real items in `pf2e.equipment-srd` with an actual `ChoiceSet` rule element** (e.g. "Charm of Resistance" — choose a damage type from a fixed list), any of which could be drawn from a treasure table. The owner's own recollection, checked this session, points to the real generation-time risk being **hazard/creature spawning** (`spawnCreatures`), not treasure — a live search of `pf2e.pathfinder-monster-core`/`pathfinder-monster-core-2`/`lost-omens-bestiary`/`hazards` found no actor with an embedded-item `ChoiceSet` today, but `spawnCreatures` is the one call path shared by both combat-encounter NPCs and traps, and is the actual generation-time document-creation call (unlike the treasure path, confirmed below to fire only in play, not at generation).

**Confirmed timing (direct code reading, important for not overstating what this fixes):** `drawTreasureItem`'s own result only ever becomes a real item via `grantTreasureReward` (`scripts/ui/dungeon-app.mjs:315-355`), called from `claimTreasureFor` (a player claiming a treasure room) or `applyRoomEffect("treasure", ...)` (a room's own outcome resolving) — both **in-play, resolution-time** triggers, not generation. `spawnCreatures` (`scripts/foundry-api.mjs`, its own `Actor.createDocuments([...])` call) **does** run during the eager generation pass, for both combat encounters and `populateSlotTrap`'s own hazard spawning (confirmed current, `scripts/dungeon-scene.mjs:1392`). This plan fixes both call paths — the confirmed-real treasure-item risk and the generation-time creature/hazard path the owner's own recollection points to — rather than only the one the issue's own (incorrect) example suggested.

**Architecture:** One small, pure module (`scripts/choice-set.mjs`) resolves every `ChoiceSet` rule element on a plain item-data object, or on every embedded item of a plain actor-data object, by picking uniformly at random from that rule's own `choices` list (never inventing an option outside what the rule element already allows — the issue's own "per the PF2e-rules rule" requirement, satisfied by construction since the picked value always comes from the rule's own `choices` array) and writing it to `flags.pf2e.rulesSelections[flag]` — the same field PF2e's own system already reads, confirmed live (`doc.flags.pf2e.rulesSelections`, present as an object on every real item/actor checked this session). Wired into the two real call sites: `grantTreasureReward` (treasure items) and `spawnCreatures` (NPCs and hazards).

**Tech Stack:** Vanilla ES modules, Vitest, Foundry VTT / PF2e system data shapes.

**Spec:** None — bounded; both real call sites and the real `ChoiceSet`/`rulesSelections` data shape are confirmed live this session.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A real bug fix touching generation-time item/actor creation: patch bump.
- The picked value for a `ChoiceSet` always comes from that rule element's own `choices` array — never a hardcoded guess, never an option the item's own data doesn't already list (the issue's own "only offer options the item's rules allow" requirement).
- An **already-resolved** `rulesSelections[flag]` (if the drawn document somehow already has one set, e.g. a hand-authored compendium entry with a baked-in default) is never overwritten — this is a fill-in-the-gap, not a forced re-roll.
- Matches this module's own existing convention for treasure-adjacent randomness: `treasureRoomItemTableName`/`rollNpcTreasure` both already use plain, unseeded `Math.random` (confirmed current), not the seeded `splitmix32` convention used for deterministic dungeon-layout generation — this plan's own `rng` default matches that (unseeded, but injectable for tests), per the issue's own "seeded or at least random" wording (a lower bar than seeding here).
- Both real call sites (`grantTreasureReward`, `spawnCreatures`) use the exact same shared resolver — never two independent re-implementations of the same ChoiceSet-scanning logic.

## Review Focus

- **A treasure item with a real `ChoiceSet` (e.g. the "Charm of Resistance" shape confirmed live: `{key: "ChoiceSet", flag, choices: [{label, value}, ...]}`) must have its own `flags.pf2e.rulesSelections[flag]` set to one of its own listed `choices` before `createEmbeddedDocuments` ever runs** — the confirmed-real risk this session's own live search found.
- **A spawned creature/hazard whose own embedded item carries a `ChoiceSet` must have the same resolution applied to that embedded item**, not just the top-level actor document — the generation-time path the owner's own recollection points to.
- **An item/actor with no `ChoiceSet` at all must be completely unaffected** — `createEmbeddedDocuments`/`Actor.createDocuments` must receive byte-identical data to today for the overwhelming common case.
- **An already-resolved `rulesSelections[flag]` must never be overwritten** — a regression test for this specific edge case, not just the fill-in-the-gap happy path.
- **The picked value is always a member of that `ChoiceSet`'s own `choices` list** — never an invented string, confirmed by a test that checks membership, not just that *some* value got set.

---

### Task 1: The shared ChoiceSet resolver

**Files:**
- Create: `scripts/choice-set.mjs`
- Test: `tests/choice-set.test.mjs`

**Interfaces:**
- Produces: `resolveChoiceSetsOnItemData(itemData, rng = Math.random): itemData` (new object, `itemData` itself untouched); `resolveChoiceSetsOnActorData(actorData, rng = Math.random): actorData` (same, mapping over `actorData.items`).

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from "vitest";
import { resolveChoiceSetsOnItemData, resolveChoiceSetsOnActorData } from "../scripts/choice-set.mjs";

// The real shape confirmed live this session against pf2e.equipment-srd's
// own "Charm of Resistance".
function itemWithChoiceSet(extra = {}) {
  return {
    name: "Charm of Resistance",
    system: {
      rules: [
        {
          key: "ChoiceSet",
          flag: "damageType",
          prompt: "PF2E.SpecificRule.Prompt.DamageType",
          choices: [
            { label: "PF2E.TraitAcid", value: "acid" },
            { label: "PF2E.TraitCold", value: "cold" },
            { label: "PF2E.TraitElectricity", value: "electricity" },
            { label: "PF2E.TraitFire", value: "fire" },
            { label: "PF2E.TraitSonic", value: "sonic" },
          ],
        },
      ],
    },
    flags: { pf2e: { rulesSelections: {}, ...extra } },
  };
}

describe("#897 resolveChoiceSetsOnItemData", () => {
  it("picks one of the rule's own listed choices and writes it to rulesSelections", () => {
    const resolved = resolveChoiceSetsOnItemData(itemWithChoiceSet(), () => 0);
    expect(resolved.flags.pf2e.rulesSelections.damageType).toBe("acid");
  });

  it("the picked value is always a member of the rule's own choices, across the full rng range", () => {
    const valid = new Set(["acid", "cold", "electricity", "fire", "sonic"]);
    for (const r of [0, 0.2, 0.4, 0.6, 0.8, 0.999]) {
      const resolved = resolveChoiceSetsOnItemData(itemWithChoiceSet(), () => r);
      expect(valid.has(resolved.flags.pf2e.rulesSelections.damageType)).toBe(true);
    }
  });

  it("never overwrites an already-resolved selection", () => {
    const resolved = resolveChoiceSetsOnItemData(
      itemWithChoiceSet({ rulesSelections: { damageType: "fire" } }),
      () => 0,
    );
    expect(resolved.flags.pf2e.rulesSelections.damageType).toBe("fire");
  });

  it("leaves an item with no ChoiceSet completely unchanged", () => {
    const plain = { name: "Longsword", system: { rules: [] }, flags: {} };
    expect(resolveChoiceSetsOnItemData(plain)).toEqual(plain);
  });

  it("leaves an item with no system.rules at all unchanged (not every item has one)", () => {
    const plain = { name: "Longsword" };
    expect(resolveChoiceSetsOnItemData(plain)).toEqual(plain);
  });
});

describe("#897 resolveChoiceSetsOnActorData", () => {
  it("resolves ChoiceSets on every embedded item, not just the actor's own top-level rules", () => {
    const actorData = { name: "Test NPC", items: [itemWithChoiceSet(), { name: "Fists", system: { rules: [] } }] };
    const resolved = resolveChoiceSetsOnActorData(actorData, () => 0);
    expect(resolved.items[0].flags.pf2e.rulesSelections.damageType).toBe("acid");
    expect(resolved.items[1]).toEqual(actorData.items[1]);
  });

  it("leaves an actor with no items array unchanged", () => {
    const actorData = { name: "Test NPC" };
    expect(resolveChoiceSetsOnActorData(actorData)).toEqual(actorData);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/choice-set.test.mjs`
Expected: FAIL — `scripts/choice-set.mjs` does not exist yet.

- [ ] **Step 3: Write `scripts/choice-set.mjs`**

```js
/**
 * #897: a PF2e `ChoiceSet` rule element (e.g. "Charm of Resistance" --
 * choose a damage type) left unresolved leaves `flags.pf2e.rulesSelections`
 * empty for a value PF2e's own system expects to be set once the item
 * exists. This module pre-resolves every such choice, picking uniformly
 * from the rule's own listed `choices` -- never an invented option, per
 * PF2e rules -- before the item/actor is ever actually created, so no
 * generation- or grant-time document write ever leaves one unresolved.
 * Pure: no Foundry globals, plain data in and out.
 */

function resolveChoiceSetsOnItemData(itemData, rng = Math.random) {
  const rules = itemData.system?.rules;
  if (!Array.isArray(rules) || !rules.length) return itemData;
  const choiceSets = rules.filter(
    (r) => r.key === "ChoiceSet" && typeof r.flag === "string" && Array.isArray(r.choices) && r.choices.length,
  );
  if (!choiceSets.length) return itemData;

  const rulesSelections = { ...(itemData.flags?.pf2e?.rulesSelections ?? {}) };
  let changed = false;
  for (const cs of choiceSets) {
    if (rulesSelections[cs.flag] !== undefined) continue; // already resolved -- never override
    const pick = cs.choices[Math.min(Math.floor(rng() * cs.choices.length), cs.choices.length - 1)];
    rulesSelections[cs.flag] = pick.value;
    changed = true;
  }
  if (!changed) return itemData;
  return {
    ...itemData,
    flags: { ...itemData.flags, pf2e: { ...itemData.flags?.pf2e, rulesSelections } },
  };
}

/** Same resolution, applied to every one of `actorData.items` -- a spawned
 * NPC/hazard's own embedded items, not the actor document's own top-level
 * rules (an Actor document has no `system.rules` of its own in PF2e). */
export function resolveChoiceSetsOnActorData(actorData, rng = Math.random) {
  if (!Array.isArray(actorData.items) || !actorData.items.length) return actorData;
  return { ...actorData, items: actorData.items.map((item) => resolveChoiceSetsOnItemData(item, rng)) };
}

export { resolveChoiceSetsOnItemData };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/choice-set.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/choice-set.mjs tests/choice-set.test.mjs
git commit -m "feat(#897): pure resolver pre-picking a ChoiceSet's own listed choice

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire into `grantTreasureReward` (the confirmed real treasure-item risk)

**Files:**
- Modify: `scripts/ui/dungeon-app.mjs`
- Test: `tests/dungeon-app-treasure-chat.test.mjs`

- [ ] **Step 1: Write the failing test**

Add to the existing `describe("grantTreasureReward (#88 chat log fix)", ...)` block (confirmed current, follow its own exact fixture style — `itemDoc.toObject()`, `installFoundryStubs`, `created` capture — all confirmed current in this file):

```js
it("#897: a drawn item's own ChoiceSet is pre-resolved before it's created", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0.1);
  const params = { partyLevel: 5, rank: 2, maxRank: 7, isGoal: false };
  const expectedTableName = treasureRoomItemTableName({ ...params, rng: Math.random });
  const itemDoc = {
    name: "Charm of Resistance",
    toObject: () => ({
      name: "Charm of Resistance",
      system: {
        rules: [{
          key: "ChoiceSet", flag: "damageType",
          choices: [{ label: "Acid", value: "acid" }, { label: "Fire", value: "fire" }],
        }],
      },
      flags: { pf2e: { rulesSelections: {} } },
    }),
  };
  installFoundryStubs({ tableEntry: { tableName: expectedTableName }, itemDoc });
  const created = [];
  globalThis.game.actors = {
    party: { id: "party1", createEmbeddedDocuments: async (type, docs) => { created.push(...docs); } },
  };
  await grantTreasureReward({ addCoins: async () => {} }, params);
  Math.random.mockRestore();
  expect(created).toHaveLength(1);
  expect(["acid", "fire"]).toContain(created[0].flags.pf2e.rulesSelections.damageType);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/dungeon-app-treasure-chat.test.mjs`
Expected: FAIL — `created[0]` has no `rulesSelections` set today.

- [ ] **Step 3: Wire the resolver**

Change (confirmed current, `scripts/ui/dungeon-app.mjs:344-348`):

```js
  const itemDoc = await drawTreasureItem(tableName);
  if (itemDoc) {
    await game.actors.party.createEmbeddedDocuments("Item", [
      itemDoc.toObject(),
    ]);
```

to:

```js
  const itemDoc = await drawTreasureItem(tableName);
  if (itemDoc) {
    // #897: pre-resolve any ChoiceSet (e.g. "Charm of Resistance" -- choose
    // a damage type) before creating the item -- confirmed live this
    // session that 27 real pf2e.equipment-srd items carry one, and this
    // module's own treasure draw has no GM present to answer a prompt.
    await game.actors.party.createEmbeddedDocuments("Item", [
      resolveChoiceSetsOnItemData(itemDoc.toObject()),
    ]);
```

Add the import: `import { resolveChoiceSetsOnItemData } from "../choice-set.mjs";`

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/dungeon-app-treasure-chat.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/ui/dungeon-app.mjs tests/dungeon-app-treasure-chat.test.mjs
git commit -m "fix(#897): pre-resolve a drawn treasure item's own ChoiceSet before creating it

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire into `spawnCreatures` (the generation-time path)

**Files:**
- Modify: `scripts/foundry-api.mjs`
- Test: whichever existing test file already covers `spawnCreatures`'s own `Actor.createDocuments` call (`grep -rln "spawnCreatures" tests/` — confirm the exact fixture before writing).

- [ ] **Step 1: Write the failing test**

```js
it("#897: a spawned creature's own embedded item ChoiceSet is pre-resolved before Actor.createDocuments", async () => {
  // Reuse this file's own existing spawnCreatures fixture (the compendium
  // doc mock, Actor.createDocuments capture) -- give the mocked doc one
  // embedded item carrying a ChoiceSet (same shape as Task 1/2's own
  // fixtures), spawn it, and assert the captured actorData's own item has
  // rulesSelections set.
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run <the test file found in Step 1>`
Expected: FAIL.

- [ ] **Step 3: Wire the resolver**

Change (confirmed current, `scripts/foundry-api.mjs:901-903`):

```js
        const [actor] = await Actor.createDocuments([
          foundry.utils.mergeObject(doc.toObject(), overrides),
        ]);
```

to:

```js
        // #897: pre-resolve any ChoiceSet on a spawned NPC/hazard's own
        // embedded items (feats, equipment) before creation -- the one
        // generation-time document-creation path shared by combat
        // encounters and populateSlotTrap's own hazard spawning.
        const [actor] = await Actor.createDocuments([
          resolveChoiceSetsOnActorData(foundry.utils.mergeObject(doc.toObject(), overrides)),
        ]);
```

Add the import: `import { resolveChoiceSetsOnActorData } from "./choice-set.mjs";`

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run <the test file found in Step 1>`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/foundry-api.mjs tests/
git commit -m "fix(#897): pre-resolve a spawned creature's own embedded-item ChoiceSets before creation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Live verification

- [ ] **Step 1: Verify the treasure path**

Generate a dungeon, claim a treasure room repeatedly (or force the table draw) until a `ChoiceSet`-bearing item is drawn (e.g. a Charm), and confirm it's created on the party actor fully configured (its own sheet shows the pre-picked option, not a "needs configuration" prompt).

- [ ] **Step 2: Verify the generation path**

Generate several dungeons with combat rooms and traps, confirming no GM prompt ever blocks generation — this is the real-world check the issue itself asks for ("verify live that generation completes with no GM prompt").

- [ ] **Step 3: Report findings on the issue**

---

### Task 5: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Re-check the current version and bump**

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **patch** bump, using whatever the fetch above shows as current.

- [ ] **Step 2: Commit**

```bash
git add module.json
git commit -m "chore(#897): bump version for ChoiceSet auto-pick

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #897's own ask (choice prompts never block generation, the pick is random and seeded-or-better, the same path handles all choice-requiring items) is covered for both real call paths this session identified: the confirmed treasure-item risk (27 real items) and the generation-time creature/hazard path the owner's own recollection pointed to — rather than only the issue's own named (and factually incorrect) Spellstrike example.

**2. Placeholder scan:** No TBD. Every claim (the real `ChoiceSet`/`rulesSelections` shape, the 27-item count, the confirmed in-play-not-generation timing of the treasure path, the empty creature/hazard search) was verified live this session, and the premise correction is stated plainly rather than silently worked around.

**3. Type consistency:** `resolveChoiceSetsOnItemData`/`resolveChoiceSetsOnActorData`'s own shapes (`(data, rng) => data`) are identical at both of their real call sites, each just passing through whatever `rng` default (`Math.random`) the existing surrounding code already uses.

**4. Review Focus:** All five items (a real treasure ChoiceSet resolved, a spawned creature's embedded-item ChoiceSet resolved, a plain item/actor unaffected, an already-resolved selection never overwritten, the picked value always a real listed choice) each map to a specific test. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-07-choice-set-autopick.md`.
