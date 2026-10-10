# Advanced AI NPCs: Spell-Derived Summoned Mounts (Phantom Mount)

**Issue:** #1069 — spell-derived summoned mounts and companions (Phantom Mount), deferred from #983.

**Builds on:** #983 / `docs/superpowers/specs/2026-10-09-ai-npc-summon-abilities-design.md` (the summon record, minion combatants that never take their own turn, minion commands, lifetime and cleanup, rewards), #932 (movement executors), #986 (grab state, for linking tokens), #914 (effect tagging and cleanup), #910 (frequency store), #925.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

The graveknight's **Phantom Mount** summons a supernatural mount "as Marvelous Mount heightened to half the graveknight's level", with statistics derived from the *summoner's own* rather than from a fixed compendium creature. This spec adds a **stat-derivation function** for such creatures (offsets from the summoner and values from the heightened spell), and **mount rules** that make the graveknight actually ride the steed: shared position, the mount's Speed for movement, and the minion being destroyed by its own hit points, with a one-hour lockout after destruction.

## Investigation findings

- **Phantom Mount** (graveknight, 3 actions, arcane/summon; Monster Core, two stat blocks): summons a mount as **Marvelous Mount** heightened to a rank equal to **half the graveknight's level**; unlike the spell, the steed's **AC and saving throw bonuses are all 4 lower than the graveknight's** and it has **one-third the graveknight's Hit Points (rounded down)**. If the steed is destroyed the graveknight must wait **1 hour** before using the ability again.
- **Marvelous Mount** (rank 2 spell, from the data): a Large fantastical creature, the target's minion, Speed 40 ft, bears the target and possessions, can't carry another creature; it uses the target's AC and saves in the base spell but is destroyed if it takes more than 10 damage at once (the ability overrides both with its own AC/save offsets and HP). Heightening: 3rd walk on water; 4th Speed 60 and walk on water; 5th Speed 60, walk on water and fly 60 (must end its turn on a surface or fall); 6th Speed and fly Speed 80.
- **#983's machinery.** Summoned creatures are tokens (and temporary world actors) with a summon record, added as minion combatants that never take their own turn; the summoner commands them. A fixed-creature summon looks the creature up in the compendium; this ability needs an actor built at summon time.
- **No mount model exists in the module.** PF2e has mounted-combat rules (Mount, Command an Animal), but the module's movement and Strike executors assume one token per creature.

## Resolved decisions

1. **Stat block derivation:** build from a base actor (the Marvelous Mount creature or a generic Large steed) plus offsets: AC and saves = the summoner's value − 4, HP = floor(summoner max HP ÷ 3), speeds from the heightened spell rank (half the summoner's level).
2. **Mount rules:** the graveknight rides the mount (shared position; the mount supplies Speed; the mount is the rider's minion and uses the summoner's turn actions); the spell's "destroyed if > 10 damage at once" rule is overridden by the ability's own HP; a 1-hour re-summon lockout is recorded when the steed is destroyed.

## Design

### Stat derivation (`scripts/summon-derive.mjs`, pure)

```js
deriveMountStats({ summoner, spellRank, base }) → {
  level, size: "lg", hp: { max: floor(summoner.hp.max / 3) },
  ac: summoner.ac - 4,
  saves: { fortitude: summoner.fort - 4, reflex: summoner.ref - 4, will: summoner.will - 4 },
  speeds: speedsForRank(spellRank),     // 40 / walk-on-water (3) / 60 (4) / 60+fly 60 (5) / 80+fly 80 (6)
  traits: ["summon", "minion", ...] }
```

- `spellRank = clamp(floor(summoner.level / 2), 2, 6)` (the spell's rank range; the ability says half the graveknight's level).
- "Bonuses" are the **modifiers** (`save.mod`, and AC value), computed from the summoner's prepared statistics at summon time.
- The result is applied to a **temporary world actor** created from a generic Large steed base actor (a minimal module-owned NPC template; the Marvelous Mount creature is a spell effect without a stat block), then overridden with the derived values (HP, AC, saves, speeds, size, traits). Walk-on-water is recorded as an effect/flag; the module's movement costing treats water as passable for it.
- The derivation is a pure function with unit tests (level 8 → rank 4, level 12 → rank 6, bounds).

### Summon execution (extends #983's `npcSummon` branch)

Recognition: the Phantom Mount item is an exact-match reviewed definition (fixture-checked) whose parser extracts "heightened to a rank equal to half the level", "AC and saving throw bonuses are all 4 lower", "one-third the Hit Points (rounded down)" and the 1-hour lock; anything unrecognized disables the ability (all-or-nothing). Execution:

1. Gates: 3 actions, no active mount, no lockout (`flags…mountLockoutUntil` > game clock).
2. `deriveMountStats`, create the temporary actor and token adjacent to the summoner (a free square; Large footprint), add it as a minion combatant (#983: `minionOf`, never takes its own turn).
3. **Mount the summoner:** record `flags.pf2e-dungeon-crawl.mount = { riderId, mountId }` on both, and move the summoner's token to the mount's square (the summoner's token is centered on the mount's footprint and drawn above it). Announce.

### Mount rules

- **Shared position:** the rider's and mount's tokens move together. The rider's movement executors (Stride, Step, Fly) are wrapped: when the rider is mounted, the movement uses the **mount's Speed** (and fly/swim speeds from the mount), the path is computed for the **Large footprint** (the mount's size) and applied to both tokens (`{ teleport: true }` for the secondary token after the primary moves, to keep them in lockstep).
- **Actions:** the mount is the summoner's minion; it takes no turn of its own. Actions "the mount takes" are the rider's movement actions (the mount's Speed). The rider's Strikes and abilities are its own.
- **Targeting:** attacks against the rider hit the rider's AC; attacks against the mount (either token) use the mount's AC and HP. The mount is a legal target but attackers choose by the normal rules; area effects hit both if the footprints overlap.
- **Dismount:** the rider dismounts (a free action in the module's flow) when the mount is destroyed, dismissed, or when the rider is knocked prone/unconscious: the rider's token is placed on the mount's square or the nearest free square, and the mount flag is cleared.
- **Destruction:** when the mount's HP reaches 0 it is destroyed (token removed after the defeat seam), the rider is dismounted (falls Prone if the mount was flying, with falling damage via the system if over a hazard: a planning detail), and `mountLockoutUntil = now + 1 hour` is recorded on the summoner's actor via the game clock (#785). The spell's ">10 damage at once" rule does not apply (overridden by the ability text).

### Vocabulary and lifetime

`npcSummon` entry for Phantom Mount with a deterministic summary ("Summon a steed (rank 4, HP 19, AC 23, Speed 60, walks on water) and ride it"). The mount persists until destroyed or the combat ends; there is no duration. At combat end the temporary actor and token are cleaned up with the other summons (#983).

### Reporting

#925 records the summon, the derived stats and mount/dismount events.

## Error handling

- Derivation errors (missing summoner stats): the ability is not offered.
- No room for a Large token adjacent to the summoner: not offered.
- A mounted summoner whose mount token is removed: automatically dismounted.
- Lockout on the game clock unavailable: treated as unlocked once per combat.

## Testing

- **Derivation:** AC/saves offsets, HP thirds (rounding down), rank → speeds table, bounds.
- **Summon:** creates a minion combatant with derived values; lockout and "one mount at a time" gates; recognition fixture.
- **Mount movement:** the rider uses the mount's Speed; both tokens move together; dismount on destruction/prone; falling mount.
- **Destruction:** removal, lockout timestamp, re-summon blocked for an hour and available after.
- **Live verification:** a graveknight summons a steed and rides it across the room; destroying the steed dismounts it.

## Explicitly out of scope

- Mounts for player characters or other summoners (the derivation function is reusable for other spell-derived creatures).
- Command an Animal / full PF2e mounted-combat action economy.
- Companions that act independently (#983's minions are commanded).

## Open questions

None. Planning-time details: the generic Large steed base actor, falling rules for a flying mount destroyed mid-air, and the drawing order of stacked tokens.
