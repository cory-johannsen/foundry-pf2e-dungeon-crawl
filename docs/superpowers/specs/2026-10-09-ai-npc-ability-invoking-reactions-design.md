# Advanced AI NPCs: Reactions That Invoke Abilities or Move the Reactor

**Issue:** #1027 — reactions that invoke other abilities or move/transform the reactor (Fast Swallow, Slink, Crumble, Overwhelming Light), deferred from #961.

**Builds on:** #961 / `docs/superpowers/specs/2026-10-09-ai-npc-other-triggered-reactions-design.md` (other-triggered reactions, trigger grammar), #931 (`REACTION_DEFS`, `resolveReactions`, `markReactionUsed`, recharge), #932/#933 (movement machinery, Strike-plus shapes), #1021 / `docs/superpowers/specs/2026-10-09-ai-npc-spell-counteract-reactions-design.md` (counteract helper), #959 (damage seam), #986 (grab state), #915/#935, #925.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

Four reactions invoke another ability or move the reactor: **Slink** (viper), **Crumble** (stone mauler and kin), **Overwhelming Light** (shining child) and **Fast Swallow** (mu spore). This spec models all four. It reuses #932's movement machinery and #1021's counteract helper, and — because Fast Swallow's effect is "uses Swallow Whole" — it also defines a **minimal Swallow Whole** (engulf, per-round damage, escape) so the reaction has an ability to call.

## Investigation findings

- **Slink** (viper): trigger "a creature ends its movement adjacent to the viper or within its space"; the viper Strides, Climbs or Swims up to 10 ft (or its Speed if less), must end more than 5 ft from foes, and the movement doesn't trigger reactions.
- **Crumble** (stone mauler; 3 creatures share the name): trigger "takes damage from a hostile source while atop rock or earth"; Burrows down 15 ft (the stone mauler's text; other creatures vary) without triggering reactions; can't Crumble again for `1d4` rounds.
- **Overwhelming Light** (shining child, light): trigger "enters an area of magical darkness or begins its turn in one"; attempts to counteract the darkness, counteract rank 7, modifier `+23`.
- **Fast Swallow** (mu spore; 8 creatures share the name): trigger "Grabs a creature with its jaws"; the spore uses Swallow Whole.
- **Swallow Whole** is not modeled in the module. The system's glossary text: the monster attempts a Reflex-opposed Athletics check to swallow a grabbed/restrained creature of the listed size or smaller; the swallowed creature is Grabbed and Slowed 1, holds its breath, takes the listed damage when swallowed and at the end of each of its turns, and can attack the swallower only with unarmed or light-Bulk weapons; the swallower can't attack swallowed creatures; Escape frees them through the mouth; a creature of the maximum size means the swallower can't swallow another; and a creature that deals enough damage (Rupture value) to the swallower ends the engulfing.
- **Existing machinery.** #932/#933 give the movement executors (Stride/Climb/Swim/Burrow with reaction suppression), #986's grab state tracks who holds whom, #959 provides the damage seam (including `updateActor` fallback), #1021 provides `rollCounteract`, #931 provides recharge and one-reaction-per-round bookkeeping.

## Resolved decisions

1. **All four reactions in scope**, including Fast Swallow.
2. **A minimal Swallow Whole is modeled here** (engulf, damage when swallowed and at the end of each of the swallowed creature's turns, escape), shared by the reaction and the plain action.
3. **Exact-match reviewed definitions**, per #931/#959: item names and text are fixture-checked; every sentence must be consumed.
4. **Deterministic, automatic, public**; no model call.

## Design

### Slink (`reactiveStride`)

- **Trigger:** `creatureEndedMovementAdjacent` (a `updateToken`-driven movement-end event; the module's movement executor and the system's token move both produce it). The reactor must be agent-controlled with the reaction unused.
- **Policy:** fire when a destination exists that is within the movement budget and **more than 5 ft from every foe** (using the existing legal-path search with reactions suppressed); pick the destination farthest from foes, ties by fewest squares. If none exists, the reaction is not used.
- **Execution:** the #932 movement executor with `{ triggersReactions: false }`, a mode in `Stride | Climb | Swim` chosen by what the creature can do (Stride preferred). Announce; `markReactionUsed`.

### Crumble (`burrowAway`)

- **Trigger:** damage applied to the reactor from a hostile source (#959's seam) while the token stands on a tile flagged `rock`/`earth` terrain (the scene/room terrain tags; a tile with no tag is not eligible — closed-world).
- **Recharge:** `1d4` rounds using #931's recharge store.
- **Execution:** the creature Burrows down by the item's distance (parsed from the text). Representation: the token is set `hidden` and marked `burrowed: { depth, round }` for the module's targeting (not a valid target, no reactions provoked). It surfaces at its next turn: as the first action of that turn the module returns the token to the surface at an unoccupied square within its Speed of the burrow point (a Burrow action costs nothing extra; the reaction already spent the movement). The surfacing is announced.

### Overwhelming Light (`counteractDarkness`)

- **Trigger:** the reactor enters, or begins its turn in, an area of **magical darkness**. The module recognizes magical darkness from active darkness spell effects/templates (an effect or template item with the `darkness` trait from a spell) overlapping the token's square.
- **Execution:** `rollCounteract` (#1021) with rank `7`, modifier `+23` against the darkness spell's counteract rank and caster DC; on counteract, the darkness effect/template is removed (the spell effect deleted, or the area's light level restored). Announced with the result either way.

### Swallow Whole (shared, `scripts/swallow-whole.mjs`)

- **State:** `flags.pf2e-dungeon-crawl.swallowed = [{ creatureId, damage, round, size }]` on the swallower, and `swallowedBy` on the swallowed creature.
- **Action (`swallowWhole`):** requires a creature the swallower currently holds (#986 grab state) of the listed size or smaller; the swallower rolls Athletics versus the grabbed creature's Reflex DC (a `swallowWhole` outcome table: success swallows, failure leaves it grabbed, critical failure releases it per Grab's rules); a creature of the maximum size listed prevents further Swallow Whole. On success: the creature is removed from the map (hidden inside, tokens stacked at the swallower's square), takes the listed damage immediately (acid for the mu spore), and is Grabbed and Slowed 1; the swallower's mouth grab is released; the swallower can't Strike swallowed creatures.
- **Per-turn damage:** at the end of each of the swallowed creature's turns, apply the listed damage through `applyDamage` (a combat turn hook).
- **Escape:** the swallowed creature's Escape (Athletics/Acrobatics vs the swallower's Athletics DC) frees it through the mouth to a free square adjacent to the swallower; this uses the existing Escape executor with the swallowed state.
- **Rupture:** damage dealt to the swallower from inside in one hit at or above the Rupture value ends the engulfing for all victims (the item parses the value).
- **Suffocation:** the swallowed creature is treated as suffocating after the holding-breath limit using #987's suffocation outcome kind.
- The same function powers the plain **Swallow Whole** NPC action as an `npcAbility` candidate when the reactor holds a creature, and Fast Swallow.

### Fast Swallow (`invokeAbility`)

- **Trigger:** the reactor Grabs a creature with its jaws (#986's grab-applied event).
- **Execution:** `swallowWhole(reactor, grabbed)` per above, as a free invocation (the reaction is the action). `markReactionUsed`.
- **Policy:** always fire when the grabbed creature is of the swallowable size or smaller; otherwise do not.

### Registry

New kinds in `REACTION_DEFS`: `reactiveStride`, `burrowAway`, `counteractDarkness`, `invokeAbility` (with `ability: "swallowWhole"`), and trigger kinds `creatureEndedMovementAdjacent`, `damagedAtopTerrain`, `enteredOrBeganInDarkness`, `grabbedWithJaws`. Shared gates apply.

## Error handling

- No legal Slink destination, no terrain tag, no magical-darkness effect, or an unswallowable size: reaction not offered.
- Failure inside an effect aborts without marking the reaction used.
- A swallower removed from combat releases all swallowed creatures to adjacent squares.
- Surfacing from a burrow with no free square tries the nearest free square and otherwise stays hidden one more turn, with a GM note.

## Testing

- **Slink:** destination search honors the 5-ft-from-foes rule and the reaction-suppressed movement; no destination → unused.
- **Crumble:** terrain-gated, recharge, hidden/untargetable while burrowed, surfaces next turn.
- **Overwhelming Light:** counteract outcomes per the table; darkness removed on success.
- **Swallow Whole:** size gate, opposed check outcomes, immediate and per-turn damage, escape, Rupture ending, owner removal; Fast Swallow triggers it on a jaws Grab.
- **Fixtures:** each item matches; changed text disables its definition.
- **Live verification:** a viper slinks away from an approaching foe; a mu spore swallows a grabbed PC and the damage ticks each turn.

## Explicitly out of scope

- Other "uses <ability>" reactions not in this set.
- Transformations beyond burrowing (shapechange reactions).
- Swallow Whole variants with unusual rules (Engulf, Gulp), modeled separately.

## Open questions

None. Planning-time details: the tile terrain tags for rock/earth, the magical-darkness recognition, and how the swallowed token is represented on the map.
