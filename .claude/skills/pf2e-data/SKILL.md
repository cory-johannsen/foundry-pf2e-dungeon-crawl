---
name: pf2e-data
description: Use when reading or writing Pathfinder 2e actor, item, or creature data in Foundry VTT — changing speed, size, HP, saves or skills, granting items or runes, filtering the bestiary, or summoning creatures. Covers which fields are derived and silently reject writes, and where PF2e actually stores things.
---

# PF2e data in Foundry

The system computes most of a character sheet from other data. Writing to a computed field succeeds, changes nothing, and reports no error — the commonest way to lose an hour here.

## Derived or stored?

`actor.system` is the sheet **after** derivation. `actor._source.system` is what is on disk. If a field is in `system` but not in `_source`, it is computed and cannot be written.

```js
const a = game.actors.getName('Someone');
return { derived: a.system.attributes.hp, stored: a._source.system.attributes.hp };
// derived: { value: 11, max: 21, ... }     stored: { value: 11, temp: 0 }
```

`max` is absent from `_source`, so `system.attributes.hp.max` is derived. Setting it does nothing. Likewise `system.traits.size` on a character: absent from `_source` entirely.

Check `_source` before writing any field you have not written before. It is faster than discovering it on the sheet.

Known derived, on characters: **max HP**, **size**, **all speeds**, skill and save totals, AC, perception.

## Changing derived things: rule elements

The supported way is a rule element on an effect or item. `FlatModifier` adjusts a value; `BaseSpeed` replaces a speed; `CreatureSize` changes size.

```js
{ key: 'FlatModifier', selector: 'land-speed', type: 'status', value: 10 }
{ key: 'BaseSpeed',    selector: 'land',      value: 40 }
{ key: 'CreatureSize', value: 'large' }
```

**The two take different selectors for the same speed**, which is the detail that wastes the afternoon:

- `FlatModifier` wants the slug — `land-speed`
- `BaseSpeed` wants the movement type — `land`, `fly`, `swim`, `climb`, `burrow`

Other `FlatModifier` selectors are slugs too: `hp`, `will`, `fortitude`, `reflex`, `diplomacy`, `ac`, `perception`.

**`BaseSpeed` takes `selector`, not `type`.** Given `type` it validates, applies, and does nothing at all — no warning. Every one of the system's own `BaseSpeed` elements uses `selector`; if a rule element has no effect, suspect the key name before the value.

A value may be an expression rather than a number, which is how the system copies one speed to another:

```js
{ key: 'BaseSpeed', selector: 'fly', value: '@actor.system.movement.speeds.land.value' }
```

To see real examples, read `system.rules` on any item that grants something:

```js
return game.actors.getName('Someone').items
  .find(i => (i.system?.rules ?? []).length)?.system.rules;
```

## Where things actually live

Verified against PF2e 8.5. Several of these are not where the sheet's wording suggests.

| thing | path | note |
|---|---|---|
| speed | `system.movement.speeds.land.value` | **not** `system.attributes.speed` — that does not exist on characters |
| size | `system.traits.size.value` | codes are `tiny sm med lg huge grg` — **`lg`, not `large`** |
| languages | `system.details.languages.value` | array of slugs |
| spell tradition | `system.traits.traditions` | **not** in `system.traits.value` |
| coins | items of type `treasure` | there is no currency field; "Gold Pieces x10" is an item |
| level | `system.details.level.value` | see XP below before writing it |
| alliance | `system.details.alliance` | `party`, `opposition`, or null |
| party | `game.actors.party` | a real actor with `.members` |

## Runes

On a weapon or armour, `system.runes`:

```js
{ potency: 2, striking: 1, property: ['ghostTouch'] }   // weapon
{ potency: 1, resilient: 0, property: [] }              // armour
```

- `potency`, `striking` and `resilient` are **integers**, the grade as a number.
- `property` is an array of **camelCase slugs with the grade first**: `ghostTouch`, `greaterAcidResistant`, `coldResistant`. A kebab slug from an item name needs converting, moving the grade to the front.
- A property rune requires `potency >= 1`. Etching one onto a mundane weapon silently accomplishes nothing.
- `property` is occasionally stored object-shaped (`{0: 'x'}`) rather than as an array. Handle both when scanning packs.

Rune items themselves are type `equipment`, and what they attach to is only in `system.usage.value` — `etched-onto-a-weapon`, `etched-onto-armor`. Their names do not say.

## Finding creatures

**Filter by trait, never by name.** PF2e names its undead "Wight", "Ghoul", "Zombie Shambler"; a `/undead|wraith|revenant/` name filter matches almost nothing while the `undead` trait matches hundreds.

Exclude `troop` and `swarm` unless you want them. Both are single tokens standing in for many creatures, and both are Large or bigger, so a size filter alone lets them through. A card asking for "a Large creature" got a Vicious Levaloch **Squad**.

Creature packs are not only the bestiaries. In the Remaster, Monster Core is the primary source:

```js
/bestiary|monster-core|npc-core|npc-gallery/i
```

Matching `bestiary` alone misses Monster Core, Monster Core 2, NPC Core and NPC Gallery — over a thousand creatures, including the only homunculus.

Prefer Monster Core over adventure bestiaries when picking at random: the adventure packs are full of named characters with a place in someone's plot.

## Summoning

**Set `system.details.alliance` on the actor, not just token disposition.** PF2e derives disposition from alliance and overrides what you set on the token, so an ally copied from a bestiary entry arrives hostile — every bestiary NPC is `opposition`.

```js
foundry.utils.mergeObject(doc.toObject(), {
  'system.details.alliance': disposition > 0 ? 'party' : 'opposition',
  'prototypeToken.disposition': disposition
});
```

Token size is in grid squares on `prototypeToken.width` / `.height`, while position is in pixels. Mixing them puts a Large creature half a square off the grid.

SRD bestiaries ship **no token art**, so anything summoned from one arrives as the default silhouette unless the caller supplies an image.

## XP and levelling

Grant XP; do not set `system.details.level.value`. Writing the level skips the level-up flow, leaving a character with the feats and boosts of their old level and the number of the new one.

```js
{ 'system.details.xp.value': actor.system.details.xp.value + 200 }
```

PF2e is 1000 XP per level, not 5e's thresholds. A conversion that grants 10,000 hands out ten levels.

## Effects

Effect names are data and are never localised. Putting a translation key in one displays the key. If a name is built from a key, supply a fallback string and require it.

Immunities take a shape, not a bare string:

```js
system.attributes.immunities = [{ type: 'death-effects' }, { type: 'poison' }];
```
