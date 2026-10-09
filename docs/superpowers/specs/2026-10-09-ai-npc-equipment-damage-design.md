# Advanced AI Actors: NPC Equipment-Damaging Abilities

**Issue:** #979 — strike abilities that damage armor or shields, or bypass Hardness (Rending Mandibles, Armor-Rending Bite and similar), deferred from #933.

**Builds on:** #933 / `docs/superpowers/specs/2026-10-08-ai-npc-strike-plus-abilities-design.md` (the named-shape parser and executors for Strike-plus abilities, grab-state tracking), #978 / `docs/superpowers/specs/2026-10-09-ai-npc-strike-plus-shapes-design.md` (more shapes, the coverage ratchet), #931 / #962 (the damage seam, Shield Block through `applyDamage({ shieldBlockRequest })`), and the module's Strike and damage code (`rollAndApplyStrikeAtVariant`, `applyDefeatIfReducedToZero`, `handleManualStrikeDamage`, `scripts/dungeon-strike-riders.mjs`, `scripts/cover-items.mjs`).

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

A handful of monsters attack the target's **equipment** instead of, or in addition to, the creature: the ankhrav's acid sends the damage into the target's armor, bypassing its Hardness; the mantis and the smilodon break armor on a hit; the shuln and the adamant sentinel damage or break armor and shields on critical hits; the arboreal regent hits objects harder; the guthallath's aura erodes Hardness around it. #933 excluded these because its shapes only add damage or conditions to the creature.

This spec adds an **equipment-damage layer**: a small pure model of item HP, Hardness and broken state, a thin Foundry helper that applies it to the target's **worn armor and held shield** (read from the actor), and two integration points — new riders for #933/#978's Strike shapes, and a registry of **passive equipment riders** that fire automatically when an NPC's Strike hits or crits. It is **always on** (no setting), and every item damaged or broken is announced in public chat.

## Investigation findings

Confirmed against the repo, the installed PF2e system (v8.5.0, `pf2e.mjs`), and the local PF2e source data (Monster Core 1–2, Bestiary 1–3).

- **PF2e models equipment durability natively.** Physical items carry `system.hp` (`value`, `max`) and `system.hardness`; `isBroken` is true when `hp.value <= brokenThreshold` (half of max HP) and `isDestroyed` when HP is 0. A **shield's AC bonus becomes 0 automatically** when it is broken or destroyed (`acBonus = isBroken || isDestroyed ? 0 : acBonus`), and shield blocking already deals the remaining damage to the shield through `Actor#applyDamage` (`shieldBlockRequest`). Actors expose `wornArmor` and `heldShield`.
- **Nothing in the module touches item HP.** No code in `scripts/` damages, breaks or repairs equipment; cover items (#96) are hazard *actors* with their own HP and Hardness handled by PF2e's normal damage flow.
- **The abilities in scope (read from the data).**
  - *Armor-Rending Bite* (Ankhrav, 2 actions): "makes a mandibles Strike; if the Strike hits, the target's armor takes the damage and the acid damage bypasses the armor's Hardness."
  - *Rending Mandibles* (Deadly Mantis, 1 action): a mandibles Strike against a creature it has Grabbed; "if that Strike hits and the creature is wearing armor with Hardness 12 or lower, the armor is broken. This Strike doesn't further damage armor that's already broken."
  - *Pierce Armor* (Smilodon, 1 action): a fangs Strike against a Grabbed or Restrained creature; on a hit the creature is knocked Prone; "if wearing armor with Hardness 10 or lower, the armor is Broken. If this Strike breaks a creature's armor or damages a creature who is unarmored or wearing broken armor, the creature also takes 2d6 bleed damage." It does not further damage already broken armor.
  - *Destructive Strike* (Adamant Sentinel, passive): "On a critical hit, the fist Strike breaks the target's armor, if any, in addition to dealing damage. If the target has a shield raised, the sentinel breaks the shield instead."
  - *Armor-Rending Strikes* (Shuln, passive): "any time the shuln scores a critical hit with a melee Strike, it also deals the same amount of damage to the target's armor, bypassing any Hardness lower than 10, like adamantine."
  - *Sunder Objects* (Arboreal Regent, passive): "when it damages an item or structure, it deals an additional 2d10 damage to that item or structure."
  - *Erosion Aura* (Guthallath, passive aura, 120 feet): "creatures and objects in the emanation other than the guthallath have their Hardness and resistances reduced by 10. At the start of their turn, a creature in the aura takes 6d6 bludgeoning (Fortitude DC 39 basic)."
  - *Rust* (Vloriak, passive): on a successful tongue Strike or Disarm, 2d6 untyped (doubled on a critical) to a **metal item the target is wearing or holding, ignoring its Hardness**; an unattended metal item takes it automatically; a metal shield used to Shield Block the tongue attack is automatically broken instead.
- **Adamantine's rule is a Hardness threshold, not a full bypass.** "Bypassing any Hardness lower than 10, like adamantine" means the item's Hardness reduces the damage only by the amount above 10 (zero reduction for Hardness ≤ 10).
- **Where the module owns the damage.** AI Strikes are rolled and applied in `rollAndApplyStrikeAtVariant`, which also drives reactions' and movement's Strikes (#932/#972); a post-hit seam there sees the roll's outcome and damage total before or after `applyDamage`. The module applies damage to creatures itself for AI attackers, so redirecting a hit's damage to armor instead is possible there.
- **Rider conventions exist.** `dungeon-strike-riders.mjs` already runs post-hit riders keyed by attack-effect slugs (Grab as a real rider, Knockdown and Push as reminders); the same post-hit seam hosts the passive equipment riders.
- **Always-on impact.** Most targets are party characters, so item damage persists on a player's gear until repaired through the system's own Repair action; PF2e's broken/destroyed states then apply their own automation (a broken shield gives no AC bonus).

## Resolved decisions

1. **Mechanics in scope (all four):** armor-targeting Strike abilities (Armor-Rending Bite, Rending Mandibles, Pierce Armor), passive strike riders on critical hits (Destructive Strike, Armor-Rending Strikes), object and structure damage (Sunder Objects, Rust), and Hardness-reducing auras (Erosion Aura).
2. **Items in scope: the target's worn armor and held shield.** Held weapons and carried metal items (Rust's full targeting) are #1051.
3. **Always on.** No world setting; every item damage or break posts a public chat line.
4. **Erosion Aura's resistance reduction is not modeled** (#1052); its Hardness reduction and its start-of-turn damage are.

## Design

### Pure model (`scripts/equipment-damage.mjs`)

All arithmetic is pure over plain item snapshots `{ hp, max, hardness, brokenThreshold, broken, destroyed }`:

- `itemDamage(item, { amount, bypassHardness: false | true | "upTo:<n>", hardnessReduction = 0 })` → `{ dealt, newHp, nowBroken, nowDestroyed, wasBroken }`. Effective Hardness is `max(0, hardness - hardnessReduction)`; `bypassHardness: true` ignores it; `upTo:10` reduces only the Hardness above 10; `dealt = max(0, amount - effectiveHardness)`; `newHp = max(0, hp - dealt)`.
- `itemBreak(item, { maxHardness })` → sets HP to the broken threshold when the item's Hardness is at most `maxHardness` and it is not already broken (an already broken item is unchanged, "this Strike doesn't further damage armor that's already broken"); returns the same shape.
- `resolveEquipmentTarget(actor)` (thin Foundry reader) → `{ armor, shield }` where `shield` is the held shield only when it is raised (for Destructive Strike) and `armor` the worn armor, each as a snapshot plus the live item reference.

### Applying it (`applyEquipmentDamage`, Foundry helper)

`applyEquipmentDamage(combat, attacker, target, op)` reads the target's items, runs the pure function for the requested operation (`damage` with a bypass rule or `break`), updates `system.hp.value` on the live item, and posts a public chat line naming the attacker, the ability, the item and the result ("The ankhrav's acid eats through Fighter's chain mail (6 → 0 HP, destroyed)"; "Fighter's shield is broken!"). A GM-only follow-up whisper lists the item's new HP and broken/destroyed state. No Hardness is changed. If there is no applicable item (unarmored target, no raised shield) the operation reports "no armor" and does nothing. Operations are idempotent per hit (a hit is processed once).

### 1. Armor-targeting Strike abilities (extend #933/#978's shapes)

New rider vocabulary on the Strike shapes:

- **`damageToArmor`** (Armor-Rending Bite): on a hit, instead of applying the damage to the creature, apply the Strike's whole damage total to the target's armor with `bypassHardness: true`. If the target has no armor, the damage applies to the creature as an ordinary Strike. This needs one small hook in `rollAndApplyStrikeAtVariant`: an optional `onDamage(roll) -> boolean` callback that, when it returns true, tells the caller the damage was already handled and `applyDamage` to the creature is skipped.
- **`breakArmorOnHit { maxHardness }`** (Rending Mandibles: 12; Pierce Armor: 10): on a hit, `itemBreak` the worn armor; already-broken armor is left alone.
- **`conditionalDamage { when, formula, type }`** (Pierce Armor's bleed): `when` is `brokeArmorOrUnarmored`, evaluated from the operation's result (armor broken by this Strike, or the target unarmored, or already broken); the extra damage is rolled and applied as persistent bleed through #935's timed-condition/persistent helpers.
- Pierce Armor's other riders (Prone on a hit, a target that is Grabbed or Restrained) are existing #933 `strikeAgainstGrabbed` features.

The parsers recognize these riders by their exact sentences (the closed phrasings above) and, as always, an ability with any unconsumed sentence is not offered.

### 2. Passive strike riders (new registry, `scripts/strike-equipment-riders.mjs`)

A small table keyed by the passive ability's name, applied automatically at the post-hit seam of **every Strike the NPC makes through the module** (strike candidates, multi-strike bundles, reactions, movement Strikes, #933/#978 shapes):

| Passive | Trigger | Effect |
|---|---|---|
| Destructive Strike | critical hit | break the target's raised shield if it has one, otherwise break its worn armor (in addition to the Strike's own damage) |
| Armor-Rending Strikes | critical hit, melee Strike | deal the same amount of damage to the target's armor with `bypassHardness: "upTo:10"` |
| Sunder Objects | the Strike damages an item or structure (the target is a `hazard`-type object actor, such as a cover item) | add 2d10 damage to that item or structure |
| Rust | a successful tongue Strike or Disarm | 2d6 untyped (doubled on a critical hit) to the target's worn armor or held shield **if it is metal**, ignoring Hardness; unattended metal items are #1051 |

Metal is decided from a reviewed closed table (`METAL_BASE_ITEMS` plus material types such as steel, cold iron, adamantine, mithral) because PF2e has no "is metal" flag on armor or shields; the table is the data planning reviews.

The seam is passive: the NPC need not choose anything, so these never appear in the candidate list. The match uses the NPC actor's own items by ability name; an ability not in the table is simply not applied.

### 3. Erosion Aura (passive aura)

For a combat in which an actor with an `Erosion Aura` item participates:

- **Hardness reduction:** `applyEquipmentDamage` consults `auraHardnessReduction(target)`; for a target (and its items) within the aura's emanation of a living bearer, `hardnessReduction = 10` is passed to `itemDamage`, so every equipment effect in the scene is applied against Hardness reduced by 10.
- **Start-of-turn damage:** on the combat turn-start hook, for each combatant (other than the bearer) within the aura radius, roll the Fortitude save against the DC and apply basic-save bludgeoning damage through the #915 save executor, announcing it publicly. Distance uses the module's existing token-distance helpers (the aura radius from the item, 120 feet).
- **Not modeled:** the reduction of *resistances* (#1052). Because passive auras always apply (they are not offered as candidates), the first time the aura damages anyone in a combat the GM is told that the resistance reduction is not applied.

### Gating, reporting and ordering

- **Always on:** no setting; every effect posts the public chat line described above (equipment loss is table-visible), and the GM whisper adds the numbers. The #925 result descriptor for the Strike includes a clause for the equipment effect.
- **Ordering at the seam:** creature damage first (unless `damageToArmor` redirected it), then conditions and the shape's own riders, then passive equipment riders; each step is independent so a failure in one does not cancel the others.
- **Reactions and Shield Block:** a Shield Block (#931/#962) that already reduced the damage via `shieldBlockRequest` stays as is; Destructive Strike's "if a shield is raised, break the shield instead" applies on a critical hit regardless of the block (the shield is raised), matching the text.

## Error handling

- Item reads return `null` when an actor has no armor or shield; every operation is a no-op with a "no armor" note, never an error.
- An item update that fails is logged and reported to the GM; the Strike's other effects stand.
- Unreadable item data (`hp` or `hardness` missing) skips the operation rather than guessing values.
- The `onDamage` redirect returns false on any error so the damage applies to the creature as normal.
- Passive riders run in try/catch: a failing rider never blocks the Strike's damage, defeat handling or other riders.
- An aura start-of-turn handler failing for one creature continues with the rest.

## Testing

- **Pure model:** `itemDamage` across Hardness cases (full reduction, `bypassHardness: true`, `upTo:10` for Hardness below, equal to and above 10, `hardnessReduction`), HP floor at 0, broken/destroyed flags, `itemBreak` with and without the Hardness limit and for already-broken items.
- **Parsers (pure), real-text fixtures:** Armor-Rending Bite, Rending Mandibles, Pierce Armor with all clauses; near-misses that must return `null`.
- **Shape executors (mocked Foundry):** `damageToArmor` redirects the damage when armor exists and applies it to the creature when not, `breakArmorOnHit` respects the Hardness limit and the already-broken rule, the conditional bleed fires only in its cases.
- **Passive riders:** Destructive Strike (armor vs raised shield on a critical hit only), Armor-Rending Strikes (critical melee only, same damage, `upTo:10`), Sunder Objects (only against object actors), Rust (metal only, doubled on a critical hit, ignoring Hardness); applied for Strikes from every module path (candidates, bundles, reactions, movement); not applied on a miss or a normal hit where the trigger requires a critical.
- **Aura:** Hardness reduction applied to equipment effects inside the radius and not outside, start-of-turn save and damage for each creature in range, the one-time resistance note.
- **Metal table:** each base item/material classification.
- **Integration:** public chat line and GM whisper content; the chat line fires once per hit; a PF2e broken shield's AC bonus drops automatically after the item update (assert through the stubbed item model).
- **Regression:** #933/#978 shape tests, Shield Block/#931 tests, strike-rider and damage-application tests keep passing.
- **Live verification:** an ankhrav hitting an armored character (damage goes to the armor), a mantis breaking armor on a grabbed Fighter, an adamant sentinel critically hitting a shield-raised Paladin, and a guthallath aura shifting a Shield Block result.

## Explicitly out of scope

- Held weapons and carried or unattended metal items, and Rust's full targeting and Shield Block interaction — #1051.
- Erosion Aura's resistance reduction and a general resistance/Hardness adjustment mechanism — #1052.
- Repairing equipment (the system's Repair action already exists) and replacing broken items.
- Equipment damage inflicted by player characters, traps or environmental effects.
- Reactions that damage equipment and monsters' own equipment.

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: the reviewed metal-item table, the exact shape of the `onDamage` hook in `rollAndApplyStrikeAtVariant`, how the Disarm success for Rust is detected, and where the aura's start-of-turn handler attaches.
