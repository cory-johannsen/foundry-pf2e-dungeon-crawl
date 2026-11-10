# Players: Vicious Swing Automation, Extra Weapon Dice, and Correct Action Cost

**Issue:** #1281 — a player using **Vicious Swing** is charged 2 actions for the feat card, no Strike is made, the manual Strike is charged again, and the extra weapon die/dice are never rolled.

**Builds on:** #1278 / `docs/superpowers/specs/2026-11-09-defensive-advance-player-automation-design.md` (the same human-player feat pattern: detect the card on the author's client, roll through the system so the existing hooks apply damage), #1094 (tracker integration), #47 / `handleManualStrikeDamage`, #947 (AI path classifies Vicious Swing `notOffered`, "unmodeled rider text").

**Status:** Approved in design. Scope was decided with the owner on 2026-11-09 (see "Resolved decisions"). The extra-die rider is **mandatory** (a player in the owner's game has the feat).

## Summary

Vicious Swing (Fighter feat 2, 2 actions, flourish): *"Make a melee Strike. This counts as two attacks when calculating your multiple attack penalty. If this Strike hits, you deal an extra die of weapon damage. If you're at least 10th level, increase this to two extra dice, and if you're at least 18th level, increase it to three extra dice."*

For a human player the module will, when the feat card is used:

1. Strike the targeted actor automatically with a ready melee Strike, at the current MAP.
2. Count that Strike as two attacks for later MAP.
3. On a hit, roll the Strike's damage with 1 / 2 / 3 extra weapon dice (level 2-9 / 10-17 / 18+), doubled on a critical hit as normal.
4. Leave the tracker charging 2 actions in total.

## Investigation findings

From the installed tracker (`pf2e-auto-action-tracker` v0.19.1, `main.js`) and the repo.

- **The tracker has no `vicious-swing` library entry.** Its complex-action library (`defensive-advance`, `penetrating-shot`, ...) does not list it. The feat card is charged its own 2 actions by the generic detector; any Strike afterwards is an unrelated action charged 1 more (3 total). The library is a compiled-in constant (no user-extensible registry was found).
- **The tracker already models "counts as two attacks"**: `penetrating-shot` uses the `mapIncrease2` modifier on its Strike child, and `getCurrentMapStateFromLog` doubles such a child in the attack count. That modifier only applies to library entries, so it is not reachable for Vicious Swing without patching the tracker.
- **The system has no automation for the rider.** The PF2e feat item has no damage rule element; the extra dice exist only in the description.
- **The module's AI path cannot be reused for a human.** `rollAndApplyStrikeAtVariant` applies damage itself; for a human, damage must go through the player's own chat message so `handleManualStrikeDamage` applies it once (Shield Block, critical deck). Same constraint as #1278.
- **Extra dice are not a flat bonus.** On a critical hit the extra die is doubled with the rest of the weapon damage (RAW: extra dice are part of the Strike's damage), so it must be added to the damage roll's dice, not appended as a separate roll.

## Resolved decisions

1. **Auto-roll the Strike** (owner: yes). Rejected: leaving the Strike manual and only adding the dice.
2. **Extra dice are added to the Strike's own damage roll** as additional dice of the weapon's die size and damage type, via a roll-option / `damageDice` synthetic injected for that one `strike.damage(...)` call, so crits double them and resistances/weaknesses apply as part of one damage instance. Rejected: a second separate damage roll (breaks crit doubling and double-applies resistance).
3. **Dice count by character level**: 1 (<10), 2 (10-17), 3 (18+).
4. **Target = the player's single targeted token**, read when the feat card is used. Rules for validity mirror #1278 (hostile, in combat, not defeated, not self).
5. **Melee Strike only**; selection mirrors `targetedStrikeActionFor` (highest `totalModifier` ready melee Strike in reach). Out of reach: no Strike, local notice, no refund (the player may Stride and Strike by hand; see cost handling).
6. **Human players only.** AI combatants keep `notOffered` (#947).

## Design

New file `scripts/vicious-swing.mjs`, wired from `module.mjs`. Pure decision logic is separated from Foundry I/O.

### 1. Detect the feat use (`createChatMessage`)

Author's own client only. `message.item?.slug === "vicious-swing"`, speaker is the current, non-`agentControlled`, non-defeated combatant of a started module combat.

### 2. Resolve target and Strike

Exactly one valid targeted token, else a local notice and stop. Choose the Strike via the extracted shared core of `targetedStrikeActionFor` (melee, ready, in reach).

### 3. Roll the Strike counting as two attacks

- Attack: `strike.variants[i].roll({ target, createMessage: true })` with `i = min(priorMapRelevantAttacks, 2)` read from the tracker log (same helper as #1278), skipping the roll dialog.
- Hit (`success` / `criticalSuccess`): `strike.damage({ target, outcome, createMessage: true })` with the extra-dice injection from decision 2. Dice are added in the same call so crit doubling and the damage message flow through the existing hooks unchanged.

### 4. Action cost (the open mechanism)

Required result: the tracker logs **2** actions for the whole feat. Because the tracker cannot be extended with a Vicious Swing activity, the Strike's own 1-action charge must be neutralised and the second attack's MAP weight preserved. The plan's first task decides the mechanism by reading `ActionManager.addAction` and the log-write path, in this order of preference:

1. **Tracker public API / hook** to mark a message as already paid (if one exists).
2. **A corrective log edit** limited to the single Strike entry the module just caused (set its cost to 0 and give it the `mapIncrease2` modifier the tracker already understands), written GM-side through the existing `combatant-write-relay` (#1254) because players cannot update combatants. Scoped by message id; never touches other entries.
3. **Fallback**: leave the tracker as is and whisper the GM "refund 1 action". The owner has accepted this only as a stopgap; the issue stays open for it.

This choice is explicitly **not** made by the spec: it depends on the tracker's code, which the plan must read first and record on the issue.

### 5. Failure behaviour

No step throws into the hook. Failures log once with the `MODULE_ID` prefix and leave the player able to finish by hand. A player who clicks Strike manually still works (3 actions charged, as today).

## Testing

- **Unit (`tests/`)**: feat-card predicate; dice count by level (1, 9, 10, 17, 18, 20); target validation; Strike selection and reach; variant-index from a tracker log including a `mapIncrease2` child; extra-dice injection produces N extra dice of the weapon's die size/type and doubles on a crit.
- **Contract guard**: a pinned fixture asserting the tracker has no `vicious-swing` entry and that `mapIncrease2` doubling in `getCurrentMapStateFromLog` still behaves as relied on (fails loudly if a tracker update adds the entry, so the module can stand down).
- **Live check, required before closing:** the player uses Vicious Swing against a target in reach and one out of reach, with and without a prior attack. Pass: tracker shows 2 actions, Strike at the right MAP, a later Strike carries the two-attack MAP, damage includes the extra die/dice (doubled on a crit), applied once. Issue moves to `verification` after merge.

## Out of scope

- Patching the tracker module.
- AI actors (#910 / #947).
- Other flourish feats with riders.
