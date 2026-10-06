# Stealth initiative and detection at combat start (PF2e rules as written) — design

**Tracks:** [#616](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/616). This document **replaces** the earlier "surprise round via pf2e-avoid-notice" design (same file path), which was withdrawn on 2026-10-05 at the user's direction: *PF2e rules are the source of truth.*

## Why the issue's premise changed

The issue asks for a group Stealth check and, on success, a free round in which hostiles "can neither move nor act". **PF2e has no surprise round.** From the Archives of Nethys (Player Core):

- *Avoid Notice* (exploration activity): "If you're Avoiding Notice at the start of an encounter, you usually roll a Stealth check instead of a Perception check both to determine your initiative and to see if the enemies notice you (based on their Perception DCs, as normal for Sneak, regardless of their initiative check results)."
- *Initiative with Stealth* (GM Core): anyone Avoiding Notice rolls Stealth for initiative; "They're undetected and unnoticed by anyone whose DC they meet or exceed." Nobody loses actions; the advantage is that enemies must spend their own actions locating hidden opponents.
- *Detecting Creatures*: **hidden** — you know the space but little else; targeting requires a DC 11 flat check, and you remain off-guard to it. **Undetected** — you don't know the space, you're off-guard to it, can't easily target it. **Unnoticed** — you have no idea the creature is even present. **Observed** — targetable normally.
- *Seek*: one secret Perception check against the Stealth DC of undetected or hidden creatures. Critical success: those creatures become observed. Success: undetected becomes hidden; hidden becomes observed.

So the faithful feature is **Stealth-based initiative plus per-hostile detection**, not a skipped round. The "hostiles can't act" rule is dropped. No third-party module is needed and none is added.

## Behavior

### Who sneaks
Only party characters who are **Avoiding Notice** — the real PF2e exploration activity, i.e. their `system.exploration` contains an owned item with slug `avoid-notice` — roll Stealth for initiative. Everyone else rolls initiative exactly as today. If nobody avoids notice, combat start is **unchanged** (this is the default for existing play).

### Combat start (in `startCombat`)
1. Sneakers roll Stealth (standard PF2e skill roll, chat card, dialogs suppressed). Their result is their initiative (`Combat#setMultipleInitiatives` with `statistic: "stealth"`, the system's own API) and is compared with every hostile's Perception DC (`actor.perception.dc.value`).
2. Non-sneakers roll initiative through the normal `rollInitiative` call.
3. Per (sneaker, hostile) pair: result ≥ the hostile's Perception DC → **unnoticed**; otherwise **observed**.
4. *Alarm rule* (the AoN "undetected, but not unnoticed" case): if at least one hostile observes at least one party member, the combat begins with the foes aware that intruders are about, so every pair still **unnoticed** becomes **undetected**. If no hostile observes anyone, pairs stay **unnoticed**.
5. The matrix is stored on the Combat document: `flags["pf2e-dungeon-crawl"].detection = { [sneakerCombatantId]: { [hostileCombatantId]: state } }`.
6. For display, a sneaker's actor receives the PF2e condition `unnoticed` (or `undetected`) when **every** hostile's state for it is that, via the standard condition API; this module removes the conditions it applied when the combat ends.

### Hostile turns
- A hostile may **target** only party members that are **observed** by it (extends the existing `combatantTargets` choke point, so strike/spell/area/breath candidates, the heuristic, reactive strikes and the agent-service `opponents` list all inherit it).
- A hostile with no observed target but at least one undetected or hidden sneaker **Seeks**: a Perception roll against that sneaker's Stealth DC with the RAW outcomes above (new `seek` candidate for the agent path, a Seek branch for the heuristic path). Each Seek costs one action; the hostile keeps seeking until it runs out of actions or finds someone.
- A hostile whose every sneaker is **unnoticed** is unaware: it takes no offensive action and ends its turn.
- Hostiles never sneak (out of scope).

### Breaking stealth
When a sneaker makes an attack roll or casts a spell with a hostile effect, its position is revealed: every hostile for which it was unnoticed or undetected becomes **hidden** for it (observed pairs are unchanged), and its actor condition is refreshed. **Ruling (flagged):** the AoN text I could retrieve does not state the post-attack state; "hidden" (position known, nothing more) is the most conservative reading, and a hostile Seek then upgrades it to observed.

## Known, deliberate simplifications (named, not hidden)
1. **Targeting a hidden creature** is allowed in PF2e with a DC 11 flat check; here hostiles must Seek first (hidden is not targetable). Implementing the flat check would touch every strike/spell execution path.
2. **Off-guard** consequences for observers of undetected/hidden attackers are not applied to hostiles' defenses (the system's own automation for that needs per-observer visibility data it does not have).
3. **Hostiles never sneak**, and no GM override UI exists.
4. A party member's detection is rolled once at combat start per RAW; passive re-noticing later in the encounter is only via Seek or the sneaker's own loud actions.

## Components
- `scripts/stealth-detection.mjs` (new, pure, no Foundry globals): state constants, `avoidingNoticeActorIds`, `initialDetection`, `canTargetState`, `afterAttack`, `applySeekOutcome`, `hostileAwareness`, `uniformCondition`.
- `scripts/dungeon-combat.mjs`: Stealth initiative + detection in `startCombat`; `combatantTargets` filter and a helper reused by `applyAgentDecision`'s target lookups; `seek` candidate/branch; heuristic Seek/unaware branch; stealth-breaking chat hook; condition cleanup on `deleteCombat`.
- `scripts/agent-candidates.mjs`: `seek` candidate builder (cost 1) registered in `buildCandidateList`.
- `scripts/trap-combat.mjs`: export `withDialogsSuppressed` for reuse.
- `lang/en.json`: chat lines (sneak result, noticed, seeks, finds), nothing else.
- `module.json`: version only (no new dependency).

## What does NOT change
Initiative for non-sneakers, the trap engine, the agent service itself (it only sees fewer `opponents`/`candidates`; candidate ids stay opaque), party-turn handling, and `data/`.

## Testing
Pure module: exhaustive unit tests. `startCombat`/targeting/Seek: dependency-injected unit tests in the established fake-Foundry style (`tests/dungeon-combat-agent-turn-line-of-sight.test.mjs` is the template). Live verification (controller): a combat room with one party member set to Avoid Notice.
