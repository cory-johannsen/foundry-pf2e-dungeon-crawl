# Advanced AI Actors: Combat-Tracker Row Detail and Token Hover

**Issue:** #951 — combat-tracker row detail and token hover for an AI actor's last action and rationale (a deferred follow-up of #925).

**Builds on:** #925 / `docs/superpowers/specs/2026-10-08-ai-actor-action-display-design.md` (the per-combat structured `agentLog`, the public-what / GM-why split) and #950 / `docs/superpowers/specs/2026-10-09-ai-actor-action-log-panel-design.md` (the `visibility` and `tokenId` record fields and the pure visibility-filtering view builder, which this spec shares). The module's existing token-drawing code (`scripts/flanking-indicator.mjs`) and tracker hooks (`getCombatTrackerEntryContext` in `scripts/module.mjs`) are the patterns to follow.

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#925 posts one consolidated chat card per AI turn and #950 adds a dedicated log window. Both are places you go to. This spec puts the same information **where you are already looking**: under each AI combatant's row in Foundry's Combat Tracker, and in a small tooltip when you hover an AI token on the canvas.

- **Combat Tracker row:** a compact one-line summary under the combatant's name — "last: Strikes Fighter (hit)" — that expands on click to the combatant's actions in the current round (plus the previous round's), with the model's rationale shown to the GM only.
- **Token hover tooltip:** hovering an AI token shows a small tooltip with the combatant's name and its latest action and result (and, for the GM, the rationale).

Both read the structured `agentLog` that #925 already stores; neither changes how decisions are made. The Token HUD panel is deferred (#1006).

## Investigation findings

Confirmed against the repo, the installed Foundry v14 / PF2e system and the #925/#950 designs.

- **The data exists (by #925/#950).** `flags.pf2e-dungeon-crawl.agentLog` on the combat is an array of records `{ combatantId, tokenId, round, turn, index, type, cost, summary, target: { id, name }, result: { text, tone }, rationale?, source, visibility }`, discarded with the combat. `visibility: "gm"` marks rows for hidden-token actors.
- **Tracker hook.** Foundry v14's combat tracker is an `ApplicationV2` sidebar tab; modules extend it through the `renderCombatTracker` hook, which receives the application and its root element, and through `getCombatTrackerEntryContext` (already used in `module.mjs` to add per-combatant menu items such as "toggle agent control"). Combatant rows are list items carrying `data-combatant-id`. The tracker re-renders itself when the combat document changes, and the `agentLog` flag is part of the combat document, so a new record causes a tracker render.
- **Token hover hook.** `hoverToken(token, hovered)` fires when the pointer enters or leaves a token. Canvas tokens are not DOM elements, so Foundry's DOM `TooltipManager` (`game.tooltip.activate(element, …)`) needs an anchor element; a free-standing overlay positioned from the token's canvas position is the dependable option. The module already positions things relative to tokens (`flanking-indicator.mjs` draws per-token via `refreshToken`).
- **AI vs player combatants.** The log only contains records for AI-controlled combatants (agent-controlled NPCs and any allied AI), so "has records" is the right gate; human-controlled combatants never get this detail.
- **The same visibility rules apply as #925/#950.** Non-GM users must not see rationale, fallback tags, stall notes, or any row for a hidden-token actor. Client-side hiding only, consistent with #925 (combat flags are readable by every client).

## Resolved decisions

1. **Surfaces: the Combat Tracker row and the token hover tooltip.** The Token HUD panel is #1006.
2. **Depth: the current round's actions** for the combatant (and the previous round's on expand). If the combatant has not acted this round, its most recent actions are shown labeled "(last round)".
3. **Tracker row: a one-line summary, click to expand.** Nothing extra is shown until it is clicked beyond the one line.
4. **Audience: the same as #925/#950** — everyone sees what and the result; the GM also sees the rationale and GM-only notes; hidden-token actors are GM-only.

## Design

### Shared digest (`scripts/ai-action-digest.mjs`, pure)

`buildCombatantDigest(records, { combatantId, round, isGM })` returns:

```js
{
  last: { summary, targetName, result: { text, tone }, round } | null,
  currentRound: [row, ...],
  previousRound: [row, ...],
  stale: boolean            // true when the combatant has not acted in `round`
}
```

- It first reduces `records` with the **same visibility function #950's `buildAiLogView` uses** (`visibleRecords(records, isGM)`, factored into a shared pure helper): non-GM users lose `visibility: "gm"` rows and the rationale/fallback/stall fields.
- `currentRound` is that combatant's rows in `round`; when empty, `last` falls back to the combatant's most recent earlier row and `stale` is true; `previousRound` is the immediately earlier round that has rows.
- It performs no Foundry access, so it is fully unit-testable.

### Combat Tracker row

A `renderCombatTracker(app, html)` handler (works on the root element Foundry passes):

1. Reads the current combat's `agentLog` (a malformed flag is treated as empty) and `game.user.isGM`.
2. For every `li` with a `data-combatant-id`, builds the digest. If `last` is null, the row is left unchanged.
3. Inserts a `<div class="pf2edc-ai-last" data-combatant-id="…">` beneath the name block: a chevron and the one-line summary ("last: <summary> (<result>)"), styled by `result.tone`, prefixed "(last round)" when `stale`.
4. Clicking the line toggles an expanded list: one row per action in `currentRound` (cost glyphs, summary, target, result chip), then the previous round's rows under a "Last round" subheading; GMs also see each row's rationale and tags. Which combatants are expanded is kept in a module-level `Set` of combatant ids so it survives the tracker's own re-renders; it is cleared when the combat changes.
5. The handler is idempotent: it removes any existing `.pf2edc-ai-last` for a row before inserting, so repeated renders never duplicate it.

No extra refresh hook is needed: the tracker already re-renders when the combat document (including the flag) updates.

### Token hover tooltip

A `hoverToken(token, hovered)` handler:

- On `hovered === true`, if the token's combatant has digest data (visible to this user), shows a single reusable overlay element `<div id="pf2edc-ai-hover">` appended to `document.body`, positioned next to the token from its canvas position converted to client coordinates (the exact conversion API for the installed Foundry version is confirmed at planning). Content: the combatant name, then the latest action line and result chip, then (GM only) the rationale in a muted line; "(last round)" when stale.
- On `hovered === false`, or when the canvas pans/zooms (`canvasPan`), the overlay is hidden/repositioned; it is also hidden when the token is deleted or the combat ends.
- The tooltip is never shown for tokens the current user cannot see, for actors with no visible digest, or for human-controlled combatants.
- The overlay is `pointer-events: none` so it never interferes with canvas interaction.

### Permissions and visibility

Everything is decided by `isGM` and the digest's use of the shared `visibleRecords` helper; no special permission is needed. In GM-less runs the human players are non-GM users and see the public rows.

### Styling

A small stylesheet (`styles/ai-action-detail.css`, loaded through the existing module style mechanism) provides the tracker line, the expanded list, the result chips (tone colors from the same tokens #925/#950 use) and the hover overlay.

## Error handling

- A failing render or hover handler never throws into the tracker, canvas or combat pipeline; errors are logged and the surface is simply absent.
- Missing or malformed records (non-array flag, missing fields) render with generic labels or not at all.
- A hovered token with no combatant, no digest, or hidden from the user shows nothing.
- If the coordinate conversion fails, the tooltip is not shown rather than appearing in the wrong place.

## Testing

- **`buildCombatantDigest` (pure):** GM vs non-GM (rationale/tags dropped, GM-only rows removed), current-round vs stale fallback, previous-round selection, no records → `last: null`, ordering, malformed input.
- **Shared `visibleRecords`:** one test suite exercised by both the digest and #950's view builder (a single source of truth for what a non-GM may see).
- **Tracker handler (DOM, with stubs):** a summary line is inserted only for combatants with data, expand/collapse toggles the list, expanded state survives a re-render, idempotence (no duplicate lines), GM-only elements absent for non-GM, malformed flag ignored.
- **Hover handler (with stubs):** the overlay shows on hover for a visible AI token and hides on unhover/pan/delete, is not shown for hidden or human-controlled tokens, positions via the converted coordinates, and failure to convert shows nothing.
- **Live verification:** a fight with several AI monsters; as the GM and as a player, confirm the tracker line and expansion, the tooltip on hover, the "(last round)" label, that a player never sees rationale or a hidden actor, and that the tracker stays usable (no layout break) with many combatants.

## Explicitly out of scope

- A Token HUD panel — #1006.
- The dedicated log window (#950), consolidated chat cards (#925), alternatives considered and decision metadata (#952) and history beyond the current combat (#953).
- Persisting expanded/collapsed state across sessions.
- Cryptographic hiding of GM-only data from players (client-side hiding, as #925).

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: the root-element shape `renderCombatTracker` passes on the installed Foundry version, the canvas-to-client coordinate API for positioning the tooltip, and the exact tracker markup to anchor the summary line under.
