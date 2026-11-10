# Vicious Swing Player Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a human player uses the Vicious Swing feat, automatically make a melee Strike at their target, count it as two attacks for MAP, add the extra weapon die/dice to the damage on a hit, and leave the PF2E Automated Action Tracker charging 2 actions in total.

**Architecture:** A `createChatMessage` handler on the author's own client (same shape as #1278's Defensive Advance handler) rolls the Strike through the system (`strike.variants[i].roll`, `strike.damage`) so the existing `handleManualStrikeDamage` applies damage once. The extra dice are injected by a short-lived Effect item carrying a `DamageDice` rule element gated on a roll option passed to `strike.damage({ options })` — the system's `strike.damage` accepts no dice parameter, only extra roll options. The tracker cost is corrected afterwards through the tracker's own GM-side `editAction` socket call (`socketlib.modules.get("pf2e-auto-action-tracker").executeAsGM("editAction", …)`): the Strike entry gets `cost: 0` and the feat-card entry gets `isMapRelevant: true`, so the log shows 2 actions and 2 MAP-relevant attacks.

**Tech Stack:** Foundry VTT v13 module, ES modules, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-09-vicious-swing-player-automation-design.md`

## Global Constraints

- Vicious Swing costs **2 actions total**; the tracker must end with feat-card entry cost 2 + Strike entry cost 0. (spec Summary, §4)
- The Strike counts as **two attacks**: later attacks that turn use `countMapAttacks` including the card entry. (spec Summary 2)
- Extra dice: **1** at level < 10, **2** at level 10-17, **3** at level 18+. (spec Resolved decision 3)
- Extra dice are part of the Strike's own damage roll (doubled on a crit, one damage message); never a second damage roll. (spec Resolved decision 2)
- Do NOT use `rollAndApplyStrike` / `rollAndApplyStrikeAtVariant` (they apply damage themselves; `handleManualStrikeDamage` would apply it again). (spec Investigation findings)
- Target = the player's single targeted token; melee Strike only; human players only (skip `agentControlled`). (spec Resolved decisions 4-6)
- The tracker is never patched. The only tracker write is the `editAction` socket call described above, scoped to the two message ids this feature caused. (spec §4 option 2)
- A hook handler must never throw: catch, `console.error` with the `pf2e-dungeon-crawl | #1281:` prefix. (spec §5)
- Every merge to `main` bumps `module.json` `version`; never reuse a number (`git fetch origin main`, read `origin/main:module.json`). Run the `update-architecture-docs` skill in the same pass. (CLAUDE.md)
- Work in a git worktree off `origin/main`, copy `.env` in for live testing, `npm ci`, never symlink `node_modules`. (CLAUDE.md)

## Review Focus

- The player targets nothing / several / an ally / a defeated creature: notice, no Strike, no action refund and no tracker edit. (Task 1, Task 2)
- The target is out of reach of every melee Strike: notice, no Strike, no tracker edit. (Task 2)
- The Strike misses or fumbles: no extra dice, effect never created, but the cost fix still applies (the feat was used). (Task 2)
- The damage roll throws or the player cancels: the temporary effect is still deleted (`finally`), and stale ones are swept on turn change. (Task 2)
- The tracker entries are not in the log yet when the fix runs (async GM socket): bounded wait, then give up with a GM whisper "refund 1 action" rather than editing the wrong entry. (Task 2)
- Level 9 / 10 / 17 / 18 boundaries of the dice count, and a weapon with no `damage.die`: dice skipped with a notice, Strike still rolled. (Task 1, Task 2)
- A tracker update adds its own `vicious-swing` library entry: the contract-guard test fails and the module stands down instead of double-correcting. (Task 3)

---

## Precondition (read before Task 1)

This plan reuses #1278's pure helpers and exports. Run `git fetch origin main` then check:

```bash
git show origin/main:scripts/defensive-advance-logic.mjs | head -3
git show origin/main:scripts/dungeon-combat.mjs | grep -n "^export function isModuleCombat\|^export function isMeleeStrikeAction"
```

If `scripts/defensive-advance-logic.mjs` is missing or either function is not exported, #1278 has not landed its Tasks 1-2: **stop and report**; do not re-create them (two copies would collide). Otherwise proceed. Names consumed from it: `TRACKER_NAMESPACE`, `resolveTargetToken`, `validateTarget`, `pickMeleeStrike`, `mapVariantIndex`, `countMapAttacks`, `logHasMessage`, `degreeToOutcome`.

## File Structure

- Create `scripts/vicious-swing-logic.mjs`: pure functions, imports only `defensive-advance-logic.mjs`.
- Create `scripts/vicious-swing.mjs`: Foundry I/O handler + hook registration.
- Modify `scripts/module.mjs`: one import + one `registerViciousSwingHooks()` call.
- Modify `lang/en.json`: notice strings.
- Modify `docs/architecture.md`, `module.json`.
- Create `tests/vicious-swing-logic.test.mjs`, `tests/vicious-swing.test.mjs`, `tests/vicious-swing-tracker-contract.test.mjs`, fixture `tests/fixtures/tracker-library-vicious-swing-absent.json`.

---

### Task 1: Pure decision logic

**Files:**
- Create: `scripts/vicious-swing-logic.mjs`
- Test: `tests/vicious-swing-logic.test.mjs`

**Interfaces:**
- Consumes: nothing beyond `defensive-advance-logic.mjs` (not needed here).
- Produces (named exports):
  - `VICIOUS_SWING_SLUG = "vicious-swing"`, `EXTRA_DICE_OPTION = "vicious-swing:extra-dice"`, `EXTRA_DICE_EFFECT_SLUG = "vicious-swing-extra-dice"`
  - `isViciousSwingMessage(message) → boolean` (feat card: `flags.pf2e.origin.type === "feat"`, roll option `origin:item:slug:vicious-swing`, no `flags.pf2e.context`)
  - `extraDiceCount(level: number) → 1 | 2 | 3`
  - `weaponDieSize(strikeAction) → string | null` (`action.item.system.damage.die`, e.g. `"d8"`, else `null`)
  - `buildExtraDiceEffectData({ count: number, dieSize: string }) → object` (Effect item source data, see Step 3)
  - `costFixUpdates() → { card: { isMapRelevant: true }, strike: { cost: 0 } }`
  - `findStrikeMessageId(messages, { userId, actorId, sinceMs }) → string | null` (newest message authored by `userId`, speaker actor `actorId`, `flags.pf2e.context.type === "attack-roll"`, `timestamp >= sinceMs`)
  - `sweepableEffectIds(items) → string[]` (ids of items whose `slug === EXTRA_DICE_EFFECT_SLUG`)

- [x] **Step 1: Write the failing tests** in `tests/vicious-swing-logic.test.mjs`

```js
// isViciousSwingMessage: accepts the card; rejects another feat, a roll with a context,
//   a non-feat origin, null and {} (mirror the isDefensiveAdvanceMessage tests in tests/defensive-advance-logic.test.mjs).
// extraDiceCount boundaries:
it.each([[1,1],[9,1],[10,2],[17,2],[18,3],[20,3]])("level %i -> %i dice", (l, n) => expect(extraDiceCount(l)).toBe(n));
// extraDiceCount tolerates bad input: expect(extraDiceCount(undefined)).toBe(1)
// weaponDieSize: { item:{ system:{ damage:{ die:"d8" } } } } -> "d8"; die null / missing item -> null
// buildExtraDiceEffectData({ count: 2, dieSize: "d8" }):
//   .type === "effect", .system.slug === EXTRA_DICE_EFFECT_SLUG
//   .system.rules has exactly one rule deep-equal to
//   { key:"DamageDice", selector:"strike-damage", diceNumber:2, dieSize:"d8", predicate:["vicious-swing:extra-dice"] }
//   .system.duration.unit === "unlimited"
// costFixUpdates() deep-equals { card:{ isMapRelevant:true }, strike:{ cost:0 } }
// findStrikeMessageId: picks the NEWEST matching message; ignores other users, other actors,
//   non-attack contexts, and messages older than sinceMs; returns null on empty/undefined input
// sweepableEffectIds: returns only ids of items with that slug; [] for undefined
```

Write each of the above as real `it(...)` blocks with concrete fixture objects (follow the shape used in `tests/defensive-advance-logic.test.mjs`).

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/vicious-swing-logic.test.mjs`
Expected: FAIL — cannot resolve `../scripts/vicious-swing-logic.mjs`.

- [x] **Step 3: Implement the functions above** in `scripts/vicious-swing-logic.mjs`. Zero Foundry globals. `extraDiceCount`: `level >= 18 ? 3 : level >= 10 ? 2 : 1`. The effect's rule must be exactly the one in the test; the rest of the effect source is `{ name: "Vicious Swing (extra dice)", type: "effect", img: "icons/svg/sword.svg", system: { slug, rules: [rule], duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, tokenIcon: { show: false } } }`.

- [x] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/vicious-swing-logic.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/vicious-swing-logic.mjs tests/vicious-swing-logic.test.mjs
git commit -m "#1281: Vicious Swing pure decision logic

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Feat-card handler (Strike, extra dice, cost fix)

**Files:**
- Create: `scripts/vicious-swing.mjs`
- Modify: `lang/en.json`
- Test: `tests/vicious-swing.test.mjs`

**Interfaces:**
- Consumes (Task 1): everything exported there. From `defensive-advance-logic.mjs`: `TRACKER_NAMESPACE`, `resolveTargetToken`, `validateTarget`, `pickMeleeStrike`, `mapVariantIndex`, `logHasMessage`, `degreeToOutcome`. From `dungeon-combat.mjs`: `isModuleCombat`, `isMeleeStrikeAction`, `chebyshevSquares`, `actionReachSquares`. From `force-hostility.mjs`: `areHostile`.
- Produces (named exports of `scripts/vicious-swing.mjs`):
  - `onViciousSwingCard(message, deps = {}) → Promise<void>` — `deps` keys, all defaulted from Foundry globals by `defaultDeps()`: `game`, `notify(key: string)`, `log(...args)`, `sleep(ms)`, `isModuleCombat`, `socketlib`, `now() → ms`
  - `waitForLogEntries(combatant, msgIds: string[], { attempts = 20, intervalMs = 100, sleep }) → Promise<boolean>`
  - `fixTrackerCost({ combatant, cardMsgId, strikeMsgId }, deps) → Promise<boolean>` (waits for both ids in `combatant.flags[TRACKER_NAMESPACE].log`, then two `executeAsGM("editAction", { combatantId, msgId, updates })` calls using `costFixUpdates()`; on timeout or error whispers the GM via `notify("fix-failed")` and returns `false`)
  - `sweepExtraDiceEffects(actor)` — deletes every item matched by `sweepableEffectIds(actor.items)`; never throws.

Handler flow for `onViciousSwingCard` (the order is part of the contract):

1. Return unless `message.author?.isSelf` and `isViciousSwingMessage(message)`; resolve the speaker's combatant; require `isModuleCombat(combat)`, it is the current combatant, not `agentControlled`, not defeated.
2. `resolveTargetToken(game.user.targets)` then `validateTarget` (hostile via `areHostile`); on failure `notify("target-<reason>")` and return **without** touching the tracker.
3. `pickMeleeStrike(actor.system.actions, chebyshevSquares(...), { reachOf: a => actionReachSquares(a, gridFt), isMelee: isMeleeStrikeAction })`; none → `notify("no-strike-in-reach")`, return.
4. `i = mapVariantIndex(trackerLog)` **before** anything is logged for this Strike; unreadable log → `i = 0` and `notify("map-unknown")`.
5. Record `sinceMs = deps.now()`, roll `strike.variants[i].roll({ target: { document: targetToken }, createMessage: true, skipDialog: true })`; capture `degree` from the result; `strikeMsgId = findStrikeMessageId(game.messages.contents, { userId: game.user.id, actorId: actor.id, sinceMs })`.
6. If `degreeToOutcome(degree)` is non-null: create the effect (`actor.createEmbeddedDocuments("Item", [buildExtraDiceEffectData({ count: extraDiceCount(actor.level), dieSize })])`; `dieSize = weaponDieSize(strike)`; null die → `notify("no-weapon-die")` and skip the effect) then in `try`: `strike.damage({ target: {document: targetToken}, outcome, createMessage: true, options: [EXTRA_DICE_OPTION] })` with the damage dialog suppressed exactly as `rollAndApplyStrike` does (`flags.pf2e.settings.showDamageDialogs` toggled off and restored, see `scripts/dungeon-combat.mjs` ~5408-5497); `finally`: delete the effect.
7. `fixTrackerCost({ combatant, cardMsgId: message.id, strikeMsgId }, deps)` — runs for hits **and** misses; skipped only when step 2 or 3 returned early.
8. Whole handler wrapped in `try/catch` → `console.error("pf2e-dungeon-crawl | #1281:", err)`; the `finally` of step 6 still runs.

- [x] **Step 1: Write the failing tests** in `tests/vicious-swing.test.mjs` (fake `deps`, fake `game`; same style as `tests/defensive-advance.test.mjs`)

```js
// early exits (no roll, no tracker call, one notify with the given key each):
//   no target -> "target-none"; two targets -> "target-many"; ally -> "target-not-hostile";
//   defeated -> "target-defeated"; target out of reach -> "no-strike-in-reach"
// ignored entirely (no notify, nothing called): message not authored by self; not the feat card;
//   agentControlled combatant; not the current turn's combatant
// hit: variants[0].roll called once with { target:{document}, skipDialog:true };
//   strike.damage called once with options containing "vicious-swing:extra-dice" and the outcome;
//   the extra-dice effect is created BEFORE damage and deleted AFTER (assert call order);
//   dice count in the created effect = extraDiceCount(actor.level)
// crit: damage outcome "criticalSuccess"
// miss: damage not called, effect never created, fixTrackerCost still invoked
// damage throws: effect still deleted, error logged with the "#1281" prefix, handler resolves
// prior attacks: tracker log with 1 map-relevant entry -> variants[1] is rolled; 3+ -> variants[2]
// unreadable tracker log: variants[0] rolled and notify("map-unknown")
// null weapon die: strike still rolled, no effect created, notify("no-weapon-die")
// fixTrackerCost: waits until both msgIds appear in the log, then executeAsGM("editAction") is called
//   twice: { combatantId, msgId: cardMsgId, updates:{ isMapRelevant:true } } and
//   { combatantId, msgId: strikeMsgId, updates:{ cost:0 } }; never called before both ids are present
// fixTrackerCost timeout (ids never appear): no executeAsGM call, notify("fix-failed"), returns false
// fixTrackerCost with strikeMsgId null: no executeAsGM call, notify("fix-failed")
// sweepExtraDiceEffects: deletes only slug "vicious-swing-extra-dice" items; swallows a delete error
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/vicious-swing.test.mjs`
Expected: FAIL — cannot resolve `../scripts/vicious-swing.mjs`.

- [x] **Step 3: Implement** `scripts/vicious-swing.mjs` per the interfaces and flow above. Add the notice keys to `lang/en.json` under a `PF2E_DUNGEON_CRAWL.ViciousSwing` namespace: `target-none`, `target-many`, `target-not-hostile`, `target-defeated`, `target-not-in-combat`, `target-self`, `no-strike-in-reach`, `map-unknown`, `no-weapon-die`, `fix-failed` (the last one whispers the GM: "Vicious Swing: refund 1 action for <actor> by hand"). `deps.socketlib.modules.get(TRACKER_NAMESPACE)` is the tracker's socket; if it is missing, treat as `fix-failed`.

- [x] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/vicious-swing.test.mjs tests/vicious-swing-logic.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/vicious-swing.mjs lang/en.json tests/vicious-swing.test.mjs
git commit -m "#1281: Vicious Swing handler — Strike, extra dice, tracker cost fix

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Wiring, stale-effect sweep, tracker contract guard, docs, version

**Files:**
- Modify: `scripts/vicious-swing.mjs` (add `registerViciousSwingHooks()`), `scripts/module.mjs`, `docs/architecture.md`, `module.json`
- Create: `tests/vicious-swing-tracker-contract.test.mjs`, `tests/fixtures/tracker-library-vicious-swing-absent.json`

**Interfaces:**
- Consumes (Task 2): `onViciousSwingCard`, `sweepExtraDiceEffects`.
- Produces: `registerViciousSwingHooks() → void` — registers `Hooks.on("createChatMessage", m => onViciousSwingCard(m))`, and `Hooks.on("updateCombat", …)` which, when the turn or round changed, calls `sweepExtraDiceEffects` for the previous combatant's actor (owner's client only, i.e. `actor.isOwner`), and `Hooks.once("ready", …)` sweeping the user's owned character actors. Also exports `trackerHasViciousSwingEntry(moduleData) → boolean` used by the guard: when the installed tracker (`game.modules.get(TRACKER_NAMESPACE)`) version's library contains a `vicious-swing` slug, `onViciousSwingCard` returns immediately (the tracker then handles the feat itself) and logs one console warning.

- [x] **Step 1: Write the failing tests**

  - `tests/vicious-swing-tracker-contract.test.mjs`: loads the pinned fixture (a JSON list of the tracker v0.19.1 library slugs copied from `main.js`, verified to contain `defensive-advance` and `penetrating-shot` and NOT `vicious-swing`) and asserts `trackerHasViciousSwingEntry` is `false` for it and `true` for the same list plus `"vicious-swing"`. Also assert the fixture still has `penetrating-shot` (the `mapIncrease2` precedent the spec leans on).
  - In `tests/vicious-swing.test.mjs`: `registerViciousSwingHooks` registers exactly one `createChatMessage` and one `updateCombat` handler; the `updateCombat` handler sweeps only when `turn` or `round` is in the changes and only for an owned actor.

- [x] **Step 2: Run to verify they fail** — `npx vitest run tests/vicious-swing-tracker-contract.test.mjs tests/vicious-swing.test.mjs` → FAIL (missing exports).

- [x] **Step 3: Implement** the exports and registration; in `scripts/module.mjs` add `import { registerViciousSwingHooks } from "./vicious-swing.mjs";` and call it next to `registerDefensiveAdvanceHooks()`. Bump `module.json` to the next unused patch version (read `origin/main:module.json` first). Run the `update-architecture-docs` skill and commit its `docs/architecture.md` result.

- [x] **Step 4: Run the full suite** — `npm test` → all green (no regressions in `tests/feat-action-coverage.test.mjs`: the AI audit fixture keeps Vicious Swing `notOffered`).

- [x] **Step 5: Commit, PR, automerge**

```bash
git add -A scripts tests docs module.json lang
git commit -m "#1281: wire Vicious Swing hooks, tracker contract guard, docs

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Open the PR with an explicit merge `--subject/--body` that contains **no closing keyword** (the issue needs the live check, CLAUDE.md "Issue status"). After merge: add `verification`, remove `in progress` and `claimed`.

---

### Task 4: Live verification (required before closing #1281)

No code. In a real combat with the player's character (the holder of Vicious Swing) and a hostile in reach, on the deployed module version:

- [ ] **Step 1: Confirm the world loaded the new version** (`game.modules.get("pf2e-dungeon-crawl").version`), per the stale-deploy rule.
- [ ] **Step 2: Hit.** Use the feat with one target. Pass: Strike rolled automatically at MAP 0, damage message includes the extra die/dice (1 at level < 10), applied to the target exactly once, tracker shows 2 actions used and no extra Strike entry cost.
- [ ] **Step 3: Crit.** Pass: extra dice doubled.
- [ ] **Step 4: Miss.** Pass: no extra dice, tracker still 2 actions.
- [ ] **Step 5: Second attack after the swing.** Roll a manual Strike. Pass: the tracker shows MAP 2 (-10 standard, -8 agile).
- [ ] **Step 6: Prior attack the same turn, then the feat.** Pass: the swing rolls at MAP 1.
- [ ] **Step 7: Out-of-reach and no-target cases.** Pass: a notice and no action charged beyond the card's 2, with the GM able to refund by hand as today.
- [ ] **Step 8: No stray effect** named "Vicious Swing (extra dice)" remains on the actor after each case.

Record results on #1281; close it only if all pass. If Step 2 shows the cost fix cannot run (`fix-failed`), record the tracker's actual `editAction` behaviour on the issue and fall back to the GM-whisper refund (spec §4 option 3), keeping the issue open.
