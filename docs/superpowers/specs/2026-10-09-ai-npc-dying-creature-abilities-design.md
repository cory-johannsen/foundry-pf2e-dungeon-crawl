# Advanced AI NPCs: Dying-Creature Abilities (Drain Soul, Trap Soul)

**Issue:** #1064 — dying-creature abilities (Drain Soul, Trap Soul) and their impact on player characters, deferred from #982.

**Builds on:** #982 / `docs/superpowers/specs/2026-10-09-ai-npc-corpse-abilities-design.md` (corpse records, queries), #1063 / `docs/superpowers/specs/2026-10-09-ai-npc-corpse-targeting-abilities-design.md`, #915 / #935 (save executor, degree outcomes, conditions), #931 (reactions registry for the soul-return rule), #959 (defeat seam), #925.

**Status:** Approved. The owner decision on player characters was made in a foreground question session on 2026-10-09 (see "Resolved decisions").

## Summary

Two NPC abilities act on a creature that is **Dying**: the soul eater's **Drain Soul** and the demilich's **Trap Soul**. With a party this means monsters devouring or trapping a dying player character's soul, with permanent consequences. **The owner decided monsters may use these on dying player characters, as the rules allow**: the module announces the stakes and applies the rules-as-written consequences, in GM and GM-less runs alike. This spec adds the dying-state targeting to the vocabulary and models the consequences and recovery rules.

## Investigation findings

From the compendium.

- **Drain Soul** (soul eater, 3 actions, death/divine/manipulate): requirement — adjacent to a Dying creature. The creature attempts a **Will DC 25** save. Critical success: unaffected. Success: **Doomed 1** (or +1 if already Doomed). Failure: Doomed 2. Critical failure: Doomed 3. A creature that dies as a result "can't be restored to life except by a spell or ritual of 8th rank or higher". If the soul eater that used Drain Soul is slain within **100 feet** of the creature's corpse and the creature has been dead no longer than **1 minute**, the soul returns to its body: restored to life, Unconscious and dying 1, no longer Doomed.
- **Trap Soul** (demilich, 1 action, once per day per gem): the activated gem casts **Seize Soul** (bind soul on a dying creature rather than a corpse). The dying creature attempts a **Fortitude DC 38** save; on a success it doesn't die and its soul isn't trapped but it is **Drained 2** (unaffected on a critical success). When a soul is trapped, the body swiftly turns to dust. The gems hold creatures up to 17th level and the demilich can later Devour a Soul it has trapped.
- **Why this is sensitive.** Doomed lowers the dying death threshold: a PC at dying 3 with Doomed 2 dies at dying 1, so the Will save and the degree directly raise the death risk of a downed party member. A trapped soul removes a PC permanently (they cannot be restored without major magic).
- **Existing pieces.** The dying condition and doomed condition are native PF2e; #915's save executor and #935's condition helpers apply degree outcomes; #959's defeat seam and #982's corpse record (which holds `diedAtWorldTime`, position, `level`, `traits`) cover the post-death rules.
- **Seize Soul.** There is no spell executor for it in the module; for Trap Soul it is modeled as a Fortitude-save ability with the outcomes above rather than a general spell.

## Resolved decisions

1. **Owner decision: monsters may target dying player characters per RAW.** Drain Soul and Trap Soul are offered against any adjacent (Drain Soul) or visible (Trap Soul) dying creature, PCs included. The stakes are announced; consequences are real and are applied in GM and GM-less runs. An optional GM-confirmation setting is filed as #1188.
2. **Consequences modeled as written:** Doomed by degree, the 8th-rank restoration restriction on a creature killed by Drain Soul, the soul-return rule when the soul eater is slain, Trap Soul's Fortitude save with Drained 2 and the body turning to dust.
3. **Targets** are adjacent creatures with `dying > 0` (PCs and NPCs); the model chooses among them with a summary that states the stakes.

## Design

### Vocabulary (`scripts/npc-dying-abilities.mjs`)

New `npcDyingTarget` entries, one per eligible target:

`{ type: "npcAbility", kind: "dyingTarget", slug, targetId, cost, summary, stakes }`

- **Drain Soul:** targets = creatures adjacent to the soul eater with the Dying condition. **Trap Soul:** targets = dying creatures the demilich can see, level ≤ 17 (gem capacity), with an available gem (frequency "once per day per gem": ten gems tracked as a count).
- `stakes` is a deterministic string shown to the model and in chat: for Drain Soul, "raises Doomed (death risk) and may cause an unrestorable death"; for Trap Soul, "traps the soul; body turns to dust (Fort DC 38)".
- Ranking: prefers targets closer to death (higher dying value, doomed present), PCs over NPCs only by that metric (no preference by side), best few to the model.
- No special filtering by controller: a dying PC is a legal target.

### Drain Soul execution

1. Will DC 25 for the target via #915's save executor.
2. Apply Doomed per degree (critical success none, success +1, failure +2... note: text: success Doomed 1 or +1; failure Doomed 2; critical failure Doomed 3) through the condition helper; "increases its doomed value by 1 if already doomed" for a success; for failure and critical failure the text says "as success, but Doomed 2/3" — treated as raising Doomed by 2/3.
3. If the target dies as a result (the system applies death when dying ≥ 4 − doomed; the module detects the transition at the defeat seam), set `flags.pf2e-dungeon-crawl.soulDrained = { by: soulEaterId, atWorldTime, restrictRank: 8 }` on the target's token/actor and mark the corpse record `soulDrained`. Public announcement and a GM whisper noting the restriction.
4. **Soul return (reaction-like rule):** a hook on defeat of the soul eater: for each corpse record with `soulDrained.by === thisSoulEater`, within 100 ft of the soul eater's position and `now − diedAtWorldTime ≤ 60 s`: restore the creature to life (remove the defeated/dead state), set Unconscious and dying 1, remove Doomed, clear the flag; announce.

### Trap Soul execution

1. Select the gem (decrement the gem count; `gemsUsed`).
2. Fortitude DC 38 for the target: critical success unaffected; success Drained 2 (the creature doesn't die); failure/critical failure: the soul is trapped — the target dies, the body turns to dust (the token is removed and a `soulTrapped` record with the creature's data is written on the demilich for the Devour a Soul ability), announced publicly with a GM whisper.
3. The "Devour a Soul" follow-up is not modeled here (the record is stored for future use).

### Reporting

#925 records `{ ability, target, degree, doomed|drained|trapped }`, with the announcement text naming the PC and the stakes.

## Error handling

- Target no longer dying at execution (healed): the action aborts unspent.
- Doomed/Drained application failure: the GM is told; the save result is still reported.
- Soul-return conditions evaluated once on the soul eater's defeat; a corpse that has been looted, moved or removed is skipped.
- A permanently dead PC is handled through the system's own death; the module adds only the flags above.

## Testing

- **Vocabulary:** adjacency/visibility, dying > 0, level cap, gems, PCs and NPCs both eligible, ranking.
- **Drain Soul:** doomed values by degree including stacking, death detection, flags, soul return (100 ft, 1 minute, restore to unconscious dying 1 without doomed).
- **Trap Soul:** save outcomes, Drained 2, soul trapped record and token removal, gem decrement.
- **Announcements:** public text names the stakes; GM whisper content.
- **Live verification:** a soul eater Drains a dying PC (Doomed increases on the sheet); a demilich traps a dying NPC ally.

## Explicitly out of scope

- GM confirmation before use on a PC — #1188.
- Devour a Soul and Seize Soul as general spells.
- Raising a drained creature (the table's resources handle that).

## Open questions

None. Planning-time details: the exact system hook to detect death-from-dying transitions and how Doomed stacking is expressed with the condition helper.
