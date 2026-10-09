# Advanced AI Actors: Action-Log Panel

**Issue:** #950 — persistent action-log panel for the current combat (a deferred follow-up of #925).

**Builds on:** #925 / `docs/superpowers/specs/2026-10-08-ai-actor-action-display-design.md` (the per-combat structured `agentLog`, the consolidated per-turn chat card, the `data-visibility="gm"` rationale convention), the marching-order window from #852 (`scripts/ui/marching-order-app.mjs`, the scene-control entry point and the setting-change refresh hook), and the world-macro definitions in `scripts/world-macros.mjs`.

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#925 gives every AI turn one consolidated chat card and stores a small structured record per AI action on the combat document. Reading it still means scrolling the chat log. This spec adds a **standalone window**, the *AI Action Log*, that lists every AI action recorded for the current combat, with **filters by combatant and by round**, **live updates with auto-scroll**, and **click-a-row to select and pan to the acting token**. It is available to **every user**: players see what each AI did and the result; only GMs also see the model's rationale and the GM-only notes, exactly the split #925 already uses for the chat card. It opens from a scene-control tool, from a link on the per-turn chat card, and from a macro / API call.

## Investigation findings

Confirmed against the repo and the #925/#852 designs.

- **The data source already exists (by #925).** Each executed AI action appends a record to `flags.pf2e-dungeon-crawl.agentLog` on the combat document: `{ combatantId, round, turn, index, candidateId, type, cost, summary, target: { id, name }, result: { text, tone }, rationale?, source: "model" | "fallback" }`. The log is discarded with the combat. Nothing renders it except the consolidated chat card.
- **A window pattern to copy exists (#852).** `marching-order-app.mjs` is a `HandlebarsApplicationMixin(ApplicationV2)` window with a fixed app id (`pf2edc-marching-order-app`), a refresh helper (`refreshMarchingOrderWindow(instances)`) called from a module hook when the underlying data changes, an injectable `instances` map for tests, and a scene-control tool (`marchingOrderSceneTool`) registered for every user in the token controls (`getSceneControlButtons`, `module.mjs`).
- **Combat flags are readable by every client.** A flag on the combat document is replicated to all users, so anything stored in a record is technically retrievable by a player with the browser console, the same as message HTML hidden with `data-visibility`. #925 accepted client-side hiding for the rationale; this spec follows suit and does **not** add a separate secret store. The honest guarantee is "not shown in the UI to players", not cryptographic secrecy.
- **A hidden actor must not announce itself.** #925 turns the whole card into a GM whisper when the acting token is hidden from the players; the log must hide the same rows from non-GM users, which requires the record to carry that decision (see "Record additions").
- **Selecting and panning to a token** uses the canvas APIs the combat tracker itself uses (`token.control({ releaseOthers: true })` and `canvas.animatePan`), subject to the user being able to see the token.
- **World macros** are declared in `MACRO_DEFS` (`scripts/world-macros.mjs`) and synced by `ensureWorldMacros`; names carry no `PF2EDC:`/`DOMMT:` prefix for new macros (#96/#770).

## Resolved decisions

1. **Form: a standalone window opened from a scene-control tool**, the #852 pattern. A sidebar tab is #1004.
2. **Audience: everyone sees *what* and *result*; the GM also sees *why*.** Rows for hidden-token actors, rationale text, fallback tags and stall notes are GM-only.
3. **Features:** filter by combatant, filter by round, live update with auto-scroll, and click a row to select and pan to the token. Round grouping with collapse is #1003.
4. **Entry points:** a scene-control tool, a link on #925's per-turn chat card, and a macro plus `api.openAiActionLog()`.

## Design

### The window (`scripts/ui/ai-action-log-app.mjs`)

`AiActionLogApp extends HandlebarsApplicationMixin(ApplicationV2)`, app id `pf2edc-ai-action-log-app`, template `templates/ai-action-log.hbs`, a standard resizable window. It shows the log of the **current combat**: the combat the user is viewing (`game.combat`, restricted to this module's managed combats via `isModuleCombat`). Layout:

- **Header filters:** a combatant select ("All combatants" plus every combatant that appears in the log) and a round select ("All rounds" plus every round that appears). Filter state lives on the app instance and resets when the combat changes.
- **Row list:** one row per record in log order: round and turn, the combatant's name and portrait, the action cost glyphs, the summary and target, and a result chip styled by `result.tone`. GMs additionally see, beneath a row, the rationale (when present), a "(fallback heuristic)" tag when `source` is `fallback`, and any stall note.
- **Empty state:** "No AI actions have been recorded for the current combat." (also shown when there is no managed combat).
- **Click a row:** selects the acting token and pans the canvas to it (`token.control({ releaseOthers: true })`, `canvas.animatePan`), only when a token for the combatant exists on the viewed scene and is visible to the current user; otherwise the click does nothing (no error).

### View building (pure)

`buildAiLogView(records, { combatantId, round, isGM })` returns `{ rows, combatants, rounds }`:

- Drops rows whose record is GM-only (`visibility === "gm"`) for non-GM users.
- Strips `rationale`, the fallback tag and stall notes for non-GM users.
- Applies the two filters (a filter value not present in the log is treated as "all").
- Builds the combatant and round option lists from the **visible** rows only, so a player's filter lists never reveal a hidden actor.

It performs no Foundry access, so it is fully unit-testable.

### Record additions (a small amendment to #925's record)

#925's record gains `visibility: "all" | "gm"` (computed where the record is written: `"gm"` when the acting token is hidden from players, as #925 already decides for the chat card) and `tokenId` (the acting token's id, for click-to-pan). The #925 implementation plan should include both fields; this spec depends on them.

### Live update and auto-scroll

- A module hook on `updateCombat` (when `flags.pf2e-dungeon-crawl.agentLog` changed), `deleteCombat` and `combatStart`/`combatRound` calls `refreshAiActionLogWindow(foundry.applications.instances)`, which re-renders an open window (an injectable `instances` map for tests, as in #852). Only an open window is touched.
- **Auto-scroll:** before re-render the app records whether the list was scrolled to the bottom (within a small tolerance); after render it scrolls to the bottom only if it was. A user who scrolled up to read earlier rows is never yanked down.
- When the combat is deleted the window re-renders to the empty state (the log goes with the combat, per #925).

### Entry points

1. **Scene-control tool:** `aiActionLogSceneTool`, registered next to the marching-order tool in `getSceneControlButtons`, **visible to every user**, icon `fa-solid fa-scroll`, opens the window.
2. **Chat-card link:** #925's consolidated card header gains `<a data-action="openAiActionLog" data-combatant-id="…">`; a `renderChatMessageHTML` handler binds it to `openAiActionLog({ combatantId })`, so the window opens pre-filtered to that combatant.
3. **Macro and API:** `api.openAiActionLog({ combatantId?, round? })` on the module API and a `MACRO_DEFS` entry named "AI Action Log" calling it, synced by `ensureWorldMacros` like the existing macros.

Opening an already-open window re-renders it, applying any passed filters, rather than creating a second instance.

### Permissions

No special permission is needed to open the window; what a user sees is determined entirely by `isGM` in `buildAiLogView`. In GM-less runs the human players are non-GM users and see the public rows; the relay's GM account sees everything.

## Error handling

- A failing render or refresh never throws into the combat or chat pipeline; errors are logged.
- Missing record fields render with generic labels (an unknown combatant name shows as "Unknown"), never throw.
- Click-to-pan on a missing, off-scene or invisible token is a silent no-op.
- A malformed `agentLog` flag (not an array) is treated as empty.

## Testing

- **`buildAiLogView` (pure):** GM vs non-GM (rationale/tags/notes stripped, GM-only rows dropped), combatant and round filters (including a stale filter value), option lists built from visible rows only, ordering.
- **Auto-scroll logic (pure helper):** at-bottom detection with tolerance; scroll preserved when the user is scrolled up.
- **Refresh helper:** re-renders only an open instance; ignores unrelated combat updates; empty state on combat deletion.
- **App rendering (with Foundry stubs, as the marching-order tests):** rows and filters render, filter changes re-render, empty state, GM-only elements absent for a non-GM.
- **Click-to-pan:** a fake canvas receives `control` and `animatePan` for a visible token; no-op for a hidden or off-scene token.
- **Entry points:** the scene tool is present for a non-GM user, the chat-card link opens the window pre-filtered, the macro definition exists and calls the API, opening twice re-uses one instance.
- **Live verification:** a fight with several AI monsters; open the log as the GM and as a player, confirm the player sees no rationale or hidden-actor rows, watch rows append with auto-scroll, click a row to pan.

## Explicitly out of scope

- Round grouping with collapsible headers — #1003; a sidebar tab — #1004.
- Alternatives considered and decision metadata (#952), history across the run (#953) and tracker-row/HUD display (#951).
- Persisting filters across sessions.
- Cryptographic hiding of GM-only data from players (client-side hiding, as #925).

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: the exact scene-control tool shape for the installed Foundry version (mirroring `marchingOrderSceneTool`), the chat-card link markup chosen in #925's template, and the CSS needed for the result chips.
