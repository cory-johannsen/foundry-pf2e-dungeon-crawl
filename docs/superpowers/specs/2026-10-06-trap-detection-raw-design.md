# Trap detection per PF2e rules as written — design

**Tracks:** [#755](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/755). Replaces the earlier "document the simplification" resolution (plan PR #795), withdrawn on 2026-10-06 at the user's direction (*PF2e rules are the source of truth*). Its stated reason — "no per-character exploration-activity system exists" — stopped being true when #616 (PR #819) started reading PF2e's own `system.exploration` slot.

## What the rules say (Archives of Nethys: Hazards, Search, Detecting Creatures)

- Characters **automatically receive a check** to detect a hazard unless it lists a minimum proficiency rank. The check is determined **when the party first enters the general area** where the hazard appears — once, not on every step.
- A hazard whose Stealth entry lists a **minimum proficiency** (`Stealth DC 23 (trained)`) is checked **only if someone is actively Searching** (the *Search* exploration activity; the *Seek* action in an encounter) **and** has that Perception rank or higher. Anyone else gets no check at all.
- **Search**: "If you come across a secret door, item, or hazard while Searching, the GM will attempt a free secret check to Seek." The check is **secret**; it covers an area of about 30 feet.
- The check is a Perception check against the hazard's **Stealth DC** (simple hazards; for complex hazards the listed Stealth modifier is the basis).

## What the module does today (and why it deviates)

`handleTrapTokenMove` (`scripts/trap-combat.mjs`): every position change of a party token that ends **adjacent** to an undetected hazard makes that mover roll a **public** Perception check vs `10 + stealth` — on every step, for every character, until someone succeeds. It ignores Search, ignores minimum proficiency (**45 of the 53 `pf2e.hazards` entries list one**: 20 trained, 18 expert, 5 master, 2 legendary), re-rolls, and shows the roll card (with the result) to players.

## Behavior (the redesign)

1. **When a character rolls.** Once per (character, hazard): the first time that character's token is within **30 ft (6 squares, `scene.grid.distance` aware)** of the hazard while the party is **exploring** (no active module combat). The "already rolled" memory is a flag on the hazard actor (`trapDetectionRolls: [actorId…]`), written by the GM client.
2. **Who is eligible.**
   - Hazard with **no minimum proficiency**: every party character (the automatic check).
   - Hazard **with a minimum proficiency**: only a character who (a) has the *Search* exploration activity selected (an owned item with slug `search` listed in `actor.system.exploration`) **and** (b) has `actor.perception.rank >= minRank` (ranks: untrained 0, trained 1, expert 2, master 3, legendary 4).
   - A character who is not eligible when first in range **does not consume** the roll: if they later become eligible (select Search) and are in range again, they roll.
3. **The roll.** A normal PF2e Perception check (`actor.perception.roll`, dialogs suppressed) against `trapDetectionDC` (`10 + system.attributes.stealth.value`), **made secret**: no public roll card. A line is whispered to GMs for every roll (character, result vs DC, outcome); a **public** chat line is posted **only on success** ("X notices a hidden trap: Y!"). A failure is silent to players.
4. **Result.** Success or critical success sets `trapDetected` and unhides the token for everyone (one success reveals the trap to the party), exactly as today.
5. **Unchanged:** the walk-over **trigger** (overlap), the click-to-disable flow, hidden-until-detected visibility, `classifyTrapMove`.
6. **Out of scope (named):** the *Seek* action during encounters (combat is automated and has no Seek action for PCs; detection rolls are skipped while a module combat is active), XP for overcoming hazards (separate issue), and complex-hazard initiative-Stealth nuances (the existing `10 + modifier` basis is kept).

## Components
- `scripts/trap-mechanics.mjs` (pure, existing): `trapMinProficiencyRank(stealthDetailsHtml)` (parses `<p>(trained)</p>` etc.; no rank listed → `null`; unparseable/odd text such as `@Check[...]` or `(or 0 if …)` → `null`), `detectionEligibility({ minRank, searching, perceptionRank })`, `withinSearchRange(trapFootprint, moverFootprint, rangeSquares)` (Chebyshev distance between footprints).
- `scripts/trap-combat.mjs`: `rollTrapDetection` becomes a secret roll returning `{ detected, dc, outcome, total }`; `handleTrapTokenMove`'s detect branch is replaced by the range/eligibility/once-per-character logic; GM-whisper + success-only public lines; skip while a module combat is active.
- `scripts/placement.mjs` or `trap-mechanics.mjs`: reuse existing `footprint` helpers (no new geometry module).
- `lang/en.json`: GM roll line key; the existing `DetectedChat` stays the public success line.
- Docs: replace the old documentation-only plan; update the doc comments of the changed functions to state the RAW rule and the named simplifications.

## Testing
Pure functions exhaustively (including every odd `details` string observed in the compendium: `<p>(trained)</p>`, `<p>(expert)</p>`, empty, `@Check[stealth|dc:23]`, `(or 0 if the trapdoor is disabled or broken)`, `or <em>detect magic</em>`). Handler logic with the existing dependency-injected style (`tests/trap-token-move.test.mjs`). Live verification by the controller with a party member holding/not holding Search and with a min-proficiency hazard.
