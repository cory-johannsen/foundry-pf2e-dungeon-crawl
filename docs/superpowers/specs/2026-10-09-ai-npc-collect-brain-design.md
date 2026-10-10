# Advanced AI NPCs: Multi-Step Corpse Abilities (Collect Brain)

**Issue:** #1062 — multi-step corpse abilities (Collect Brain), deferred from #982.

**Builds on:** #982 / `docs/superpowers/specs/2026-10-09-ai-npc-corpse-abilities-design.md` (the corpse record on the token document, `scripts/corpses.mjs` queries, consumed-by tracking), #934 (self-heal executor, closed requirement predicates), #928 (NPC self-heals), #935 (timed conditions), #959 (`applyDefeatIfReducedToZero` seam), #925.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

The jah-tohl's **Collect Brain** extracts a brain from a creature within reach that died within the last minute, then heals 20 HP when the jah-tohl later spends an Interact action to secure the brain in an empty blister. This spec adds a **two-step sequence with a pending-state record** between the actions: Collect Brain records a *held brain*, and a separate **Secure Brain** candidate (an Interact) performs the heal and fills a blister. It also models the jah-tohl's **Brain Blisters** (Stupefied equal to the number of empty blisters) and **Brain Loss** (a save on big hits destroys a blister) so the heal and the penalty stay coherent.

## Investigation findings

From the compendium (jah-tohl, Monster Core).

- **Collect Brain** (1 action, manipulate): "extracts the brain of a creature within its reach that has been dead for no more than 1 minute. It can then use an Interact action to secure the brain in one of its empty brain blisters and heal `20` Hit Points."
- **Brain Blisters** (passive): seven blisters house stolen brains; a jah-tohl without all seven filled is **Stupefied** with a value equal to the number of empty blisters.
- **Brain Loss** (passive): if the jah-tohl takes 30 damage from a critical hit or 25 mental damage, it must succeed at a DC 26 save (Fortitude for the critical damage, Will for the mental damage) or one of its blisters is destroyed (a destroyed blister can no longer hold a brain, so the count of usable blisters falls).
- **#982 provides the corpse record** (`diedAtWorldTime`, position, name, level, traits, `consumedBy`) written at the defeat seam, plus pure queries (`corpsesWithinReach`, window checks on the game clock). A one-minute window uses the same record with a 60 s limit.
- **Nothing tracks a "pending" ability state.** The agent turn state holds the action budget and MAP; there is no place for "the next Interact action completes X". The effect has no lasting duration: the brain is held until secured, a state the module must record.

## Resolved decisions

1. **Two entries tied by a pending-state record:** *Collect Brain* creates a `heldBrain`; *Secure Brain* is a separate Interact candidate that heals 20 HP and fills a blister. No combined action (RAW has separate actions).
2. **Model Brain Blisters** (a per-jah-tohl blister counter with Stupefied N = number of empty blisters) **and Brain Loss** (a save on large hits destroys a blister).

## Design

### State (`flags.pf2e-dungeon-crawl.brainState` on the jah-tohl's actor)

```json
{ "filled": 4, "destroyed": 0, "heldBrain": { "fromCorpse": "Token.xyz", "name": "Goblin Warrior", "collectedAt": 1840 } }
```

- `filled` starts at a default for generated jah-tohls (a reviewed table: full seven for a fresh encounter unless the generator says otherwise; stored once at spawn). `destroyed` counts destroyed blisters. Empty blisters = `7 − filled − destroyed`.
- The condition **Stupefied N** with `N = empty blisters` is maintained by the module: on any change to `filled`/`destroyed`, the helper sets or removes a tagged Stupefied condition (#914 tag, source "brain-blisters") so it follows the count.
- `heldBrain` is at most one. It is cleared when secured, when the jah-tohl dies, and at combat end (a held brain does not persist outside the encounter).

### Collect Brain (`corpseStep1`)

- **Eligibility:** a corpse record (#982) within the jah-tohl's reach with `now − diedAtWorldTime ≤ 60 s` and not in `consumedBy`, no existing `heldBrain` (one at a time), at least one empty, non-destroyed blister, 1 action.
- **Effect:** add the `consumedBy` marker (`<actor>:collect-brain`), write `heldBrain`, announce ("The jah-tohl pries a brain free"), no healing yet.

### Secure Brain (`corpseStep2`, a synthetic Interact candidate)

- **Candidate:** a vocabulary entry `{ type: "npcSelf", kind: "interactFollowUp", slug: "collect-brain-secure", cost: 1 }` offered only while `heldBrain` exists, an empty blister exists, and an action is affordable. The summary states the payoff: "secure the brain: +20 HP, Stupefied N → N−1".
- **Effect:** `filled += 1`; heal 20 through the #928/#934 heal executor (capped at max HP); clear `heldBrain`; refresh the Stupefied helper.
- **Time pressure:** the brain does not decay (the text sets no limit); the candidate stays available until used or the combat ends.
- **Heal gating:** the heal is part of this follow-up only; Collect Brain itself never heals (RAW: "It can then use an Interact action").

### Brain Loss (passive reaction to damage)

At the damage seam (#959's `applyDamage` hook / `updateActor` fallback): for a jah-tohl target, if the application is a **critical hit totaling 30 or more** (read from the damage context's outcome and total) or **mental damage totaling 25 or more**, roll Fortitude DC 26 (critical) or Will DC 26 (mental) through #915's save executor; on failure (a "succeed or ..." text means any non-success), `destroyed += 1`; if a filled blister is destroyed, `filled −= 1` first (a filled blister is lost before an empty one), then refresh Stupefied. Idempotent per damage application; announced publicly.

### Reporting and vocabulary

Both entries report through #925 ("collects a brain"; "secures the brain"). The vocabulary builder (`buildNpcSelfVocabulary`, #934) gets the `interactFollowUp` kind; the pending state also appears in the candidate context (a `pending: "heldBrain"` hint) so the model understands Secure Brain follows Collect Brain.

## Error handling

- Corpse record missing, outside the window, or already consumed: Collect Brain is not offered.
- Held brain with no empty blister (blister destroyed): Secure Brain is not offered; the held brain stays until combat ends.
- A jah-tohl removed from combat: state cleared.
- Stupefied helper errors never block the action; they are logged.

## Testing

- **Eligibility:** Collect Brain gates (reach, 60 s window, consumed, held, no empty blister); Secure Brain gates.
- **Sequence:** Collect then Secure heals once (20 HP, capped), `filled` increments, Stupefied decrements, `heldBrain` cleared; Secure without Collect is not offered.
- **Brain Loss:** thresholds (30 critical, 25 mental), the correct save, destroyed/filled accounting, idempotence.
- **Stupefied helper:** value follows the empty count; removed at zero.
- **Live verification:** a jah-tohl collects a brain from a freshly killed ally-of-the-party's victim and secures it next action; the Stupefied value on its sheet changes.

## Explicitly out of scope

- Other corpse abilities (#1063 corpse-targeting damage/save abilities; #1064 dying-creature abilities).
- A decay timer for the held brain (the text has none).

## Open questions

None. Planning-time detail: how generated jah-tohls are seeded with filled blisters (default all seven unless the generator says otherwise).
