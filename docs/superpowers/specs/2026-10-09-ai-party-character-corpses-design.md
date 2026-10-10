# Advanced AI Actors: Corpses of Dead Party Characters

**Issue:** #1065 — corpses of dead party characters, deferred from #982.

**Builds on:** #982 / `docs/superpowers/specs/2026-10-09-ai-npc-corpse-abilities-design.md` (the corpse record on the token document, `scripts/corpses.mjs` queries, consumed-by tracking, the defeat seam plus `updateCombatant` fallback), #1062 / #1063 / #1064 (other corpse and dying abilities), #959 (defeat seam), #925.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#982 treats only defeated monsters as corpses. This spec lets a **dead party character leave a corpse that monsters can feed on** (Consume Flesh, Feed and the other corpse abilities), behind a **world setting** (default on) so tables that do not want it can opt out. The PC's death is detected from the system's own dead state, the corpse record is written like a monster's, and resurrection is left to the rules: the module records that the corpse was fed on and warns the GM, but does not block raise dead or similar effects.

## Investigation findings

- **#982's record** is a flag on the defeated NPC's token document (`diedAtWorldTime`, position, name, level, size, traits, `consumedBy`), written idempotently at the module's `applyDefeatIfReducedToZero` seam for NPC targets and by an `updateCombatant` fallback for system-applied defeats. It survives loot conversion and is cleaned up with the token.
- **How a PC dies in PF2e.** A character reaches 0 HP and gains Dying (and Wounded); when the dying value reaches the death threshold (4 minus Doomed) the character is dead; the system applies the `dead` state (a "dead" status/overlay on the token and the actor flagged dead, typically via the defeated combatant and the dead condition/`isDead`). The system and the player may also resolve this through Hero Points (recovery), Treat Wounds, etc.
- **Party tokens persist.** Unlike hostile NPCs, party character tokens are not deleted at combat end; a dead PC's token stays on the scene until a GM or a resurrection changes it, so the record can live on the same token document and survive across encounters in the dungeon.
- **Resurrection.** PF2e resurrection effects (raise dead, resurrect, etc.) bring a creature back to life with specific limits (time since death, body condition); consuming flesh is not a rule barrier by itself, but a GM may rule a ravaged body impairs it. The module should not decide that.
- **Opt-out.** Many tables avoid having monsters devour player characters; #1064's owner decision already allows consequential soul abilities on dying PCs, so a corpse opt-out is the matching escape hatch for this feature.

## Resolved decisions

1. **Yes, dead party characters leave corpses**, controlled by a world setting `Dead party characters leave corpses` (default **on**).
2. **Resurrection stays RAW:** feeding on a PC corpse records a consumed-by marker and posts a GM-visible warning that the table may rule it impairs resurrection; the module never blocks a resurrection.
3. **Detection:** the system's dead state / dying reaching the death threshold, via the module's defeat seam plus an `updateActor`/`updateItem` fallback (the two-path pairing #959/#982 use).

## Design

### Setting

`deadPcCorpses` (world, GM, boolean, default `true`). When false, no PC corpse record is written and existing PC records are ignored by corpse queries (they are not deleted, so toggling back on restores them).

### Detection and record

A PC death is recognized when any of:

- the module's defeat seam observes a party-character target reaching dead (`dying` value ≥ death threshold, or the actor gains the `dead` condition), or
- an `updateItem` hook fires for the `dying`/`dead` condition on a party character, or an `updateActor` hook sees `system.attributes.hp.value ≤ 0` with the dead status in `actor.statuses`,
- (idempotent: the record is never overwritten once present).

On detection (setting on), write the corpse record on the PC's token document (one per scene token of the actor; for actors with several tokens, each gets the record):

```json
{ "diedAtWorldTime": 1840, "round": 3, "x": 1200, "y": 1500,
  "name": "Fighter", "level": 5, "size": "med", "traits": ["human", "humanoid"],
  "creatureType": "humanoid", "consumedBy": [], "pc": true }
```

`pc: true` lets the queries and announcements distinguish party corpses.

### Queries (`scripts/corpses.mjs` extension)

`corpsesWithinReach` and the time-window checks accept an `{ includePcs }` flag set from the setting. The "creature type" of a PC corpse is derived from its traits (a PC may be humanoid, elf, etc.), so abilities that require a "living humanoid" or "holy" corpse evaluate correctly. The `consumedBy` set works as for monsters (one use per ability per corpse).

### Interaction with the corpse abilities

- All corpse abilities (#982 Consume Flesh and Feed, #1062 Collect Brain, #1063 Font of Death and Necro Puppeteer, Ravenous Repast) treat a PC corpse like a monster corpse when the setting is on. The candidate summary marks it "(a fallen party member)" so the model's reasoning and the GM log see the stakes.
- When a monster feeds on a PC corpse, the module posts a public line ("The ghoul feeds on Fighter's remains") and a GM-only whisper: "Fighter's body has been fed on; consider whether it affects resurrection." The `consumedBy` marker is recorded.

### Resurrection and removal

- When a dead PC is revived (the dead state removed, HP > 0, or a resurrection effect applied), the corpse record is cleared by the same `updateActor`/`updateItem` hooks, and `consumedBy` is dropped (the creature is alive again; the table decides the narrative).
- When the PC token is deleted, the record disappears with it.
- The 1-minute/1-hour/24-hour windows keep ticking on the game clock; a record older than every ability's window is harmless and stays until the PC is revived or the token removed.

### Reporting and opt-out

Announcements follow #982's wording. With the setting off, nothing in this spec runs (no record, no queries including PCs, no announcements).

## Error handling

- Detection without a token on the scene: no record (nothing to feed on); logged at debug level.
- Duplicate hooks: idempotent writes.
- Setting toggled mid-combat: queries read the setting at call time; records are not rewritten.
- A PC revived while a monster is mid-ability: the ability aborts unspent via the usual target re-check.

## Testing

- **Detection:** the dead transition via the seam and via each fallback; idempotence; setting off writes nothing.
- **Queries:** `includePcs` honored; windows and consumed-by for PC corpses; traits-derived types.
- **Abilities:** a corpse ability is offered against a PC corpse with the setting on and not with it off; summary marks the fallen member; consumed-by recorded; GM whisper.
- **Resurrection:** revival clears the record; a revived PC is not a corpse target.
- **Live verification:** a PC dies in combat; a ghoul feeds on the body; the chat/whisper are as described; toggling the setting off prevents it.

## Explicitly out of scope

- Blocking or modifying resurrection (a table ruling).
- Corpses for allied NPCs or summons (they follow monster rules already).
- Cosmetic corpse visuals beyond the existing dead overlay.

## Open questions

None. Planning-time details: the most reliable system signal for "dead" in the installed PF2e version and the setting's label text.
