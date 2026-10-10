# Advanced AI NPCs: Other-Creature Death-Triggered Reactions

**Issue:** #1019 — other-creature death-triggered NPC reactions (Soul Feast, Preserve Prey, Reawaken!, Responsive Recovery, Material Leap, Scuttle Away), deferred from #959.

**Builds on:** #959 / `docs/superpowers/specs/2026-10-09-ai-npc-death-reactions-design.md` (the `reducedToZero` trigger, `applyDefeatIfReducedToZero` seam, `updateActor` fallback, `deathReactionHandled`, always-automatic policy), #931 (`REACTION_DEFS`, `resolveReactions`, `markReactionUsed`), #935/#915 (healing, conditions, timed effects), #925 (result descriptor).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#959 handles death reactions where the reactor itself is the creature dropping (Ferocity, Strike-before-dying, Self-Destruct). A second group triggers when a **different** creature dies or drops to 0 HP. This spec adds a **subject model** to the reaction registry — "which creature, in what relation and range, seen or sensed" — and five reactions on top of it: **Soul Feast**, **Responsive Recovery**, **Preserve Prey**, **Reawaken!** and **Material Leap**. **Scuttle Away** (the ostovite's chariot) is filed as #1156.

## Investigation findings

Read from the Monster Core / Bestiary 3 data.

- **Soul Feast** (lifeleecher brawler, reaction, divine/void): trigger "a creature adjacent to the lifeleecher dies"; effect: regain `2d8` HP.
- **Responsive Recovery** (lawbringer warpriest, reaction): trigger "one of the lawbringer's allies is reduced to 0 Hit Points"; requirement: a heal spell prepared; effect: "before the ally falls unconscious or dies, the lawbringer Strides toward them and casts a 2-action Heal targeting the ally. The ally remains standing."
- **Preserve Prey** (zecui, reaction): trigger "a living creature within 30 feet is reduced to 0 HP"; the creature still goes unconscious but does not gain dying; while unconscious the residual energy attempts to counteract vitality healing it receives with a `+15` counteract modifier.
- **Reawaken!** (resurrection dragons, reaction, divine/spirit/vitality): trigger "a living creature the dragon can see dies"; the willing creature returns to life, stabilized at 0 HP; a creature can be resurrected this way only once.
- **Material Leap** (namorrodor, reaction): requirement the namorrodor is on the Shadow Plane; trigger "a creature the namorrodor can sense with its lifesense on the Material Plane dies"; effect: leap to the Material Plane within 100 feet of the creature for 24 hours, then recalled.
- **Scuttle Away** (ostovite, reaction): trigger "the ostovite's bone chariot is destroyed"; Step or Stride. Needs the chariot linkage (#1156).
- **The seam exists.** #959 runs reactions inside `applyDefeatIfReducedToZero` and from `updateActor` for system-applied damage; it currently passes the reactor itself as the subject. The same seam sees every creature that drops, so other-creature triggers need only the subject model and per-reaction effects.

## Resolved decisions

1. **Reactions modeled:** Soul Feast, Responsive Recovery, Preserve Prey, Reawaken!, Material Leap. Scuttle Away is deferred (#1156).
2. **Subject model:** a declarative `subject` filter on each registry definition, evaluated against the creature that dropped.
3. **Policy:** always automatic and public, as #959 (deterministic eligibility, no confirmation).

## Design

### Trigger and subject model (`scripts/npc-reactions-death.mjs`)

The `reducedToZero` trigger event now carries `{ subject, kind: "reducedToZero" | "died", cause }` where `subject` is the combatant that dropped. #959's own definitions keep `subject: "self"`. New definitions carry:

```js
subject: {
  relation: "ally" | "enemy" | "any",
  within: { feet: 30 } | "adjacent",
  perception: "see" | "sense" | "none",     // line of sight / lifesense, using detectableOpponents helpers
  alive: true,                               // the subject was a living creature
  trigger: "reducedToZero" | "died",
}
```

`subjectMatches(def, reactor, subject, combat)` is pure over plain data: relation via the module's disposition/team helper, distance via `chebyshevSquares` in feet, perception via the existing line-of-sight/detection helpers, `alive` from the subject's traits (`undead`, `construct`, `spirit` etc. make it non-living). A reactor never triggers on itself unless `relation` allows. The shared gates (agent-controlled, reaction item present, reaction unused this round, `deathReactionHandled`) remain.

### The five reactions (new kinds in the registry table)

| Reaction | Kind | Subject filter | Effect |
|---|---|---|---|
| Soul Feast | `healOnDeath` | any creature, adjacent, died | Regain the parsed healing (`2d8`) via the heal executor; announced publicly |
| Responsive Recovery | `saveAlly` | ally, any distance reachable by Stride+cast, reducedToZero | Requires a prepared heal spell; Stride toward the ally, cast Heal (2-action) on the ally; the ally's defeat is cancelled for this drop |
| Preserve Prey | `preserveDowned` | living, within 30 ft, reducedToZero | The subject stays unconscious at 0 HP with no dying condition; sets a `preservePrey` marker with the counteract modifier for later healing |
| Reawaken! | `resurrect` | living, seen, died | Return the willing subject to life stabilized at 0 HP, once per creature (marker) |
| Material Leap | `planarLeap` | any, sensed, died, reactor on the Shadow Plane | Move the reactor to the Material Plane within 100 ft of the subject; recall after 24 hours |

All five are exact-match reviewed definitions: the item name and trigger text are fixture-checked, and the effect parser must consume every sentence (all-or-nothing) as in #959.

### Effects

- **Soul Feast:** parse `@Damage[2d8[healing]]`; roll and apply through the existing NPC self-heal path (#928), capped at max HP.
- **Responsive Recovery:** check a prepared heal spell on the reactor; Stride by the shortest legal path to a square adjacent to or within 30 ft of the ally (Heal's range), then cast Heal as a 2-action spell on the ally. The ally's HP is raised by the heal's roll; since the reaction fires "before the ally falls", the seam returns `cancelDefeat` for the subject and the ally stays standing (no unconscious or dying). If no path or no prepared heal, the reaction is not offered.
- **Preserve Prey:** set the subject to unconscious without `dying` (the seam applies defeat as usual but suppresses the dying condition), and record `flags.pf2e-dungeon-crawl.preservePrey = { reactorId, counteractModifier: 15, round }` on the subject. Healing the subject afterward rolls `1d20+15` against the vitality healing's counteract level; the check is implemented as a note on vitality heal results and applied through the existing counteract helper when one exists, else announced for the GM to resolve (a documented limitation).
- **Reawaken!:** only if the subject is not already marked `resurrectedBy`; set HP to 0, remove dead/defeated state, apply the stabilized state (unconscious, not dying), mark `flags.pf2e-dungeon-crawl.resurrected = true`. "Willing creature": player characters are always treated as willing; NPC subjects are resurrected only if they are allies of the reactor.
- **Material Leap:** requires `scene.flags.pf2e-dungeon-crawl.plane === "shadow"` for the reactor's scene (the module's own plane tag; dungeons the generator builds carry no plane, so this definition is offered only on scenes explicitly tagged). The leap teleports the reactor (with `{ teleport: true }`, #141) to a free square within 100 ft of the subject on the paired Material-Plane scene when a pairing exists (`scene.flags…planePair`); with no pairing it announces the leap for the GM to resolve and does not move the token. The 24-hour recall is a world-clock timer stored on the token.

### Timing

Runs at the same two seams as #959: inside `applyDefeatIfReducedToZero` (before defeat) and from `updateActor` for system-applied damage. `died` triggers (Soul Feast, Reawaken!, Material Leap) run after defeat is applied. `deathReactionHandled` is keyed by `(subjectId, reactorId, round)`.

## Error handling

- Subject token missing or off-scene: reaction not offered.
- Multiple eligible reactors: each reacts at most once per round in priority order (one per reactor); a subject can be saved by only one Responsive Recovery.
- Any failure during an effect aborts the reaction without marking it used and never blocks defeat.

## Testing

- **Subject model:** relation, adjacency/range, perception, alive and trigger filters on fixtures; a reactor never triggers on itself unless allowed.
- **Effects:** each of the five with mocked Foundry (healing roll, Stride + heal, dying suppression and marker, resurrection once only, planar leap with and without a paired scene).
- **Parser/fixtures:** the five items match their fixtures; changed text disables the definition.
- **Seam interaction:** reactions do not double-fire between the module seam and the `updateActor` fallback.
- **Live verification:** a lifeleecher heals when an adjacent creature dies; a lawbringer's ally stays standing after a lethal hit; a zecui keeps a downed PC unconscious without dying.

## Explicitly out of scope

- Scuttle Away (chariot linkage) — #1156.
- General counteract automation for Preserve Prey beyond the note described above.

## Open questions

None. Planning-time details: the existing counteract helper (if any), how scenes get a plane tag, and the exact reaction priority order.
