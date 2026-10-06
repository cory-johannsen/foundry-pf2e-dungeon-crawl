# Stealth Initiative and Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PF2e-faithful Stealth initiative and per-hostile detection at combat start (replaces the withdrawn "surprise round" design): party members Avoiding Notice roll Stealth for initiative, each is compared with every hostile's Perception DC, and hostiles can only target characters they have noticed — otherwise they Seek, or (if unaware) do nothing.

**Architecture:** A pure module (`scripts/stealth-detection.mjs`) owns the rules (states, comparison, alarm rule, Seek outcomes, awareness). `startCombat` (`scripts/dungeon-combat.mjs`) uses it to roll Stealth initiative and store a detection matrix on the Combat document. `combatantTargets` (the existing single targeting choke point) filters by that matrix; a new `seek` candidate and heuristic branch let hostiles Seek; a chat hook breaks stealth when a sneaker attacks. No third-party module, no actor-data mutation.

**Tech Stack:** Vanilla ES modules, Vitest (dependency-injected fake-Foundry tests), PF2e system APIs (`Statistic#roll`, `Combat#setMultipleInitiatives`, condition API).

**Spec:** `docs/superpowers/specs/2026-10-05-combat-surprise-round-design.md` (read it first; it carries the rules text and the named simplifications).

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version`: a real new combat mechanic is a **minor** bump above whatever `origin/main` has at commit time. **No new `relationships` entry** — no third-party dependency.
- If no party combatant is Avoiding Notice, `startCombat` behaves **exactly as today** (same calls, same arguments, same order). Regression-test this.
- `scripts/stealth-detection.mjs` is pure: no Foundry globals, no imports of Foundry-dependent modules.
- Detection state is stored only on the Combat document flag `flags["pf2e-dungeon-crawl"].detection` (`{ [sneakerCombatantId]: { [hostileCombatantId]: "unnoticed"|"undetected"|"hidden"|"observed" } }`); never on actors. Display conditions applied to sneaker actors must be tracked (flag `appliedConditions` on the Combat) and removed when the combat is deleted.
- Detection states and rules are exactly the spec's (observed targetable; hidden/undetected/unnoticed not targetable by hostiles; Seek outcomes: critical success → observed; success → undetected→hidden, hidden→observed; failure → unchanged). Hostiles never sneak.
- Never touch live Foundry in implementer tasks; the controller verifies live.
- Existing behavior of party-controlled/human combatants is untouched; only the hostile side's targeting changes.

## Review Focus

- **No-sneaker combat must be byte-for-byte today's behavior** (same `rollInitiative` call and args, no new flags/conditions, no extra chat).
- **A hostile must never get a strike/spell/area/breath/reactive candidate against a party member that is not `observed` by it** — covered at the shared `combatantTargets` choke point AND defense-in-depth in `applyAgentDecision`'s id lookups (a stale candidate id must not resolve to an unobserved PC).
- **An unaware hostile (all sneakers unnoticed) must end its turn without stalling the combat** — the agent path requires non-empty candidates and has a 45 s fallback, so an empty candidate list must be handled explicitly (no hang, no error).
- **Seek must change state only per the RAW outcomes** and must update the matrix for that (hostile, sneaker) pair only.
- **Conditions applied for display must be removed** on `deleteCombat`, and never stack on repeat; a sneaker that already had the condition from elsewhere must not lose it.
- **A sneaker's own attack must not break stealth for observed pairs or for non-sneakers**, and a hostile's attack must never touch the matrix.

---

### Task 1: Pure rules module `scripts/stealth-detection.mjs`

**Files:**
- Create: `scripts/stealth-detection.mjs`
- Test: `tests/stealth-detection.test.mjs`

**Interfaces (Produces — consumed by Tasks 2–5; keep these exact names/signatures):**
- `export const DETECTION = { UNNOTICED: "unnoticed", UNDETECTED: "undetected", HIDDEN: "hidden", OBSERVED: "observed" }`
- `avoidingNoticeActorIds(actors)` — `actors: [{ id, exploration: [itemId], items: [{ id, slug }] }]` → array of actor ids whose `exploration` includes an item whose `slug === "avoid-notice"`.
- `initialDetection({ sneakers: [{ id, result }], hostiles: [{ id, dc }] })` → matrix `{ [sneakerId]: { [hostileId]: state } }`: `result >= dc` → `unnoticed`, else `observed`; then the **alarm rule**: if any pair is `observed`, every `unnoticed` pair becomes `undetected`.
- `canTargetState(state)` → `true` only for `observed` (undefined/missing state = `true`, i.e. non-sneakers are always targetable).
- `stateFor(matrix, sneakerId, hostileId)` → state or `observed` when absent.
- `afterAttack(matrix, sneakerId)` → new matrix (immutable): that sneaker's `unnoticed`/`undetected` pairs become `hidden`; `observed`/`hidden` unchanged; other sneakers untouched.
- `applySeekOutcome(state, outcome)` → `outcome` in `"criticalSuccess"|"success"|"failure"|"criticalFailure"`; `observed` is returned unchanged for every outcome (only `hidden`/`undetected` are seeked); `unnoticed` unchanged (cannot be sought); crit success: hidden/undetected → observed; success: undetected → hidden, hidden → observed; failure/crit failure: unchanged.
- `hostileAwareness(matrix, hostileId, partyCombatantIds)` → `{ targetable: [ids observed by hostile], seekable: [ids hidden|undetected], unaware: boolean }` where `unaware` is true when there is at least one sneaker in the matrix, none targetable, none seekable (all unnoticed). Party ids not in the matrix are targetable.
- `uniformCondition(matrix, sneakerId)` → `"unnoticed"` if every hostile's state for the sneaker is `unnoticed`; `"undetected"` if every state is `undetected`; `"hidden"` if every state is `hidden`; else `null`.

- [x] **Step 1:** Write failing tests for every function above, covering at least: equal result vs DC is `unnoticed` (meets or exceeds), one below is `observed`; the alarm rule (one observed pair converts unnoticed → undetected, observed stays; all unnoticed stays unnoticed); `afterAttack` immutability and scope; every Seek outcome row incl. observed/unnoticed unchanged; `hostileAwareness` for unaware / seekable / targetable / mixed / no sneakers / unknown party ids; `uniformCondition` uniform vs mixed; `avoidingNoticeActorIds` with and without the item, with the item owned but not selected in `exploration`.
- [x] **Step 2:** Run `npx vitest run tests/stealth-detection.test.mjs`, confirm failures are for the right reason.
- [x] **Step 3:** Implement the module.
- [x] **Step 4:** Run the test file, confirm green.
- [x] **Step 5:** Commit.

### Task 2: Stealth initiative and detection in `startCombat`

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`startCombat`, a new `deleteCombat` cleanup entry point)
- Modify: `scripts/trap-combat.mjs` (export `withDialogsSuppressed`)
- Modify: `scripts/module.mjs` (register the `deleteCombat` hook)
- Modify: `lang/en.json` (chat keys)
- Test: `tests/dungeon-combat-stealth-start.test.mjs` (new)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: Combat flag `detection` and `appliedConditions`; `export async function rollStealthInitiativeAndDetect(combat, combatants, deps)` (dependency-injected: `rollStealth(actor) → {total}`, `setCondition(actor, slug, active)`, `chat(key, data)`); `export async function clearDetection(combat, deps)` for `deleteCombat`.

- [x] **Step 1:** Write failing tests (DI/fake-Foundry style; template `tests/dungeon-combat-agent-turn-line-of-sight.test.mjs`): no sneakers → `startCombat` calls `rollInitiative` exactly as before and sets no detection flag; one sneaker → Stealth rolled for it only, other combatants go through `rollInitiative`, `setMultipleInitiatives` called with `statistic: "stealth"` and the Stealth total, matrix stored per Task 1 against each hostile's `perception.dc.value`, party members not avoiding notice rolled normally; condition `unnoticed`/`undetected` applied only when uniform and recorded in `appliedConditions`; chat lines posted; `clearDetection` removes only recorded conditions and the flags; an actor that already had the condition keeps it.
- [x] **Step 2:** Run, confirm failures.
- [x] **Step 3:** Implement. Order inside `startCombat`: create combatants → split sneakers (using `avoidingNoticeActorIds` over party actors' `system.exploration` and their `items` slugs) → `rollInitiative` for non-sneakers (same args as today) → Stealth rolls for sneakers (`actor.skills.stealth.roll({ createMessage: true })` under `withDialogsSuppressed`; use the returned Roll's `total`) → `combat.setMultipleInitiatives([...])` → compute/store matrix and apply display conditions → `combat.startCombat()` as today. Register `Hooks.on("deleteCombat", …)` calling `clearDetection`.
- [x] **Step 4:** Run affected tests (`dungeon-combat*`, `trap*`, `stealth*`), confirm green.
- [x] **Step 5:** Commit.

### Task 3: Hostile targeting honors detection

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`combatantTargets`, `applyAgentDecision` lookups via one helper)
- Test: `tests/dungeon-combat-stealth-targeting.test.mjs` (new)

**Interfaces:**
- Consumes: Task 1 `canTargetState`/`stateFor`, Task 2's stored matrix.
- Produces: `combatantTargets(combat, combatant)` omits party combatants whose state vs this hostile is not `observed`; a single helper `resolveOpponentForTurn(combat, combatant, id)` used by every branch of `applyAgentDecision` that currently resolves opponents by id from the unfiltered list.

- [ ] **Step 1:** Failing tests: a hostile's `combatantTargets` excludes an unnoticed/undetected/hidden sneaker but includes an observed one and non-sneaker party members; a party combatant's (agent-controlled) targets are unaffected; `getPendingAgentTurn` produces no strike/spell/area/breath/target-count candidate for an unobserved PC (use the line-of-sight test as template); `applyAgentDecision` given a stale candidate id for an unobserved PC does not resolve it (no strike executed); reactive-strike opportunity search does not offer an unobserved PC; physical-blocking helpers (`hostileFootprints`, `otherCombatantFootprints`) still see all tokens.
- [ ] **Step 2:** Run, confirm failures.
- [ ] **Step 3:** Implement the filter and helper (keep physical-blocking uses unfiltered).
- [ ] **Step 4:** Run affected tests (`dungeon-combat*`, `agent-candidates*`), confirm green.
- [ ] **Step 5:** Commit.

### Task 4: Seek and the unaware hostile

**Files:**
- Modify: `scripts/agent-candidates.mjs` (`seek` candidate builder, registered in `buildCandidateList`, cost 1)
- Modify: `scripts/dungeon-combat.mjs` (`getPendingAgentTurn` context, `applyAgentDecision` `seek` branch, `playHeuristicTurn` Seek/unaware branch, shared `performSeek`)
- Test: `tests/dungeon-combat-stealth-seek.test.mjs` (new), extend `tests/agent-candidates.test.mjs`

**Interfaces:**
- Consumes: Task 1 `hostileAwareness`/`applySeekOutcome`, Task 2/3 matrix + filter.
- Produces: `export async function performSeek(combat, hostileCombatant, deps)` → rolls `hostile.actor.perception.roll({ dc: { value: targetStealthDC }, createMessage: true })` (under `withDialogsSuppressed`) against each seekable sneaker's `actor.skills.stealth.dc.value`, updates the matrix per RAW, refreshes display conditions, posts a chat line on a change, returns outcome summary; `seek` candidate `{ id: "seek", type: "seek", cost: 1, summary }` offered only when `hostileAwareness(...).seekable` is non-empty.

- [ ] **Step 1:** Failing tests: `seek` candidate offered iff the hostile has seekable sneakers (and never when it has targetable PCs it prefers? — offered **alongside** attacks only when there is no targetable PC; with targetable PCs present it is not offered); `performSeek` outcome table via injected roll (crit success → observed; success undetected→hidden, hidden→observed; failure unchanged; matrix updated for that pair only); unaware hostile (all unnoticed): agent path with empty candidates ends the turn (`nextTurn`) without calling the agent service and without hanging; heuristic path likewise ends the turn; a hostile that Seeks and finds someone may then act with remaining actions (matrix refreshed before candidate rebuild).
- [ ] **Step 2:** Run, confirm failures.
- [ ] **Step 3:** Implement per spec.
- [ ] **Step 4:** Run affected tests (`dungeon-combat*`, `agent-candidates*`, `stealth*`), confirm green.
- [ ] **Step 5:** Commit.

### Task 5: Breaking stealth

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (stealth-break handler), `scripts/module.mjs` (hook registration)
- Test: `tests/dungeon-combat-stealth-break.test.mjs` (new)

**Interfaces:**
- Consumes: Task 1 `afterAttack`/`uniformCondition`, Task 2's helpers.
- Produces: `export async function handleStealthBreakMessage(message, deps)` registered on `createChatMessage` (GM client only): when a message's PF2e context type is an attack roll (`attack-roll` / `spell-attack-roll`) made by an actor that is a sneaker in the active combat's matrix, apply `afterAttack`, refresh that sneaker's display condition, post a chat line.

- [ ] **Step 1:** Failing tests: a sneaker's attack roll message turns its unnoticed/undetected pairs to hidden and leaves observed pairs and other sneakers untouched; a hostile's attack message and a non-sneaker party attack never alter the matrix; non-attack messages ignored; non-GM client ignored; no active combat ignored; condition refreshed (removed when no longer uniform).
- [ ] **Step 2:** Run, confirm failures.
- [ ] **Step 3:** Implement and register.
- [ ] **Step 4:** Run affected tests, confirm green.
- [ ] **Step 5:** Commit.

### Task 6: Docs, version, full verification

**Files:** `module.json`, `docs/architecture.md` (via the `update-architecture-docs` skill), this plan's checkboxes.

- [ ] **Step 1:** Run the full suite once (`npx vitest run`; known flaky: `tests/dungeon-reseed-sweep.test.mjs` timing, passes alone) and fix anything legitimately broken.
- [ ] **Step 2:** Regenerate the architecture graph (`node tools/generate-architecture-graph.mjs`), replace the mermaid block verbatim, check for new circular imports.
- [ ] **Step 3:** Bump `module.json` minor above `origin/main`; commit.
- [ ] **Step 4 (controller, live):** with one party member set to Avoiding Notice (`system.exploration`), open a combat room's door and confirm: Stealth roll card, detection matrix on the Combat flag, conditions applied, hostiles that did not notice the sneaker do not attack it, Seek cards appear, a sneaker attack reveals it, conditions removed at combat end; and a combat with no sneakers behaves as before.
