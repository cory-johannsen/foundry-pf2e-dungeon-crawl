# Advanced AI Actors: Temporary Resistance, Hardness and IWR Adjustments

**Issue:** #1052 — resistance-reducing auras and IWR adjustments (Erosion Aura's resistance part).

**Builds on:** #979 / `docs/superpowers/specs/2026-10-09-ai-npc-equipment-damage-design.md` (Erosion Aura's Hardness reduction and start-of-turn damage, `itemDamage`), #963 / `docs/superpowers/specs/2026-10-09-ai-reaction-interception-design.md` (the guarded `applyDamage` wrapper, feature detection, kill switch, re-entrancy guard), #1051 (extended equipment targeting), #914 (agent-effect tagging and combat-end cleanup), #925.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions"); the system behavior was verified live.

## Summary

Erosion Aura says creatures and objects in its emanation "have their Hardness and resistances reduced by 10". #979 models the Hardness reduction and the start-of-turn damage but not the resistance reduction, because PF2e has no rule element that lowers a resistance. This spec adds a **general registry of temporary IWR adjustments** (resistance reduction, Hardness reduction, immunity and weakness adjustments), driven by **auras** or by **timed effects**, and applies it at the module's `applyDamage` wrapper seam so the system's own IWR step sees the adjusted values. Erosion Aura is the first consumer; the registry is reusable by other abilities.

## Investigation findings

Verified on the live world (Foundry 14.368, PF2e **8.5.0**):

- `ActorPF2e#applyDamage({ damage, token, item, rollOptions, skipIWR, shieldBlockRequest, outcome, ... })` computes the final damage with `applyIWR(this, damageRoll, rollOptions)` **synchronously at the start of the call** (before the first `await`) when `damage` is a roll, and bypasses IWR when `damage` is a plain number or `skipIWR` is true.
- `applyIWR` reads the actor's prepared `attributes.resistances` / `weaknesses` / `immunities` collections (objects with `type`, `value`, `exceptions`, ...). There is **no negative-resistance rule element** and no "reduce all resistances by N" rule; a Weakness does not cancel a Resistance in the system's arithmetic.
- #963 already wraps `applyDamage` (guarded, feature-detected, kill switch, re-entrancy guard) and decides synchronously from replicated data.
- Item Hardness is applied by the module itself in `itemDamage` (#979), so Hardness adjustments are pure arithmetic and need no system seam.

## Resolved decisions

1. **Mechanism:** a seam adjustment in #963's `applyDamage` wrapper driven by a registry of active IWR adjustments per creature, with aura membership computed at damage time.
2. **Scope (all four):** resistance reduction (by amount, optionally by type) for creatures in an aura; Hardness reduction for objects and items in an aura (re-expressing #979's reduction through the same registry); immunity and weakness adjustments; and aura-independent timed adjustments.
3. **Fallback is "no change":** when the wrapper cannot be installed, resistances are unmodified and the GM is told once.

## Design

### The registry (`scripts/iwr-adjustments.mjs`)

Adjustments are plain data:

```js
{
  id, source: { combatantId | actorUuid | effectUuid },
  kind: "resistanceReduction" | "hardnessReduction" | "immunityIgnore" | "weaknessAdd",
  amount: 10,                         // for reductions and weaknessAdd
  types: ["fire", "physical"] | "all",// damage types (resistances) the adjustment applies to
  scope: { aura: { radiusFeet, includeSelf: false, appliesTo: "creatures" | "objects" | "both" } }
        | { timed: { targetUuid, expiresAt } },
}
```

- `registerAdjustment`, `removeAdjustment`, `adjustmentsFor(target, { position, worldTime })` (pure over a snapshot of tokens and the registry): an aura adjustment applies when the bearer is alive and the target is within the radius (excluding the bearer unless `includeSelf`), a timed adjustment while unexpired.
- Aura adjustments are registered when the aura bearer joins a module combat (from the passive ability's parsed data: Erosion Aura declares `resistanceReduction 10 all` and `hardnessReduction 10`, radius 120 ft, `includeSelf: false`) and unregistered when it is defeated, removed or the combat ends. Timed adjustments are created by abilities through `registerAdjustment` with an expiry and a #914-tagged effect item that carries the display.

### Resistance reduction at the damage seam

In #963's `applyDamage` wrapper, before calling the original with a damage **roll**:

1. `adjustments = adjustmentsFor(this, ...)` filtered to `resistanceReduction`, `immunityIgnore`, `weaknessAdd`. None → call the original unchanged.
2. `restore = applyViewAdjustments(this, adjustments)` temporarily modifies the target's **prepared in-memory** IWR collections: for each resistance whose type matches (`types`), `value = max(0, value − amount)` (and removes the entry at zero); `immunityIgnore` marks matching immunities as ignored for the call; `weaknessAdd` pushes a synthetic weakness (type, value) that `applyIWR` reads. It records the original values.
3. Calls the original `applyDamage`. Because `applyIWR` runs synchronously before the first `await`, the wrapper **restores the prepared values immediately after the call returns its promise** (`const p = original.call(this, args); restore(); return p;`), so the adjustment exists only while the system reads it and never leaks into the sheet or other rolls.
4. Feature detection at install (extends #963's): `attributes.resistances` is an iterable of objects with numeric `value` and a `type`; if not, the adjustment layer is disabled with a warning and a one-time GM message. The system-version allowlist from #963 applies.

Persistent damage, direct HP updates and damage applied with `skipIWR` are unaffected (as RAW would require).

### Hardness reduction (objects and items)

`hardnessReductionFor(item)` returns the sum of applicable `hardnessReduction` adjustments for the item's owner or the item's location (an item on the ground inside the aura). #979's `applyEquipmentDamage` and #1051's extended targeting call it and pass the result as `hardnessReduction` to `itemDamage`; cover and structures (hazard actors with Hardness) use the same function in the damage path, so Erosion Aura reduces Hardness across the board with one source of truth.

### Erosion Aura

Registered as `{ resistanceReduction 10 all, hardnessReduction 10, aura 120 ft, includeSelf false }` from the passive item (fixture-checked, all-or-nothing). The start-of-turn damage stays as in #979. The "resistance reduction is not modeled" GM note from #979 is removed.

### Other uses (enabled, not built here)

The registry API is the extension point: a curse that lowers a target's fire resistance for a minute, an ability that ignores immunity to a trait, or a "weakness to cold 5" debuff register timed adjustments. No further abilities are added by this spec.

### Announcements and display

When an adjustment changes a damage application, the GM receives a whisper line ("Erosion Aura reduced the target's fire resistance 10 → 0"). Players are shown the aura's presence by its normal chat/aura display. The effect items for timed adjustments appear on the actor so the state is visible.

## Error handling

- Wrapper unavailable or shape check failed: no adjustment, one-time GM warning; resistances behave as unmodified.
- Registry entry whose bearer disappeared: removed on the next evaluation.
- An exception while adjusting or restoring: the original values are restored in a `finally`, the original `applyDamage` is still called, and the error is logged.
- Concurrency: the adjust-call-restore sequence is synchronous per call, so overlapping applications cannot observe each other's adjusted values.

## Testing

- **Registry (pure):** aura membership by distance, includeSelf, expiry, per-type filtering, stacking (adjustments of the same kind sum).
- **View adjustment:** resistance reduced to zero and removed, partial reduction, immunity ignore, synthetic weakness; restored exactly afterward; no leakage between calls.
- **Wrapper integration (fake `applyDamage` that reads the collections synchronously then awaits):** the call sees adjusted values and the post-call state is restored; the fallback leaves values untouched.
- **Hardness:** `hardnessReductionFor` for creatures' items and ground items; #979 and #1051 tests updated.
- **Erosion Aura:** registers, unregisters on defeat/combat end, 120 ft boundary.
- **Live verification:** fire damage to a fire-resistant creature inside a guthallath's aura deals reduced-resistance damage; outside it, normal.

## Explicitly out of scope

- New abilities that consume the registry (they are added by their own specs).
- Changing persistent damage or direct HP updates.
- Modifying the system's IWR arithmetic beyond the temporary in-memory view.

## Open questions

None. Planning-time details: the exact shape of the prepared IWR collections for each of resistances, weaknesses and immunities in the installed system and how a synthetic weakness is represented.
