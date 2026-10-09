# NPC Summon and Conjure Abilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AI NPCs a new `npcSummon` vocabulary entry across three shapes (direct creature summons, summon-spell abilities, conjured objects), with PF2e minion-rule command handling, a summon record, and lifetime/reward bookkeeping, so a dullahan can summon and command a war horse, a morrigna can raise spiders, and a triton can summon an aquatic ally.

**Architecture:** A pure parser (`scripts/npc-summon-parse.mjs`) recognizes the three shapes from an NPC action item. A Foundry-touching vocabulary builder and executor in `scripts/dungeon-combat.mjs` reuse the confirmed-real `spawnCreatures` placement helper and combatant-creation pattern `startCombat` already uses, plus a new minion-turn-skip check in the real turn driver (`autoPlayCombatantTurnIfDue`) and the agent-service read surface (`getPendingAgentTurn`). Two real, concrete gaps were found and closed while grounding this plan against the actual spawn/turn code rather than the spec's own description of it: `spawnCreatures`'s own treasure-rolling logic silently contradicts the spec's "summons are worth no loot" decision, and `extraFlags` must be namespaced under the module ID to be readable back.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-npc-summon-abilities-design.md`

## Global Constraints

- PF2e's own summoned/minion trait rules are the source of truth for how a summon acts (CLAUDE.md "Game rules").
- All-or-nothing recognition: a sentence the grammar doesn't explicitly name makes the ability `null`.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **`extraFlags` must be namespaced under the module ID — the spec's own call-shape text is wrong as written.** `spawnCreatures` (`scripts/foundry-api.mjs:964-965`) merges `extraFlags` directly onto `obj.flags` (`foundry.utils.mergeObject(obj.flags ?? {}, extraFlags)`), and every real caller (`scripts/dungeon-scene.mjs:1269,1430`) passes `extraFlags: { [MODULE_ID]: { ... } }`. The spec's own design text calls it as `extraFlags: { summon: record }` — a bare, un-namespaced key that would never be readable back via `token.getFlag("pf2e-dungeon-crawl", "summon")`. Task 2 calls it correctly: `extraFlags: { [MODULE_ID]: { summon: record, minionOf: null } }`.
2. **`spawnCreatures` silently contradicts the spec's own "summons are worth no loot" design decision — found by reading the real function, not trusted from the spec's description of it as a bare placement helper.** For any `disposition < 0` spawn whose traits pass `isTreasureEligible` (`scripts/foundry-api.mjs:914-924`), it unconditionally rolls and grants coins/items via `rollNpcTreasure`/`drawTreasureItem` — logic built for ordinary hostile-encounter spawns, with no flag to opt out. A hostile NPC's summon (Spider Minions, Summon Steed) is itself `disposition < 0`, so this treasure-rolling fires for it too. In practice this stays harmless only because the spec's own lifetime design deletes a slain or combat-ending summon outright rather than converting it to loot (Investigation finding 4 below) — so the granted items never reach `resolveCombat`'s loot-conversion loop. Task 5's executor does not rely on that deletion-timing coincidence: it strips the freshly-spawned summon actor's starting inventory and coins immediately after `spawnCreatures` returns, so a future change to the deletion path can't accidentally surface summon loot.
3. **The real minion-turn-skip seam is `autoPlayCombatantTurnIfDue` (`scripts/dungeon-combat.mjs:4024`), one insertion point, not the vaguer "the module advances past it" the spec describes.** It is the function module.mjs's `updateCombat` hook actually calls on every turn change; a minion check belongs right after the existing `isExcludedFromAutoPlay`/`isDefeated` checks and before `isUnawareHostile`, calling `combat.nextTurn()` and returning. The external agent-service poller's own read surface, `getPendingAgentTurn` (same file, line 4121), independently returns `null` already for any combatant without `agentControlled` set true, but a minion combatant WILL have `agentControlled: true` (it needs that flag to run its own two-action turn when commanded) — so this function also needs an explicit `minionOf` check, confirmed by reading its real condition chain rather than assumed from the flag name alone.
4. **Spider Minions' real text (confirmed live, `pathfinder-monster-core/morrigna.json`) carries one sentence beyond the spec's own quote.** The spec quotes it up through "...any number of summoned spiders in existence at once," but the real text continues: "The morrigna can see through the eyes of any of their summoned spiders at any time." This is a sensory-link clause with no combat-mechanical executor need in this module (nothing here models what the GM-controlled morrigna "sees"). Rather than let this break the ability's own all-or-nothing grammar (which would silently push the spec's own primary cited example into the override table), Task 3 adds an explicit, named trailing-clause recognizer — "`<summoner>` can see through the eyes of `<possessive>` summoned `<creature plural>` at any time" — that is matched and discarded, not swallowed by a loose catch-all.
5. **Summon Steed and Summon Aquatic Ally both match the spec's quoted text exactly** (confirmed live, `dullahan.json`/`triton.json`) — no correction needed for either.

## Review Focus

- A minion combatant must never be polled by the external agent-service as if it had its own turn to decide — `getPendingAgentTurn` returning a non-null decision point for a `minionOf`-flagged combatant would let the service try to act for it outside a `commandMinion` execution, double-driving its actions (Investigation finding 3; Task 1's test).
- A summon's starting inventory must be empty regardless of `spawnCreatures`'s own treasure-rolling behavior, even for a treasure-eligible creature type (a construct-trait exclusion elsewhere does not apply here) — this must be asserted directly on the spawned actor's own items/coins after execution, not inferred from "it will be deleted later" (Investigation finding 2; Task 5's test).
- A summoner defeated mid-combat must have its live, uncommanded minions dismissed in the same turn, per the spec's own stated rule, not left to linger until the next expiry sweep or combat end (spec's own stated rule; Task 6's test).
- `replacePrevious` must delete the summoner's *existing* summon(s) of that same ability before spawning the new one, even when the old one is at a different location or already past its "slain" HP threshold but not yet cleaned up — a stale double-summon surviving a re-cast is the kind of bug that only shows up on a monster's second use of the same ability (spec's own stated rule; Task 5's test).
- A `commandMinion` candidate must not be offered for a minion already commanded this turn, and must disappear once that minion is slain or dismissed mid-turn by some other effect — stale commandability is a real risk given the minion lives in the same combat as its summoner across multiple of the summoner's own candidate-building calls (spec's own stated rule; Task 4's test).

---

### Task 1: Minion turn-skip in the real turn driver

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`autoPlayCombatantTurnIfDue` at line 4024, `getPendingAgentTurn` at line 4121)
- Test: `tests/dungeon-combat.minion-turn-skip.test.mjs` (new)

**Interfaces:**
- Produces: a `minionOf` combatant-flag convention (`flags["pf2e-dungeon-crawl"].minionOf = <summonerCombatantId>`) that Tasks 2/4/5/6 all read and write.

- [ ] **Step 1: Write the failing tests**

```js
describe("minion turn-skip (#983)", () => {
  it("autoPlayCombatantTurnIfDue advances past a minion combatant without running the agent loop or the heuristic", async () => {
    const nextTurn = vi.fn();
    const combat = { combatant: { getFlag: (ns, k) => (k === "minionOf" ? "cb1" : k === "agentControlled" ? true : undefined), isDefeated: false }, nextTurn, scene: {} };
    globalThis.game = { user: { isGM: true } };
    await autoPlayCombatantTurnIfDue(combat);
    expect(nextTurn).toHaveBeenCalledTimes(1);
  });

  it("getPendingAgentTurn returns null for a minion combatant even though agentControlled is true (Review Focus)", async () => {
    const combat = {
      combatant: { getFlag: (ns, k) => (k === "minionOf" ? "cb1" : k === "agentControlled" ? true : undefined), isDefeated: false },
      combatants: [],
    };
    expect(await getPendingAgentTurn(combat)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-combat.minion-turn-skip.test.mjs`
Expected: FAIL (no minion check exists yet; both functions proceed past the current combatant as if it were a normal agent-controlled one)

- [ ] **Step 3: Implement.** In `autoPlayCombatantTurnIfDue`, immediately after the existing `isExcludedFromAutoPlay` check, add: `if (combatant.getFlag(MODULE_ID, "minionOf")) { await combat.nextTurn(); return; }`. In `getPendingAgentTurn`, extend the existing early-return condition to also check `!combatant.getFlag(MODULE_ID, "minionOf")`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-combat.minion-turn-skip.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat.minion-turn-skip.test.mjs
git commit -m "feat(#983): skip a minion combatant's own turn in the real turn driver and agent-poll surface"
```

---

### Task 2: The summon record and combatant creation

**Files:**
- Create: `scripts/npc-summon.mjs` (summon-record helpers and the spawn-plus-combatant-creation sequence)
- Test: `tests/npc-summon.test.mjs` (new)

**Interfaces:**
- Produces: `spawnSummonCreature(entry, { nearActorId, disposition, summonerCombatantId, itemId, kind, expiresAtWorldTime, persistsUntil })` → `{ actorId, tokenId, combatantId }`; `stripSummonLoot(actorId)`.

- [ ] **Step 1: Write the failing tests**

```js
describe("spawnSummonCreature (#983)", () => {
  it("calls spawnCreatures with extraFlags correctly namespaced under the module id (Investigation finding 1)", async () => {
    const spawnCreatures = vi.fn().mockResolvedValue([{ name: "War Horse", actorId: "a1", tokenId: "t1" }]);
    const combat = { createEmbeddedDocuments: vi.fn().mockResolvedValue([{ id: "cb2" }]), scene: { id: "s1" } };
    await spawnSummonCreature({ pack: "pf2e.pathfinder-monster-core", id: "x" }, {
      nearActorId: "summonerA", disposition: -1, summonerCombatantId: "cb1", itemId: "item1", kind: "creature",
      expiresAtWorldTime: null, persistsUntil: "untilSlainDismissedReplaced",
    }, { api: { spawnCreatures }, combat });
    expect(spawnCreatures).toHaveBeenCalledWith([{ pack: "pf2e.pathfinder-monster-core", id: "x" }], expect.objectContaining({
      nearActorId: "summonerA", disposition: -1, place: "beside",
      extraFlags: { "pf2e-dungeon-crawl": expect.objectContaining({ summon: expect.objectContaining({ summonerCombatantId: "cb1", itemId: "item1" }) }) },
    }));
  });

  it("creates the token as a minionOf combatant flagged agentControlled", async () => {
    const createEmbeddedDocuments = vi.fn().mockResolvedValue([{ id: "cb2" }]);
    const spawnCreatures = vi.fn().mockResolvedValue([{ name: "War Horse", actorId: "a1", tokenId: "t1" }]);
    const combat = { createEmbeddedDocuments, scene: { id: "s1" } };
    const result = await spawnSummonCreature({ pack: "p", id: "x" }, { nearActorId: "s", disposition: -1, summonerCombatantId: "cb1", itemId: "item1", kind: "creature" }, { api: { spawnCreatures }, combat });
    expect(createEmbeddedDocuments).toHaveBeenCalledWith("Combatant", [expect.objectContaining({
      tokenId: "t1", sceneId: "s1",
      flags: { "pf2e-dungeon-crawl": expect.objectContaining({ agentControlled: true, minionOf: "cb1" }) },
    })]);
    expect(result).toEqual({ actorId: "a1", tokenId: "t1", combatantId: "cb2" });
  });
});

describe("stripSummonLoot (#983)", () => {
  it("removes every item and zeroes coins on a freshly-spawned summon actor, regardless of its own treasure eligibility (Review Focus)", async () => {
    const deleteEmbeddedDocuments = vi.fn();
    const actor = {
      items: [{ id: "i1" }, { id: "i2" }],
      deleteEmbeddedDocuments,
      inventory: { coins: { cp: 5, gp: 12 } },
      update: vi.fn(),
    };
    globalThis.game = { actors: { get: () => actor } };
    await stripSummonLoot("a1");
    expect(deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["i1", "i2"]);
    expect(actor.update).toHaveBeenCalledWith(expect.objectContaining({ "system.details.wealth.value": 0 }));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-summon.test.mjs`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement**, matching the real `api.spawnCreatures`/`combat.createEmbeddedDocuments("Combatant", ...)` call shapes confirmed in Investigation findings 1 and the real `startCombat` pattern (`scripts/dungeon-combat.mjs:195-204`). `stripSummonLoot` reads the live actor by id, deletes every embedded item, and zeroes its coin purse via the actor's own `inventory.coins`-equivalent write path (confirm the exact PF2e coin-clearing call against the live actor API rather than hand-building a raw update — check `ActorPF2e#inventory`'s own setter surface during implementation).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-summon.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/npc-summon.mjs tests/npc-summon.test.mjs
git commit -m "feat(#983): spawn-and-combatant-create a summon; strip its starting loot defensively"
```

---

### Task 3: Recognition — the three shapes

**Files:**
- Create: `scripts/npc-summon-parse.mjs`
- Test: `tests/npc-summon-parse.test.mjs`

**Interfaces:**
- Produces: `parseSummonAbility(item)` → `null | { shape: "namedCreature"|"summonSpell"|"conjuredObjects", cost, frequency, params }`.

- [ ] **Step 1: Write the failing tests**

```js
describe("namedCreature (#983)", () => {
  it("recognizes Summon Steed (elite adjustment, added traits, replace-previous)", () => {
    const item = makeSummonItem("<p>The dullahan summons a war horse with elite adjustments and the fiend and unholy traits. This steed remains until it is slain, the dullahan Dismisses this effect, or the dullahan Summons a Steed again.</p>");
    const parsed = parseSummonAbility(item);
    expect(parsed).toMatchObject({ shape: "namedCreature", params: { adjustment: "elite", addTraits: ["fiend", "unholy"], duration: { persistsUntil: "untilSlainDismissedReplaced", replacePrevious: true }, maxAlive: 1 } });
  });

  it("recognizes Spider Minions including its real trailing sensory-link clause (Investigation finding 4)", () => {
    const item = makeSummonItem("<p>The morrigna summons a @UUID[Compendium.pf2e.pathfinder-monster-core.Actor.Giant Tarantula] or @UUID[Compendium.pf2e.pathfinder-monster-core.Actor.Spider Swarm]. These spiders have the summoned trait and remain for 10 minutes or until reduced to 0 Hit Points, whichever comes first. The morrigna does not need to Sustain the Spell to direct these summoned creatures, and the morrigna can have any number of summoned spiders in existence at once. The morrigna can see through the eyes of any of their summoned spiders at any time.</p>");
    const parsed = parseSummonAbility(item);
    expect(parsed.shape).toBe("namedCreature");
    expect(parsed.params).toMatchObject({ duration: { seconds: 600 }, maxAlive: null });
    expect(parsed.params.choices.length).toBe(2);
  });

  it("returns null when the sensory-link clause doesn't match the closed phrasing (regression guard against a silent catch-all)", () => {
    const item = makeSummonItem("<p>The thing summons a goblin. This remains for 1 minute. The thing can watch through the goblin's senses whenever it likes.</p>");
    expect(parseSummonAbility(item)).toBeNull();
  });
});

describe("summonSpell (#983)", () => {
  it("recognizes Summon Aquatic Ally with its restriction", () => {
    const item = makeSummonItem("<p><strong>Frequency</strong> once per day</p><hr /><p><strong>Effect</strong> The triton blows into a conch shell, casting a 2nd-rank @UUID[Compendium.pf2e.spells-srd.Item.Summon Animal] spell. The triton can summon only an aquatic creature, such as a dolphin, octopus, ray, sea snake, or electric eel. This creature remains until it is slain, the triton Dismisses it, or the triton summons another ally.</p>");
    const parsed = parseSummonAbility(item);
    expect(parsed).toMatchObject({ shape: "summonSpell", params: { spellSlug: "summon-animal", rank: 2, restriction: "aquatic" } });
  });
});

describe("conjuredObjects (#983)", () => {
  it("recognizes Spirit Blades via the reviewed table", () => {
    const item = makeSummonItem("<p>The bikkhasura summons six blades made out of spiritual energy.</p>", { name: "Spirit Blades" });
    const parsed = parseSummonAbility(item);
    expect(parsed.shape).toBe("conjuredObjects");
    expect(parsed.params.definition.count).toBe(6);
  });

  it("returns null for a conjure ability with no table entry", () => {
    const item = makeSummonItem("<p>The thing summons a cloud of knives.</p>", { name: "Unreviewed Conjure" });
    expect(parseSummonAbility(item)).toBeNull();
  });
});

describe("non-summons (#983)", () => {
  it("returns null for storms, debris, and visions", () => {
    expect(parseSummonAbility(makeSummonItem("<p>The thing summons a storm of debris.</p>"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-summon-parse.test.mjs`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement** the three shapes per the spec's own grammar (Design §Recognition), adding the sensory-link trailing-clause recognizer from Investigation finding 4, plus `SUMMON_SPELL_TABLE` (Summon Animal rank 2 → aquatic/level-capped creatures, built from the spell's own real heightened text — read it during implementation, don't guess the level cap) and `CONJURED_ITEM_DEFINITIONS` (Spirit Blades: a reviewed weapon definition, count 6, dispel DC 42, counteract rank 10, per the spec's own cited numbers) and `NPC_SUMMON_OVERRIDES`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-summon-parse.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/npc-summon-parse.mjs tests/npc-summon-parse.test.mjs
git commit -m "feat(#983): recognize namedCreature, summonSpell, and conjuredObjects summon shapes"
```

---

### Task 4: Vocabulary — `npcSummon`, `commandMinion`, `dismiss`

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (new `buildNpcSummonVocabulary`, alongside the existing `buildNpcSelfVocabulary`/`buildNpcAbilityVocabulary`)
- Test: `tests/dungeon-combat.npc-summon-vocabulary.test.mjs` (new)

- [ ] **Step 1: Write the failing tests**

```js
describe("buildNpcSummonVocabulary (#983)", () => {
  it("offers one namedCreature entry per resolvable choice, dropping an unresolvable one", () => { /* ... */ });
  it("skips a replace-type ability only when maxAlive is reached and it does not replace -- Summon Steed (replaces) is always offered", () => { /* ... */ });
  it("caps and ranks summonSpell entries by creature level then tactical value", () => { /* ... */ });
  it("offers commandMinion once per live, uncommanded minion this turn, and not for one already commanded (Review Focus)", () => { /* ... */ });
  it("drops commandMinion for a minion slain or dismissed mid-turn by another effect (Review Focus)", () => { /* ... */ });
  it("offers dismiss only when the summoner has a live summon of that item and the text names Dismissing", () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-combat.npc-summon-vocabulary.test.mjs`
Expected: FAIL (not implemented yet)

- [ ] **Step 3: Implement**, reusing #934's gating conventions (cost vs actions, frequency, recharge, requirements) and the per-turn cap pattern already shared across `npcSelf`/`npcAbility`. `commandMinion` eligibility is tracked via a per-turn "commanded this turn" set on `turnState`, cleared at the summoner's own next turn start.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-combat.npc-summon-vocabulary.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat.npc-summon-vocabulary.test.mjs
git commit -m "feat(#983): npcSummon vocabulary -- creature/spell/object entries, commandMinion, dismiss"
```

---

### Task 5: Execution

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`applyAgentDecision`, new `npcSummon` and `command` branches)
- Test: `tests/dungeon-combat.npc-summon-execution.test.mjs` (new)

- [ ] **Step 1: Write the failing tests**

```js
describe("npcSummon execution (#983)", () => {
  it("replaces the summoner's existing summon of this item before spawning the new one (Review Focus)", async () => { /* ... */ });
  it("sets the elite/weak adjustment and added traits on the spawned actor", async () => { /* ... */ });
  it("strips the spawned actor's starting loot regardless of its own treasure eligibility (Review Focus, Investigation finding 2)", async () => { /* ... */ });
  it("rolls back (deletes the token and actor, does not spend the action) when no free square is found", async () => { /* ... */ });
  it("casts the chosen summonSpell creature with no spell slot consumed", async () => { /* ... */ });
  it("creates the conjured items from the reviewed definition", async () => { /* ... */ });
});

describe("commandMinion execution (#983)", () => {
  it("runs a two-action turn for the minion via the existing agent decision loop, then returns control to the summoner with one fewer action", async () => { /* ... */ });
  it("excludes npcSummon, cost spells, and equal-or-higher-rank spell candidates from the minion's own candidate set (the summoned-trait restrictions)", async () => { /* ... */ });
  it("marks the minion commanded this turn so it cannot be commanded again", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-combat.npc-summon-execution.test.mjs`
Expected: FAIL (not implemented yet)

- [ ] **Step 3: Implement**, calling `spawnSummonCreature`/`stripSummonLoot` (Task 2) and the spell/object paths per the spec's own Design §Execution; the `commandMinion` branch calls `initAgentTurnState`/`getPendingAgentTurn`/`applyAgentDecision` against the minion's own combatant with a candidate set filtered per the summoned-trait restrictions.

- [ ] **Step 4: Run the tests to verify they pass, then run the full suite**

Run: `npx vitest run`
Expected: PASS, no regressions in the existing turn-driver, `spawnCreatures` callers, or `applyAgentDecision` tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat.npc-summon-execution.test.mjs
git commit -m "feat(#983): execute npcSummon abilities and commandMinion turns"
```

---

### Task 6: Lifetime, cleanup, and rewards

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (expiry sweep at round/turn change, `resolveCombat`'s XP/loot computation, summoner-defeat cascade)
- Test: `tests/dungeon-combat.npc-summon-lifetime.test.mjs` (new)

- [ ] **Step 1: Write the failing tests**

```js
describe("summon lifetime (#983)", () => {
  it("dismisses an expired summon at the start of a round, reading worldTime fresh", async () => { /* ... */ });
  it("removes a slain summon from the combat and scene at end of round with no corpse and no loot", async () => { /* ... */ });
  it("dismisses a defeated summoner's live, uncommanded minions in the same turn (Review Focus)", async () => { /* ... */ });
  it("deletes every remaining summoned token and actor at combat end, before loot conversion, and excludes them from totalCombatXp", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-combat.npc-summon-lifetime.test.mjs`
Expected: FAIL (not implemented yet)

- [ ] **Step 3: Implement**, reading each affected ability's own real text during implementation to confirm the summoner-defeated behavior per the spec's own instruction ("planning confirms against each ability's text") — none of the three first-slice abilities (Summon Steed, Spider Minions, Summon Aquatic Ally) state an exception, so the default dismiss-on-summoner-defeat rule applies to all three; note this explicitly in the task's own code comment rather than leaving it implicit.

- [ ] **Step 4: Run the tests to verify they pass, then run the full suite**

Run: `npx vitest run`
Expected: PASS, including `resolveCombat`'s existing XP/loot tests unchanged for ordinary (non-summoned) hostiles.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat.npc-summon-lifetime.test.mjs
git commit -m "feat(#983): summon expiry, slain/dismiss cleanup, summoner-defeat cascade, XP/loot exclusion"
```

---

### Task 7: Coverage audit and version bump

**Files:**
- Create: `tests/fixtures/npc-summon-audit.json`
- Create: `tests/npc-summon-coverage.test.mjs`
- Modify: `module.json`

- [ ] **Step 1: Generate the real-population fixture**, scanning the real compendium for summon/conjure text across the 21 uses / 16 names the spec's own Investigation findings counted, recording `{creature, ability, shape | notOffered, reason}` and confirming that count for real.
- [ ] **Step 2: Write the ratchet test** (golden-row comparison + monotonic count, #935's pattern).
- [ ] **Step 3: Run the test suite**

Run: `npx vitest run tests/npc-summon-coverage.test.mjs`
Expected: PASS

- [ ] **Step 4: Run the `update-architecture-docs` skill** (two new files, `scripts/npc-summon.mjs` and `scripts/npc-summon-parse.mjs` — confirm their import edges are captured)
- [ ] **Step 5: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/npc-summon-audit.json tests/npc-summon-coverage.test.mjs module.json docs/architecture.md
git commit -m "test(#983): real-population coverage audit for summon abilities; chore: bump version"
```

---

## Self-Review

**1. Spec coverage:** The summon record/combatant creation (Task 2), recognition (Task 3), vocabulary (Task 4), execution (Task 5), lifetime/rewards (Task 6), and the audit/version bump (Task 7) each cover a spec section; Task 1 covers a prerequisite (the minion turn-skip seam) the spec's design depends on but states only informally. Phantom Mount (#1069) and the other explicitly-out-of-scope items are excluded, not silently handled.

**2. Placeholder scan:** No "TBD"/"TODO". Tasks 4-6's test lists are sketched at the spec's own stated granularity (each line names exactly what it asserts) rather than left empty; full mock scaffolding follows the same pattern already established in #934's/#982's plans for this file.

**3. Type consistency:** The summon record shape (`summonerCombatantId`, `itemId`, `kind`, `expiresAtWorldTime`, `persistsUntil`) is produced once in Task 2 and read identically by Tasks 4-6; `minionOf` (Task 1) is read by Tasks 2, 4, 5, and 6 with the same meaning throughout.

**4. Review Focus:** All five bullets (minion never independently polled, loot stripped regardless of eligibility, summoner-defeat cascade, replace-before-respawn, stale commandability) are each pinned to a named test in Tasks 1, 2, 5, and 4.

**Corrections found while writing this plan:** the most consequential is Investigation finding 2 — `spawnCreatures`'s own treasure-rolling logic, read directly rather than assumed from the spec's "placement code" description, would otherwise silently violate this issue's own "no loot" design decision; the fix is a defensive strip rather than touching the shared helper every other spawn caller depends on unchanged. The second is Investigation finding 4 — the spec's own primary cited example (Spider Minions) carries one more real sentence than the spec quotes, the now-familiar pattern from #981/#978/#961/#947/#935, resolved here with an explicit, named trailing-clause recognizer rather than a silent catch-all or dropping the example.
