# Advanced AI Actors: Prose-Only NPC Abilities (State Toggles and Zones)

**Issue:** #984 — zone, terrain and transformation NPC abilities described only in prose, deferred from #934.

**Builds on:** #934 / `docs/superpowers/specs/2026-10-08-ai-npc-self-buff-heal-abilities-design.md` (the `npcSelf` vocabulary entry, closed requirement predicates, condition and timed-effect application), #935 / `docs/superpowers/specs/2026-10-08-ai-npc-save-outcome-coverage-design.md` (timed conditions and effects synthesized from simple clauses, the golden-file ratchet and override-table pattern), #973 / `docs/superpowers/specs/2026-10-09-ai-npc-terrain-aware-movement-design.md` (the module's Terrain region behavior and terrain-aware pathing, which this spec extends), #983 / `docs/superpowers/specs/2026-10-09-ai-npc-summon-abilities-design.md` (the lifetime and expiry-sweep pattern), and #925's result descriptor.

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

After every other ability family, the largest remaining group of NPC actions is **prose with no machine-readable structure**: nothing to parse (no enrichers, no effect link, no `selfEffect`). A GM reads "The slurk extrudes a slippery grease … turning the affected area into uneven ground for 10 minutes" and adjudicates. The AI cannot, so these abilities are never used.

The only honest way to model them is by hand. This spec adds a **reviewed declarative table** of prose abilities: each entry is **data**, not code, composed of a small closed set of **primitive steps** (apply a condition, apply a timed effect, create a temporary terrain zone, toggle a state, post a GM note). The first slice covers two categories: **concealment and self state toggles** (Go Dark: become Invisible until the ability is used again) and **zones and terrain** (Belly Grease's uneven-ground zone, Conjure Storm's difficult-terrain aura). Transformations (#1077) and senses, communication and one-offs (#1078) are filed separately. The first batch of entries is chosen by **how many creatures carry the ability** and approved by the owner at planning time.

## Investigation findings

Confirmed against the repo and the local PF2e source data (Monster Core 1–2, Bestiary 1–3).

- **The population.** After excluding glossary-only stubs and everything the earlier ability specs cover (Strikes, saves and damage, movement, summons, corpse and heal abilities), about **190** active NPC actions across roughly **100 distinct names** remain: self state changes ~64, transformations ~52, zones/terrain/area ~40, concealment/light/illusion ~24, senses/communication ~10. Several are repeated across many creatures (Rushed Transformation 6, Drench 6, Direct Halo 6, Reef Meld 6, Jet 6, …), which is what makes a frequency-ranked table worthwhile.
- **No structure to parse.** These abilities typically have `rules: []` or only `RollOption`/`Aura` markers, no `selfEffect`, no `@Check`/`@Damage` enrichers, and prose-only effects.
- **Representative texts** (read from the data).
  - *Go Dark* (Will-o'-Wisp, 1 action): "extinguishes its glow, becoming `Invisible`. It can end this effect with another use of this action. If it uses its shock attack while invisible, the arc of electricity … making it only Hidden to all observers until it moves."
  - *Belly Grease* (Slurk, 3 actions): "coats the floor under it and in a `@Template[emanation|distance:5]` with grease, turning the affected area into **uneven ground for 10 minutes**, after which it dries to a putrid crust. The DC to Balance across the slime is 18."
  - *Conjure Storm* (Dragon Turtle, 1 action, `aura`): "The area in a 30-foot emanation around the turtle becomes **difficult terrain for all other flying and swimming creatures**. The dragon turtle can end the storm by taking this action again."
  - *Drench* (Water Scamp): puts out all fires in an emanation and counteracts magical ones — **not modelable**, because the module has no concept of fires or light sources (#1078).
  - *Hunt Prey* (Werebear): designate a prey; +2 circumstance to Seek and Track; +1d8 precision on the first hit each round; lasts until used again — a toggle plus per-hit damage, closest to #922's Hunt Prey effect but implemented by the item's own rule elements.
  - *Direct Halo*, *Quick Stow*, *Revert Form*, *Rushed Transformation*: halo/aura movement, item stowing, form changes — outside this slice.
- **What the module already offers to build on.** Condition application (`actor.increaseCondition`, #915/#935's timed-condition helper), timed effect creation with `FlatModifier` and similar rule elements (#935), the agent-effect tagging and combat-end cleanup (#914), expiry sweeps on the game clock (#983's pattern, using #785), and — from #973 — a module **Terrain region behavior** and terrain-aware pathing that reads Regions and the PF2e `environmentFeature` difficult-terrain behavior.
- **Terrain gaps in #973 these abilities expose.** #973's Terrain kinds are `water`, `lava`, `chasm`, `rubble`, `stone`, `climbable` and `ceiling`, with a global `difficult` value. Belly Grease needs an **uneven ground** kind with a **Balance DC** (moving across requires an Acrobatics check), and Conjure Storm needs difficult terrain **only for flying and swimming creatures other than the source**. This spec adds those two capabilities to the Terrain behavior (below).
- **Region documents can be created at runtime.** Foundry scenes accept embedded `Region` documents with shapes and behaviors created by a GM client, and a region can be updated or deleted later; the module already reads regions and its AI turns run on the GM client. A zone that follows a token (an aura) is kept in place by an `updateToken` handler.
- **Zones help AI pathing and the table's view, not enforcement.** The module's own movement (AI executors) honors Terrain regions through #973's cost function; players' manual moves are not blocked by regions. The value for players is that the zone is visible on the map and announced, and the GM adjudicates as usual.

## Resolved decisions

1. **First slice: concealment and self state toggles, and zones and terrain.** Transformations are #1077; senses, communication, fire and other one-offs are #1078.
2. **Authoring: a reviewed declarative table of primitive steps** (data keyed by ability name plus source, with a reviewer comment and a fixture assertion), not per-ability code.
3. **The first batch is chosen by creature count** from the coverage audit: the planner proposes the top abilities (roughly 25) that fit the primitives and the owner approves the list at planning time.
4. **PF2e rules stay the source of truth:** an entry must model everything in the text or record an explicit, owner-approved `limitations` note; nothing is silently dropped.

## Design

### The table (`data/npc-prose-abilities.json`, schema-validated)

Each entry:

```json
{
  "key": "go-dark|will-o-wisp",
  "name": "Go Dark", "source": "bestiary-3",
  "cost": 1,
  "requirements": ["notHasCondition:invisible"],
  "toggle": { "stateKey": "go-dark", "offRequirements": [] },
  "steps": [ { "op": "applyCondition", "target": "self", "slug": "invisible", "duration": "untilToggledOff" } ],
  "limitations": ["Shock attack reveal (Hidden to observers until it moves) not modeled; owner approved on #984"],
  "summary": "Go Dark: become Invisible until used again"
}
```

- Keyed by the ability's name and source book so identically named abilities on different creatures can share an entry; `appliesTo` can narrow to specific creatures when the text differs.
- A JSON schema (`data/schema/npc-prose-abilities.schema.json`) validates every entry; a validator (like the creature-art one) runs in tests and in CI.
- Every entry carries a **reviewer comment**, a **fixture assertion** (the entry's `name`, `cost` and a hash of the source description text), so a compendium change that alters the text fails a test and forces a re-review, and a `limitations` list when the text has mechanics the entry does not model.

### Primitive steps (closed set)

| `op` | Parameters | Effect |
|---|---|---|
| `applyCondition` | `target: "self"`, `slug`, `value?`, `duration` | add/increase a condition via #915/#935's timed-condition helper; `duration` is seconds, `"untilStartOfNextTurn"`, `"untilEndOfNextTurn"` or `"untilToggledOff"` |
| `removeCondition` | `target: "self"`, `slug` | remove a condition (used by the toggle's off action) |
| `applyEffect` | `target: "self"`, `rules[]` (a closed subset of rule elements: `FlatModifier`, `DamageDice`, `Resistance`, `Sense`), `duration` | create a small effect item from the listed rules via #935's helper |
| `createZone` | `shape: "emanation"\|"burst"`, `distanceFeet`, `center: "self"\|"chosenPoint"`, `terrain: { kind, difficult?, appliesToModes?, excludeSource?, balanceDC? }`, `duration`, `followsSource: boolean` | create a temporary Region carrying the module's Terrain behavior (below), with game-clock expiry or toggle-off removal |
| `note` | `text` (GM-only) | a GM whisper for adjudication of anything not automated |

There is no scripting escape hatch: an ability that cannot be expressed with these primitives is not an entry.

### Toggles

An entry with a `toggle` models abilities that "can end this effect with another use of this action". The actor's active toggles are recorded in a flag (`flags.pf2e-dungeon-crawl.activeToggles`, a list of `stateKey` + the created condition/region ids). The vocabulary offers the ability for turning **on** when no toggle is active and for turning **off** (running the inverse steps: `removeCondition`, delete the zone) when it is, as two entries with distinct summaries ("Go Dark: become Invisible" / "Go Dark: end invisibility").

### Terrain behavior extensions (to #973's Terrain region behavior)

Two small additions:

- **`appliesToModes` and `excludeSource`** on `difficult`: difficult terrain that applies only to movers using the listed modes (`["fly", "swim"]`) and not to the zone's source creature, so Conjure Storm can be expressed. #973's `cellCost` gains the mode and source checks.
- **`uneven` kind with `balanceDC`:** for AI movers, entering an uneven cell requires an Acrobatics Balance check against the DC (failure: the creature is Off-Guard until the end of its turn, a critical failure: it falls Prone and the move ends); the movement executor rolls it through the system. Players are told the DC in the zone's announcement.
- Both are recorded as extensions in #973's design notes; they change nothing for existing Terrain kinds.

### Zones at runtime (`scripts/prose-zones.mjs`)

`createZone` creates a Region with a circle or square shape matching the emanation or burst, one Terrain behavior with the step's parameters, and flags `flags.pf2e-dungeon-crawl.zone = { itemKey, sourceTokenId, createdAtWorldTime, expiresAtWorldTime | null, followsSource }`. Lifetime follows #983's pattern: expiry is checked at the start of the source's turn and at each round change (game clock, #785); a toggled-off or defeated source removes its zone; all zones are removed when the combat ends. `followsSource: true` keeps the region centered on the token: an `updateToken` handler moves the region's shape when the source moves.

### Recognition and vocabulary (`scripts/npc-prose-abilities.mjs`)

At vocabulary-build time, for each NPC action whose key matches a table entry (name plus source, with the fixture hash checked): apply #934's gates (cost vs actions remaining, `frequency.value`, recharge, the entry's `requirements` through the closed predicate set) and the toggle logic, then emit `{ type: "npcSelf", family: "prose", itemId, entryKey, name, cost, mode: "on" | "off", summary }` with the entry's deterministic summary. The per-turn cap and the #909 reasoning call are as for #934: the model chooses among offered entries and picks are validated by membership. An ability not in the table is not offered; an entry whose fixture hash no longer matches is disabled and reported by the audit until re-reviewed.

### Execution (`applyAgentDecision`, `npcSelf` branch, `prose` family)

Spend the cost, decrement frequency, record recharge, post the usage message (`item.toMessage()`), run each step in order (a failing step is logged and reported; later steps still run), record or clear the toggle state, post a GM `note` step's text, and report through #925's result descriptor listing what was applied and any `limitations` that apply to this entry.

### Choosing and reviewing the first batch

The coverage audit (the #935 pattern) is extended with a **prose-ability inventory**: every prose-only ability instance across the five source books with `{ ability, creature count, category, expressible-with-primitives: yes | no | needs <new primitive> }`. At planning time the planner proposes the highest-count abilities that are expressible and the owner approves the list; abilities that are not expressible are recorded with the missing capability (feeding #1077 and #1078). The audit also carries the ratchet: a monotonic count of entries, and a check that every entry's fixture hash still matches the compendium.

## Error handling

- A malformed table entry fails schema validation in tests and is skipped (with a console error) at runtime, never offered.
- A step failure never aborts the remaining steps or the turn; it is reported to the GM.
- A failed region creation leaves the action unspent and reports to the GM; a failed zone follow-update logs and leaves the zone where it was.
- Expiry, toggle-off and combat-end cleanup never throw; a failed deletion is logged and reported.
- If the fixture hash does not match the live item text, the entry is disabled for that item (the text may have changed meaning) and the audit flags it.

## Testing

- **Schema and validator:** every shipped entry validates; invalid entries (unknown `op`, missing fields, a disallowed rule element) are rejected.
- **Primitives (mocked Foundry):** `applyCondition` with each duration kind, `removeCondition`, `applyEffect` rule subset, `createZone` (region shape, Terrain behavior, flags, expiry), `note`.
- **Toggles:** on/off offered correctly from the recorded state, inverse steps remove the condition and delete the zone, state cleared at combat end.
- **Zones:** emanation and burst shapes, `followsSource` tracking token movement, expiry on the game clock, removal on source defeat, and cleanup at combat end.
- **Terrain extensions:** `cellCost` with `appliesToModes` and `excludeSource` (a flyer pays, a walker does not, the source does not), `uneven` zones with the Balance check outcomes for AI movers.
- **Vocabulary:** gating by cost/frequency/requirements, mode on/off entries, the fixture-hash mismatch disabling an entry, the cap.
- **Audit and ratchet:** the inventory builds from the fixture, counts entries, classifies expressibility, and fails on a hash mismatch or a count drop.
- **Regression:** #934/#935/#973/#983 tests keep passing.
- **Live verification:** a will-o'-wisp going dark and coming back, a slurk coating the floor and an AI mover making Balance checks, a dragon turtle's storm slowing a flyer and not the turtle, and the zones expiring and being cleaned up.

## Explicitly out of scope

- Transformations and form changes — #1077; sense, communication, fire/light-source and other one-off abilities (Drench, Direct Halo, Quick Stow, contracts) — #1078.
- Any ability that cannot be expressed with the closed primitives; per-ability code.
- Enforcing zones on player-controlled movement.
- Hunt Prey for NPCs beyond what the table can express (a designate-a-target primitive would be a new primitive and is not in this slice).
- Prose interpretation by the reasoning model.

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: the approved first-batch list, the exact schema fields, the Balance-check handling in #973's movement executor, and how the fixture hash is computed over normalized description text.
