# Advanced AI Actors: Magus and Gunslinger Feat Actions (Spellstrike and Firearm State)

**Issue:** #997 — Magus and Gunslinger targeted feat actions (need Spellstrike and firearm state), deferred from #947.

**Builds on:** #947 / `docs/superpowers/specs/2026-10-09-ai-actor-targeted-feat-actions-no-selfeffect-design.md` (shapes, override table, `targetedAction` kind, per-turn flourish/finisher tracking, the class set), #933 (Strike-plus shapes), #934 (closed requirement predicates), #915/#935 (save and degree outcomes), #992 / `docs/superpowers/specs/2026-10-09-ai-actor-stateful-feat-requirements-design.md` (tracked-state layer and closed-world rule), #909 (candidate pipeline), #925 (result descriptor).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#947 adds `magus` and `gunslinger` to nothing: their feats depend on state the module does not track. This spec adds two **tracked-state families** and the **feat coverage** that sits on top of them:

- **Magus:** a Spellstrike charge record (which spell is stored, whether it is spent), Spellstrike itself as an AI candidate (so the state is actually produced in play), the Spellstrike-variant feats (Distracting, Shattering, Devastating, Lunging, Meteoric, Dispelling ...), and charge-dependent feats (Spell Swipe, Cascading Ray, Arcane Shroud ...).
- **Gunslinger:** per-weapon loaded/unloaded and wielding state, reload actions as candidates (including free reloads), flourish/press/finisher chains, and the firearm Strike-plus feats (Phalanx Breaker, Dazzling Bullet, Scatter Blast, Paired Shots, Penetrating Fire ...).

All of it follows #947/#992's rule: a feat is offered only if every requirement is checkable and true from the module's recorded or system-owned state.

## Investigation findings

- **Population.** Activatable magus feats/actions without a `selfEffect`: about 19 (Magus's Analysis, Raise a Tome, Devastating/Distracting/Shattering Spellstrike (level 4, 2 actions), Spell Swipe (8, 3 actions), Cascading Ray, Lunging/Meteoric Spellstrike, Unsheathing the Sword-Light, Overwhelming/Dispelling Spellstrike, Whirlwind Spell, ...). Gunslinger: about 40 (Cover Fire, Warning Shot, Risky/Ostentatious/Running Reload, Paired Shots, Phalanx Breaker, Scatter Blast, Sniper's Aim, Called Shot, Penetrating Fire, Trick Shot, Headshot, Final Shot, ...).
- **No Spellstrike state exists anywhere.** `pf2e.mjs` has no Spellstrike charge tracking; the system's `Spellstrike` activity is descriptive only, and the module has no Spellstrike handling. The state must be module-owned (a combat flag plus effect items where the system has them, such as `Stance: Arcane Cascade`).
- **Firearm state is partly system-owned.** The system stores per-weapon `system.ammo` (value/capacity, `builtIn`), exposes a reload UI and an item reload path (`Reloader` strings). So loaded/unloaded can be read from the weapon; the module need only do the reload action and the wielding/hands check (two-handed firearm).
- **Turn rules apply.** Flourish (once per turn), finisher (ends the turn's attacks) and press (needs a prior attack) come from #947's per-turn state. Gunslinger has many flourish feats and several finishers/presses.
- **Closed-world precedent.** #992's `agentFeatureState` record and predicate evaluation in `buildFeatVocabulary` is the home for the new state.

## Resolved decisions

1. **Everything selected:** Spellstrike charge state; Spellstrike as an AI candidate; Spellstrike-variant feats; charge-dependent non-Spellstrike feats; firearm reload/wielding state; reload candidates; flourish/press/finisher chains; firearm Strike-plus feats.
2. **State is module-owned for Spellstrike, system-read for ammo.** Spellstrike charge is stored on the combat's `agentFeatureState`; ammo is read from `system.ammo`.
3. **Closed-world** (as #992): unknown state is false; the feat is not offered.
4. **Shapes first, overrides for the rest** (as #947); magus and gunslinger are added to `FEAT_ACTION_CLASS_SET`.

## Design

### Spellstrike state (`scripts/agent-feature-state.mjs`, extends #992)

```js
spellstrike: { charged: boolean, spellId?, spellRank?, castRound?, castTurn?, recharged?: "recharge"|"conflux"|"turn" }
```

- Set when the AI's **Spellstrike** action executes (below) or a Recharge-type effect restores it; cleared when the stored Strike is made, at the end of the magus's turn when the stored spell expires per RAW, or at combat end. Spent slots follow PF2e: the spell is cast from the magus's own slot when stored.
- Predicates: `spellstrikeCharged()` and `spellstrikeChargedWith({ trait?, save?, attack? })` (from the stored spell's traits/save/attack-roll flag).

### Spellstrike as a candidate

New `feat` entry kind `spellstrike`, one per `(weapon, spell, target)` where the weapon is a legal melee Strike for the actor, the spell is a prepared/known spell the magus can cast with a one-action Spellstrike (an attack-roll or save spell with a single target, per Spellstrike's rules; spell exclusions come from an override list), and the target is in weapon reach with line of sight. Executor: spend a spell slot (or cantrip), make the Strike with the spell's effect applied on a hit per PF2e Spellstrike rules (attack-roll spell uses the Strike's roll; save spells: the target attempts the save, MAP counts once), record `spellstrike.charged = false` unless the feat/conflux in use stores it for later. Casting uses the existing spell executor (#909) so slot use, ranks and damage follow the system.

### Magus feats

- **Spellstrike variants** (Distracting, Shattering, Devastating, Lunging, Meteoric, Overwhelming, Dispelling, ...): `strikePlus` recognition cannot parse these because their riders modify a spell. They go in the **reviewed override table** with a descriptor naming the base `spellstrike` entry plus the modifier (e.g. Lunging extends reach by 5 ft for the Strike; Distracting imposes off-guard; Devastating adds the spell's damage type on crit). Each override has a fixture assertion against the item text.
- **Charge-dependent feats** (Spell Swipe, Cascading Ray, Arcane Shroud, Whirlwind Spell): the requirement `spellstrikeCharged` is added to #934's closed set; shapes and overrides as #947.
- **Rapid Recharge, Maelstrom Flow, Sustaining Steel**, and similar charge-restoring feats set `spellstrike.charged` through their descriptor.

### Firearm and crossbow state

- **Loaded state** is read from `system.ammo.value` of the wielded weapon (`ammoLoaded(weapon)`); capacity weapons use the system's current chamber.
- **Wielding** uses #934's `twoHanded`/`wieldingTrait` predicates extended with `wieldingFirearm`, `wieldingCrossbow`, `twoHandedFirearm`.
- **Reload candidates:** a new `feat` kind `reload` for the reload trait/capacity weapons: Interact to reload (cost per the weapon's reload value) and the gunslinger free-reload feats (Risky Reload, Ostentatious Reload, Running Reload, Nightwave Springing Reload, Pistol Twirl, Quick Draw) as `targetedAction`/`feat` entries with their own rule text. The executor decrements the action cost, increments `system.ammo.value`, and consumes an ammo item when applicable. Candidates are offered only when the weapon is unloaded and the actor can afford the cost.
- The Strike candidate builder already knows the weapon's ranged state; unloaded firearms stop offering Strikes (a pre-existing check this spec reuses and extends to capacity weapons).

### Flourish, press and finisher chains

Reuse #947's per-turn trait state. Gunslinger flourish feats (Risky Reload, Cauterize, Called Shot, Triggerbrand Salvo, Bullet Split, ...) check `notUsedFlourishThisTurn`; finishers end further attack candidates; presses require `previousActionWasStrike` (#946/#992). Nothing new is invented beyond adding the gunslinger feats to the class set.

### Firearm Strike-plus feats

Phalanx Breaker (two-handed firearm), Dazzling Bullet, Scatter Blast, Paired Shots, Penetrating Fire, Twin Shot Knockdown, Trick Shot and similar feats go through #947's `strikePlus` shape generalized to ranged weapons (range increment, ammo cost, `reload` interaction) or the override table when their text defies a shape. Weapon requirements use the new firearm predicates; every Strike spends ammo.

## Error handling

- Missing slot or spell: no Spellstrike entries; a stale pick fails literal membership.
- Ammo/weapon mismatch at execution (unloaded after state read): abort, action unspent.
- Spellstrike spell that fails the supported-spell check: not offered.
- A Spellstrike state left from a prior round with no matching condition is ignored by the turn/round check.

## Testing

- **State:** Spellstrike set/spent/expired; recharge feats; combat-end clear. Ammo reads from fixtures.
- **Vocabulary:** Spellstrike entries per weapon/spell/target; reload entries only when unloaded; charged-requirement feats hidden when uncharged; flourish/finisher gating.
- **Executor (mocked Foundry):** Spellstrike slot use, MAP counting, degree handling; reload increments ammo; failure paths.
- **Overrides:** fixture assertions for each override against the item text; table-completeness test for magus/gunslinger population.
- **Live verification:** an AI magus Spellstrikes a foe then uses Spell Swipe; an AI gunslinger reloads and fires Dazzling Bullet.

## Explicitly out of scope

- Non-magus Spellstrike users (archetype or mythic) — #998.
- Reloading or Spellstrike for human players (their own prompts).

## Open questions

None. Planning-time details: the list of Spellstrike-eligible spells, per-feat overrides, and the exact system API for loading a weapon.
