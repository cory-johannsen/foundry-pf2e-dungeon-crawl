# Advanced AI NPCs: Corpse-Targeting Damage and Save Abilities

**Issue:** #1063 — corpse-targeting damage and save abilities (Necro Puppeteer, Ravenous Repast, Font of Death), deferred from #982.

**Builds on:** #982 / `docs/superpowers/specs/2026-10-09-ai-npc-corpse-abilities-design.md` (the corpse record, `scripts/corpses.mjs` queries, consumed-by tracking), #1062 / `docs/superpowers/specs/2026-10-09-ai-npc-collect-brain-design.md` (pending-state records between actions), #915 (area save executor, template geometry), #932 (movement executors), #933 (Strike shapes), #935 (outcome model), #925.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

Three NPC abilities target a corpse (or a dying/undead creature) and then produce a template, a check or a transformation: **Necro Puppeteer** (resurrection dragon), **Font of Death** (tomb giant) and **Ravenous Repast** (ravener husk). All three reuse #982's corpse records and #915's template/save executors, with a small amount of per-ability state. The ravener husk's transformation is implemented by swapping the combatant's actor.

## Investigation findings

From the compendium (Monster Core 2).

- **Necro Puppeteer** (resurrection dragon, ancient spellcaster and one other; 2 actions, divine/void): "siphons energy into an undead creature, a dying creature, or a corpse they can see within 60 feet. The dragon moves the target creature 30 feet and causes it to unleash a wave of void energy in a 10-foot emanation, dealing `6d8` void damage (basic Reflex DC 32)."
- **Font of Death** (tomb giant; 3 actions, concentrate/unholy/void): touches a creature that died within the past 24 hours, infusing it with void energy; **once during the next hour** the giant can spend a single action (from any distance) to release the void from the corpse in a **15-foot burst** of `10d8` void damage (basic Fortitude DC 32); if not released before the hour ends the energy dissipates; the giant can't use Font of Death while a previous corpse remains infused.
- **Ravenous Repast** (ravener husk; 3 actions, divine, once per day): "makes a jaws Strike against a deceased creature that has been dead no longer than 1 minute, was holy, and was at least level 15 in life. The ravener attempts a flat check (DC 5); if successful, they transform back into a ravener with 1 Hit Point in their soul ward."
- **#982 corpse record** carries `diedAtWorldTime`, position, `name`, `level`, `size`, `traits` (including `holy`) and `consumedBy`; the pure queries support reach, range (60 ft) and time windows (1 minute, 24 hours). Corpses move only with the token: a moved corpse updates the token position, which is the record's position.
- **#1062 precedent** for a state written by one action and completed by a later one (`heldBrain`); Font of Death's infused corpse is the same shape with a 1-hour clock and a distance-free release.
- **Existing machinery.** #915's area executor (emanation/burst templates, per-creature saves, basic-save damage), #932's push/move helpers (`{ teleport: true }` for non-colliding moves), #933's Strike executor for a jaws Strike against a target, the combatant's actor replacement is not an existing helper (new here).

## Resolved decisions

1. **All three abilities in scope.**
2. **Ravenous Repast transforms by swapping the combatant's actor** to the ravener (initiative and position kept; the soul-ward 1 HP noted).
3. **Corpse records and #915's template/save executors are reused;** per-ability state lives in small flags.

## Design

### Necro Puppeteer (`corpseMoveBlast`)

- **Eligibility:** the dragon can see a legal subject within 60 ft: an **undead** creature (any side), a **dying** creature (dying condition > 0), or a **corpse** (token with a #982 corpse record). 2 actions; recharge/frequency per the item (none stated).
- **Choice:** Foundry enumerates subjects × destinations; the destination is the square 30 ft (or less if blocked) along a straight line that maximizes `enemies in the 10-ft emanation − allies`. The model picks among the best few (#909 pipeline).
- **Execution:** move the subject 30 ft (token update with `{ teleport: true }` to avoid wall-collision constraints; a corpse is moved by updating its defeated token's position and corpse record); then run #915's area executor for a 10-ft emanation centered on the subject, `6d8` void, basic Reflex DC 32, against **every creature in the emanation** (the subject, if a creature, is included as RAW "unleash a wave" does not exclude it; the subject itself is affected only if the text says; the module excludes the subject from damage when it is a corpse and includes it when an undead or dying creature that is not the dragon's ally—left to planning as a reviewed rule; default: the subject is not a target of its own wave). Announce.
- Allies in the emanation are affected as RAW (the text says "dealing damage" in an emanation); the ranking accounts for it.

### Font of Death (`infuseCorpse` + `releaseCorpse`)

- **Step 1 (3 actions, touch):** subject = a corpse record within reach with `now − diedAtWorldTime ≤ 24 h` and not already infused; the giant has no current infusion (`infusedCorpse` absent). Effect: write `flags.pf2e-dungeon-crawl.infusedCorpse = { tokenId, infusedAt, expiresAt: infusedAt + 3600 }` on the giant's actor and a visual marker on the corpse token (an effect or tint). Announce.
- **Step 2 (1 action, any distance):** a synthetic `releaseCorpse` candidate offered while `infusedCorpse` is active and the corpse still exists: run #915's area executor for a 15-ft burst centered on the corpse, `10d8` void, basic Fortitude DC 32, against every creature in the burst. Clear `infusedCorpse`. Offered only if the burst would hit at least one enemy (the ranking prefers enemies hit, minus allies).
- **Expiry:** the infusion is cleared when `expiresAt` passes on the game clock (#785) or at combat end; a dissipated infusion ends the lock on Font of Death. If the corpse token is deleted or moved away from the scene, the infusion is cleared.

### Ravenous Repast (`corpseStrikeTransform`)

- **Eligibility:** a corpse record within the husk's reach with `now − diedAtWorldTime ≤ 60 s`, trait `holy`, `level ≥ 15`; frequency once per day (#910 store); 3 actions.
- **Execution:** a jaws Strike against the corpse (the corpse is defeated; the module's Strike executor needs a non-living target: an attack roll against the corpse's AC is made as for an object, using the record's level to derive a standard AC if the actor is gone; the Strike's hit/miss is reported), then a flat check DC 5 via `new Roll("1d20")` (success on 5+); on success transform:
  - **Transform helper (`scripts/combatant-transform.mjs`):** replace the combatant's actor with the ravener actor (looked up by name in the compendium; the husk's current HP is replaced by the ravener's, noting "1 Hit Point in their soul ward" as an effect with the same text), preserving the token's position, initiative and combatant id (update the token's `actorId` and the combatant; clear the husk-only effects). If the lookup fails, the transformation is skipped and the GM is told.
  - Announce. The ravener's own abilities become available from the next candidate build.
- If the flat check fails, the Strike and the corpse use are spent (consumed-by marker), the transformation does not occur.

### Vocabulary

Each is a `npcAbility`/`npcStrike`-style entry with deterministic summaries ("moves a corpse 30 ft and blasts 6d8 void in 10 ft (≈2 enemies, 0 allies)"; "infuse a fresh corpse"; "release the infused corpse: 10d8 void burst (≈3 enemies)"; "feed on a holy corpse and attempt to become a ravener (flat DC 5)"). Entries use #982's corpse queries for legality and #981-style area placement for centering.

## Error handling

- Corpse record missing or consumed: the ability is not offered.
- Destination blocked/off-scene: the move uses the nearest legal square; none → not offered.
- Infusion lost (token deleted): cleared silently with a debug line.
- Actor swap failure: transformation skipped, GM warning, Strike still reported.

## Testing

- **Necro Puppeteer:** subject legality (undead/dying/corpse), 60 ft range, destination ranking, move + emanation save, corpse record position update.
- **Font of Death:** infusion gates (24 h window, one at a time), release candidate, burst save, expiry on the game clock, token deletion.
- **Ravenous Repast:** eligibility (holy, level ≥ 15, 1 minute), once per day, flat check success/failure, actor swap preserving position/initiative, lookup failure.
- **Fixtures:** each item's text matches; changed text disables its definition.
- **Live verification:** a resurrection dragon hurls a corpse into a cluster of PCs; a tomb giant infuses a corpse and detonates it next turn.

## Explicitly out of scope

- Other corpse abilities (#982, #1062, #1064).
- Generic creature-transformation (this spec adds only the helper Ravenous Repast needs).
- Detecting "dying" creatures beyond the dying condition.

## Open questions

None. Planning-time details: whether the Necro Puppeteer subject is included in its own wave (default: not), the ravener compendium lookup, and the corpse AC derivation.
