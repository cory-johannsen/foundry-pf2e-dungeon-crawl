# Advanced AI NPCs: Ostovite Bone Chariot and Scuttle Away

**Issue:** #1156 — the ostovite's Scuttle Away reaction when its bone chariot is destroyed, deferred from #1019.

**Builds on:** #1019 / `docs/superpowers/specs/2026-10-09-ai-npc-other-creature-death-reactions-design.md` (the reaction registry's `subject` model, `scripts/npc-reactions-death.mjs`, `deathReactionHandled`), #959 / `docs/superpowers/specs/2026-10-09-ai-npc-death-reactions-design.md` (the `applyDefeatIfReducedToZero` seam and the `updateActor` fallback), #931 (`REACTION_DEFS`, `resolveReactions`, `markReactionUsed`), #935/#914 (timed effects, agent tagging), #932 (movement executors), #141 (`{ teleport: true }`), `scripts/dungeon-combat.mjs`.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

The ostovite fights from a **bone chariot** that is not a separate object: it is part of the ostovite's own stat block and is destroyed when the ostovite is hurt enough. When it is, the ostovite's statistics change and its **Scuttle Away** reaction lets it Step or Stride. This spec adds a **destroyed-chariot state** with the two destruction triggers (below half HP, and a critical hit), the **full transition** the stat block describes, the **Scuttle Away** reaction through #1019's registry, the **bypass for damage that targets the ostovite itself**, and a **token art / size change** for the destroyed state.

## Investigation findings

From Monster Core 2, p. 245 (Ostovite, creature 1, Small fiend, unholy).

- **Core stats:** HP 30, AC 15, Fort +6, Ref +9, Will +4, speed 25 feet; immunities: bleed, death effects, disease, doomed, drained, fatigued, healing, mental, nonlethal attacks, paralyzed, poisoned, sickened, unconscious. Skills: Crafting +4 (+6 with bone), Stealth +7.
- **Bone Chariot.** "The ostovite's statistics, especially its immunities, assume it is safely inside its chariot." There are no separate chariot HP or AC: the listed HP and AC are the ostovite's. The chariot is **destroyed when the ostovite is reduced to less than half its Hit Points**, and **immediately after the ostovite takes damage from a critical hit**. Damage that **specifically targets the controlling ostovite**, even while it is inside, does not destroy the chariot and **bypasses its immunities**.
- **After destruction** the ostovite loses its immunities and its Bone Spike Strike, becomes **Tiny**, and gains **weakness 5 to mental and physical damage**. A new chariot needs a Small or larger skeleton and 10 minutes (the rebuild is #1247).
- **Scuttle Away** (reaction): trigger "the ostovite's bone chariot is destroyed"; effect: the ostovite can **Step or Stride**.
- **Attacks:** Mandibles (+9, 1d4 piercing + 1d4 acid) and Bone Spike (+9, 1d12 piercing + 1d4 persistent bleed, only while in the chariot).
- **What the module has.** #1019's design routes reactions from `applyDefeatIfReducedToZero` and an `updateActor` fallback for system-applied damage, with a `subject` filter; those seams fire on drops to 0 HP. Damage to a creature goes through several executors (`rollAndApplyStrike`, spell and ability executors) that call `applyDefeatIfReducedToZero`; there is no "damaged below a threshold" or "critical hit damage" trigger yet.

## Resolved decisions

1. **Chariot state** is derived from HP and a durable `chariotDestroyed` marker set once at the transition (so healing does not restore the chariot). No separate chariot token or HP.
2. **The full transition is applied, then the reaction is offered:** immunity removal, Bone Spike withheld, size Tiny, weakness 5 to mental and physical, then Scuttle Away resolves.
3. **Scuttle Away movement is deterministic:** Stride to the cell that maximizes distance from opponents and cover, otherwise Step.
4. **Extras in scope:** the critical-hit trigger, the bypass for damage that targets the ostovite itself, and the token art / size change for the destroyed state. **Filed:** rebuilding a chariot (#1247).

## Design

### State (`scripts/ostovite-chariot.mjs`)

```js
chariotState(actor) → "intact" | "destroyed" | "notOstovite"
```

An actor is an ostovite when its source slug (or name) matches the reviewed definition (exact-match with fixture-checked item text, as #959/#1019). Its state is read from `flags.pf2e-dungeon-crawl.chariotDestroyed` (a boolean with `{ round, cause }`); absent means intact. No other state is stored.

### Destruction triggers (pure `chariotDestroyedBy`)

```js
chariotDestroyedBy({ hpBefore, hpAfter, maxHp, critical, targetedRider }) → { destroyed: boolean, cause?: "belowHalf" | "critical" }
```

- If `targetedRider` (the damage specifically targets the ostovite) → `{ destroyed: false }`.
- If `critical` and `hpAfter < hpBefore` (the ostovite took damage from a critical hit) → `{ destroyed: true, cause: "critical" }`.
- If `hpAfter < maxHp / 2` and `hpBefore >= maxHp / 2` → `{ destroyed: true, cause: "belowHalf" }`.
- Otherwise not destroyed. Already-destroyed chariots never re-trigger.

### Where it fires (new post-damage seam)

A single `afterDamageApplied(target, { hpBefore, hpAfter, critical, targetedRider })` is called from the same executors that call `applyDefeatIfReducedToZero` (`rollAndApplyStrike`, the spell and ability damage paths) **before** the defeat check, and from the `updateActor` fallback for system-applied damage (where `critical` is read from the originating damage message flags `flags.pf2e.context.outcome` and `targetedRider` is false unless the message marks otherwise). It evaluates `chariotDestroyedBy`; on `destroyed` it runs the transition and then asks the reaction registry to resolve Scuttle Away. It is a no-op for non-ostovites.

### "Targets the ostovite itself" (bypass)

Damage that specifically targets the controlling ostovite — an effect or ability that names the rider, such as a Strike made with a trait or option the module recognizes — is a `targetedRider` event. Recognition is a closed reviewed predicate over the damage message's roll options and origin (`target:ostovite-rider`, a spell/ability with the reviewed slug list in `data/ostovite-rider-targeting.json`), starting empty and extended as entries are reviewed. For a `targetedRider` hit the executor skips the chariot's immunities (damage types and conditions the intact chariot is immune to apply normally) and the chariot is not destroyed. When no entry matches, the damage is treated as ordinary damage to the chariot-covered creature.

### The transition (`applyChariotDestroyed`)

Applied once, idempotently (a destroyed marker short-circuits):

1. Set `flags.pf2e-dungeon-crawl.chariotDestroyed = { round, cause }`.
2. **Immunities.** Apply a native, agent-tagged effect that adds **weakness 5 to mental and physical** (a `Weakness` rule element per the system) and removes the actor's immunities. The system's `Immunity` rule element only adds immunities, so removal is realized by storing the original `system.attributes.immunities` in `flags.pf2e-dungeon-crawl.chariotImmunities` and writing an empty list to the actor's source data (reversible by #1247), unless planning finds a native rule-element override.
3. **Bone Spike withheld.** Mark the Bone Spike item `chariotOnly`; the candidate builders skip any Strike with that mark when the actor's chariot is destroyed.
4. **Size.** Apply the native `CreatureSize` override (Tiny) in the same effect, so reach, space and the token footprint follow the system.
5. **Token art / size.** Scale the token to Tiny through the token's width/height (or the system's size-driven resize) and swap the token art to a `destroyed` variant if one exists in the creature-art data (`creature-art.json`); the original art is stored in a flag for the rebuild. A missing variant leaves the art unchanged.
6. Post a public chat line: "<name>'s bone chariot is destroyed!"

### Scuttle Away (registry entry in `npc-reactions-death.mjs`)

A new definition `kind: "scuttleAway"`, `subject: "self"`, `trigger: "chariotDestroyed"` (a new trigger event emitted by the transition). The shared gates apply: agent-controlled, reaction item present, reaction unused this round, `deathReactionHandled` keyed `(subjectId, reactorId, round)`. The effect:

1. Enumerate legal Step cells (5 ft, walkable) and Stride cells (up to the speed, 25 ft, using the movement executor's pathing and Terrain cost, #973).
2. Score each cell: `+` distance from the nearest opponent, `+` line-of-sight cover from opponents, `−` adjacency to an opponent, `−` hazard cells. Choose the best Stride cell if its score exceeds the best Step cell's by a margin, else the best Step cell. The margin and weights are fixed constants in the module.
3. Move with the movement executor (no reaction triggers from the move itself) and announce "X scuttles away".
4. If no legal cell exists, the reaction is spent without moving (announced), per the rule's "can move".

The reaction is not offered if the actor is not agent-controlled or has no Scuttle Away item.

### Interaction with defeat

If the damage that destroys the chariot also reduces the ostovite to 0 HP, the transition runs first, then #959's defeat reactions, and Scuttle Away does not fire for a creature that dropped (a defeated creature cannot move); the destroyed state is still recorded.

## Error handling

- A missing HP/max HP reading, an unreadable damage message or an actor that isn't an ostovite is a no-op.
- A transition step that fails (the source-data write, the art swap) is logged and the remaining steps still apply; the marker is set first so the state is never re-run.
- A reaction failure never blocks the transition or the defeat check, and doesn't mark the reaction used.
- A second destruction event (already destroyed) never re-applies anything.
- Hooks never throw into the combat turn.

## Testing

- **`chariotDestroyedBy` (pure):** below half exactly at the boundary, a crit at full HP, a crit that doesn't reduce HP, `targetedRider`, already destroyed, rounding of odd max HP.
- **Seam (mocked):** `afterDamageApplied` is called from the strike, spell and ability paths and from the `updateActor` fallback; no-op for non-ostovites; crit read from message flags.
- **Transition:** marker, weakness effect, immunities removed and original stored, Bone Spike withheld from candidates, Tiny size, art swap and fallback, chat line, idempotence.
- **Targeted-rider bypass:** an entry in the reviewed list skips immunities and doesn't destroy the chariot; no entry means ordinary damage.
- **Scuttle Away:** cell scoring (distance, cover, adjacency, hazards), Stride vs Step choice, no legal cell, once per round, not offered to non-agents; ordering with defeat.
- **Regression:** #959/#1019 reaction tests and the defeat seam unchanged; non-ostovite damage paths unchanged.
- **Live verification:** hit an ostovite below half HP, then a fresh one with a critical hit; confirm the chariot is destroyed, the stat changes and Tiny token appear, Bone Spike is no longer used, the weakness applies, and Scuttle Away moves it away from enemies; healing it does not restore the chariot.

## Explicitly out of scope

- Rebuilding a chariot (#1247).
- Chariots for other creatures, larger cooperative chariots, and the Crafting use of bone.
- Prose interpretation by the reasoning model.

## Open questions

None blocking. Left to planning: whether a native rule-element override can remove immunities (preferred over the reversible source-data write), the first entries of the targeted-rider list, and whether a `destroyed` token art variant exists for the ostovite in `creature-art.json`.
