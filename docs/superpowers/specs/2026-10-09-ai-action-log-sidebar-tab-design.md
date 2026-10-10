# AI Action Log: Sidebar Tab

**Issue:** #1004 — optional sidebar tab for the AI action log, deferred from #950.

**Builds on:** #950 / `docs/superpowers/specs/2026-10-09-ai-actor-action-log-panel-design.md` (`AiActionLogApp`, `buildAiLogView`, `refreshAiActionLogWindow`, privacy rules), #1003 / `docs/superpowers/specs/2026-10-09-ai-action-log-round-grouping-design.md` (round groups).

**Status:** Approved. The API question was settled by live inspection of the installed Foundry on 2026-10-09; visibility was decided with the owner (see "Resolved decisions").

## Summary

Add an always-available **AI Log** tab to the Foundry sidebar, visible to every user, hosting the same view as the #950 window. The tab and the window share `buildAiLogView`, the same template partial and the same live-update path.

## Investigation findings

Inspected on the live world (Foundry **14.368**):

- `foundry.applications.sidebar.Sidebar` (`ui.sidebar`) is data-driven. `Sidebar.TABS` is a record `tabId → { documentName?, gmOnly?, tooltip?, icon? }`. `_configureRenderOptions` rebuilds `PARTS[id] = { template: "templates/sidebar/tab.hbs" }` for every key in `TABS` on each render, so a new entry gets its part automatically.
- Each tab's class is looked up in `CONFIG.ui[tabId]`; core tabs extend `AbstractSidebarTab` (a `HandlebarsApplicationMixin(ApplicationV2)` base with `tabName`, `active`, `popout`, `renderPopout`, `_onActivate`/`_onDeactivate`). `PlaceableDirectory` (the `placeables` tab) is precedent for a tab that has **no `documentName`** and only an `icon` and `tooltip`.
- `Sidebar.prototype._renderHTML` renders stub elements on first render and re-renders requested tab parts afterward, so a tab class is instantiated lazily by the sidebar.
- `AbstractSidebarTab` exposes `popout` (a tab can pop out into its own window), which gives the tab a standalone-window mode for free.
- No documented module API for registering a tab exists; registration is by extending these two static registries before the first sidebar render (the `init` hook).

## Resolved decisions

1. **Register through `Sidebar.TABS` and `CONFIG.ui`** (the data-driven path above); no core patching.
2. **Visible to everyone, with #950's privacy rules**: non-GM users get `buildAiLogView(..., { isGM:false })` output (GM-only rows, rationale, fallback tags and stall notes stripped).
3. **Shared code:** one `AiActionLogView` mixin/partial supplies rendering for both the window and the tab; there is one refresh function.
4. **Fallback if registration fails at runtime** (an unexpected shape on a future Foundry version): log a single warning and leave the window as the only entry point; nothing else breaks.

## Design

### Registration (`scripts/ui/ai-action-log-tab.mjs`)

In the module's `init` hook, before the sidebar renders:

```js
const ID = "pf2edcAiLog";
foundry.applications.sidebar.Sidebar.TABS[ID] = {
  tooltip: "PF2EDC.AiLog.Tab",       // localized in lang/en.json
  icon: "fa-solid fa-scroll",
};
CONFIG.ui[ID] = AiActionLogTab;
```

The registration is wrapped in a feature check (`typeof Sidebar.TABS === "object"` and `AbstractSidebarTab` available); if the check fails the warning in decision 4 is logged. The `hasPermission`/`gmOnly` flags are left unset so every user sees it.

### The tab class

`AiActionLogTab extends AbstractSidebarTab` with `tabName = "pf2edcAiLog"`, `DEFAULT_OPTIONS.window.title = "PF2EDC.AiLog.Title"` (used when popped out) and `PARTS.main.template = "modules/pf2e-dungeon-crawl/templates/ai-action-log.hbs"`. `_prepareContext` builds context with `buildAiLogView(records, { combatantId, round, isGM, expandedRounds, unreadByRound })`, exactly the call the window makes. Filters and group state live on the tab instance and reset when the combat changes, as in the window. Row click, round-group toggling (#1003) and auto-scroll behavior are shared code in `ai-action-log-view.mjs`, extracted from `AiActionLogApp` so the window and the tab are thin shells.

### Live update

`refreshAiActionLogWindow` is generalized to `refreshAiActionLogViews`, which re-renders the open window **and** the sidebar tab when it is the active tab (`ui.sidebar.tabGroups.primary === ID`); an inactive tab is not rendered and re-renders on activation (`_onActivate`). The same hooks (`updateCombat` for the log flag, `deleteCombat`, `combatStart`, `combatRound`) drive both.

### Interaction with the window

Both entry points open the same data: the scene-control tool, chat-card link and macro from #950 open the window as before; they do not switch tabs. A chat-card link with a `combatantId` also sets the tab's filter so the next activation shows the same filter.

### Settings

None. The tab is always present; a user hides it the way they hide any sidebar tab (Foundry's own tab arrangement).

## Error handling

- Registration failure: one console warning, window remains.
- Tab instantiated with no combat: empty state from #950.
- Render failure of the tab never blocks the sidebar's other tabs (Foundry renders tab parts independently); errors are caught and the tab shows the empty state.

## Testing

- **Registration:** with a stub `Sidebar` that has `TABS` and a stub `CONFIG.ui`, the entry and class are registered; a stub without `TABS` logs one warning and registers nothing.
- **Shared view:** the window and the tab call the same view builder with identical arguments for the same state (golden test); GM vs non-GM output.
- **Refresh:** an active tab re-renders on a log change; an inactive tab does not; activation renders it.
- **Live verification:** open the world, find the AI Log tab for a GM and a player account; run an AI combat; rows appear live, the player sees no GM-only rows; pop the tab out.

## Explicitly out of scope

- Settings to hide the tab or move it (use Foundry's arrangement).
- A GM-only variant (rejected).
- Replacing the window (both remain).

## Open questions

None. Planning-time details: whether `tabName` must also be added to `CONFIG.ui.sidebar` ordering for placement, and the final tab position (after `chat`/`combat`).
