# Advanced AI NPCs: Equipment Damage Beyond Worn Armor and Shields

**Issue:** #1051 — equipment damage beyond worn armor and shields (held weapons and carried metal items, Rust-style targeting).

**Builds on:** #979 / `docs/superpowers/specs/2026-10-09-ai-npc-equipment-damage-design.md` (the pure equipment model `scripts/equipment-damage.mjs`, `applyEquipmentDamage`, armor-targeting riders, passive strike riders, public announcements), #933/#978 (Strike shapes and riders), #963 / `docs/superpowers/specs/2026-10-09-ai-reaction-interception-design.md` (Shield Block interception), #925.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#979 limits equipment effects to the target's **worn armor and held shield**. This spec extends the targeting to **held weapons**, **carried or worn metal items** (Rust's full targeting), **unattended metal items**, and the **Shield Block interaction** (a metal shield used to block a Rust tongue attack is automatically broken). It reuses #979's pure damage model and applier; the new work is choosing the item and wiring the special cases. PF2e's native item HP, Hardness and broken/destroyed states do the rest.

## Investigation findings

- **Native durability.** Physical items carry `system.hp`, `system.hardness` and a broken threshold (half of max HP); `isBroken`/`isDestroyed` are derived. A broken or destroyed shield stops giving its AC bonus automatically. The system provides `wornArmor` and `heldShield`; held weapons are available through the actor's equipped weapons (`system.equipped.handsHeld`/`carryType: held`).
- **Rust** (vloriak, passive): on a successful tongue Strike or Disarm, `2d6` untyped damage (doubled on a critical hit) to a **metal item the target is wearing or holding**, ignoring the item's Hardness; an **unattended** metal item takes it automatically; a metal shield used to Shield Block the tongue attack is automatically broken instead.
- **#979 pieces to extend.** `resolveEquipmentTarget(actor)` returns only `{ armor, shield }`; `itemDamage`/`itemBreak` operate on plain item snapshots, so they work for any physical item unchanged; the strike rider registry and `rollAndApplyStrikeAtVariant`'s post-hit seam host passive riders.
- **Shield Block** is a reaction that reduces damage by the shield's Hardness and deals the remainder to the shield (via `applyDamage` with `shieldBlockRequest`). #963's wrapper on `applyDamage` is the seam where a "blocked tongue attack breaks the shield" rule can be applied.
- **Metal.** An item's material is in `system.material.type` (e.g. `adamantine`, `cold-iron`, `silver`, `steel`/`iron` by derived category) and its traits/slug for base items; metal detection is a pure function over `{ material, category, slug, traits }` with a reviewed list.

## Resolved decisions

1. **Extensions in scope:** held weapons, carried/worn metal items, unattended metal items, and the Shield Block interaction.
2. **Item choice is deterministic** by a fixed priority: worn armor if metal, else held shield if metal, else a held weapon if metal, else any other carried/worn metal item (highest max HP first, ties by name).
3. **Always on and announced publicly**, as #979.

## Design

### Metal detection (`isMetalItem(snapshot)`, pure)

True for items whose `material.type` is a metal (`adamantine`, `cold-iron`, `silver`, `mithral`, `orichalcum`, `dawnsilver`, `duskwood` is not), or whose base slug appears in a reviewed table of metallic base items (chain mail, full plate, shields of steel, swords, axes, daggers, crossbow metal parts, tools such as thieves' tools). Non-weapon carried items count if their slug is in the reviewed table. Ambiguous items are not metal (closed-world).

### Target resolution (extends `resolveEquipmentTarget`)

`resolveEquipmentTargets(actor)` returns an ordered list of candidate snapshots `{ role: "armor" | "shield" | "weapon" | "other", item, snapshot }` of the actor's:

- worn armor, held shield (raised or not), held/wielded weapons (equipped, `carryType: held`), and other **worn or held** physical items (`carryType: worn | held`);
- **unattended** metal items within reach: items on the scene as loot tokens/item piles within the attacker's reach that are not carried by any actor (the module's own loot tokens), plus items in a container the attacker can reach if the container is unattended.

`chooseEquipmentTarget(candidates, rule)` applies the fixed priority above for Rust and the shape-specific rule for others (armor-targeting abilities keep choosing armor only, as #979). Unattended items are chosen only when the ability's text names them and no attended metal item applies, or when the attacker has no attended target and the ability says "metal item" without restriction.

### Rust (`damageMetalItem`)

On a successful tongue Strike (a hit) or Disarm (success), by the vloriak:

1. Candidates = the target's attended metal items (worn or held); if none, unattended metal items in reach (automatic, no roll).
2. `itemDamage(item, { amount: 2d6 (×2 on a critical hit), bypassHardness: true })`.
3. Public announcement with the item and new HP/broken state.
Disarm uses the Disarm outcome (#940 maneuver executor) instead of a Strike hit.

### Held weapons (Sunder-style)

The same executor with `role: "weapon"` candidates: damage to a held weapon uses `itemDamage` with the ability's bypass rule. A weapon reduced to its broken threshold becomes **broken** (PF2e's own `isBroken`), which the system treats as unusable for most effects; the module's Strike vocabulary excludes broken weapons from the owner's candidates (reuse of the existing "broken" gate; if absent, added). A destroyed weapon is removed from the actor's equipped list by the system.

### Shield Block interaction

In #963's `applyDamage` wrapper (and the fallback), when the incoming damage originates from a Strike by an attacker with the Rust rider (`flags.pf2e-dungeon-crawl.rust = true` set by the rider on its Strike context) and the target has performed Shield Block this Strike with a **metal** shield, the shield is broken outright (HP set to its broken threshold if not already broken; the Shield Block damage reduction still applies as a normal block). Announced publicly ("The vloriak's tongue corrodes Fighter's steel shield!"). Without the wrapper (fallback), the rider checks `message.flags.pf2e.context.options` for `shield-block` after the fact and applies the break the same way.

### Unattended items

Items lying on the scene (loot item piles / item tokens) and within the attacker's reach are legal targets for abilities whose text allows "an unattended metal item"; damage applies automatically (no attack roll), via `applyEquipmentDamage` on the loot token's item. Items in a party member's backpack (carried, not worn/held) are *not* targeted: the text says "wearing or holding".

### Interaction with #979 abilities

The armor-targeting abilities (Armor-Rending Bite, etc.) keep armor-only targeting. Passive riders on critical hits (Destructive Strike) keep armor, and shield if raised. Only abilities whose text says "metal item" (Rust) or "held weapon" use the extended targeting; the choice is a `targeting` parameter on the rider (`"armor" | "metalItem" | "weapon"`).

## Error handling

- No candidates: the rider reports "no metal item" and does nothing (the Strike's other effects are unaffected).
- Ambiguous material data: not metal; logged at debug level.
- Item update permission issues for a player's items: executed on the GM client via the relay, as #979.
- A destroyed item removed mid-resolution: the next candidate is not substituted automatically (one item per hit).

## Testing

- **Metal detection:** reviewed table, materials, ambiguous items.
- **Target resolution/selection:** priority order, ties, unattended items, containers, carried-not-worn exclusion.
- **Rust:** damage amount and critical doubling, bypassing Hardness, Disarm path, no items, unattended auto-damage.
- **Held weapons:** break threshold, broken weapons excluded from vocabulary.
- **Shield Block:** metal shield broken on a Rust tongue Strike; non-metal shield not; fallback path via roll options.
- **Live verification:** a vloriak's tongue Strike corrodes a PC's steel sword and breaks a raised metal shield.

## Explicitly out of scope

- Hardness/resistance-reducing auras (#1052).
- Repairing items (the system's Repair action).
- Non-metal materials (acid damage to wood, etc.) beyond the existing armor-targeting abilities.

## Open questions

None. Planning-time details: the reviewed metallic base-item table and the exact property for held weapons in the installed system.
