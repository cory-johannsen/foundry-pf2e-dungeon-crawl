# AI Actors: Token HUD Panel for Recent Actions

**Issue:** #1006 — Token HUD panel for recent actions, deferred from #951.

**Builds on:** #951 / `docs/superpowers/specs/2026-10-09-ai-actor-tracker-and-hover-detail-design.md` (the shared `buildCombatantDigest`, `visibleRecords`, tracker row and hover tooltip), #950 (the log window and `api.openAiActionLog`), #925 (log record and visibility).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

Add a collapsible **AI actions** section to Foundry's right-click Token HUD for AI-controlled combatants. It lists up to the five most recent actions from the #951 digest (current round, then the previous round), shows the GM-only rationale beneath each row for GMs, and links to the #950 log window pre-filtered to that combatant.

## Investigation findings

Inspected on the live world (Foundry **14.368**):

- `foundry.applications.hud.TokenHUD` is an ApplicationV2 with a single `hud` part; its `_prepareContext` builds the HUD columns, and `_onPosition` positions it over the token. The standard module integration point is the `renderTokenHUD` hook (`(app, html, data)`), where `html` is the root element.
- The HUD is only available for tokens the user controls (all tokens for a GM). Players therefore see it only for tokens they own — including an AI-controlled character they own — so visibility needs no extra gate beyond the digest's own rules.
- #951's `buildCombatantDigest(records, { combatantId, round, isGM })` already returns `{ last, currentRound, previousRound, stale }` after applying `visibleRecords`; `currentRound`/`previousRound` rows carry the summary, target, cost glyphs, result chip and (GM) rationale/tags.

## Resolved decisions

1. **Collapsible section appended to the HUD**, showing the last 5 actions across the current and previous rounds.
2. **Anyone who can open the HUD** sees it, for AI-controlled combatants only, with #951's visibility rules (hidden-from-players rows stay hidden to non-GMs; rationale/tags GM-only).
3. **"Open in log" link** calls `api.openAiActionLog({ combatantId })`.
4. **Reuse, don't re-derive:** the section is rendered from the same digest and row template fragment as the tracker's expanded list.

## Design

### Hook (`scripts/ui/token-hud-ai-panel.mjs`)

`Hooks.on("renderTokenHUD", (app, html) => ...)`:

1. Resolve `app.object.document` → token → combatant in the current module combat (`isModuleCombat`); return if none or if the combatant is not AI-controlled (human-controlled combatants never get the section).
2. Read the combat's `agentLog` (malformed flag → empty), `game.user.isGM`, and `combat.round`; call `buildCombatantDigest`. If `last` is null the section is not added.
3. Take `rows = [...currentRound, ...previousRound]` newest-first, truncated to 5, preserving the digest's per-row fields.
4. Remove any existing `.pf2edc-ai-hud` from `html`, then append a new section (idempotent across HUD re-renders).

### Markup

```
<section class="pf2edc-ai-hud">
  <button data-action="toggle" aria-expanded="…">AI actions ▾</button>
  <ol> one li per row: cost glyphs, summary, target, result chip (tone class); GM: rationale/tags beneath </ol>
  <a data-action="openLog" data-combatant-id="…">Open in log</a>
</section>
```

- The section sits under the HUD's columns; the HUD already repositions on render so no extra positioning is needed. When `stale`, the first row is prefixed "(last round)", as in #951.
- Collapsed state is kept in a module-level `Set` of combatant ids, separate from #951's tracker expand set. The default is collapsed, to keep the HUD compact.
- `openLog` calls `game.modules.get("pf2e-dungeon-crawl").api.openAiActionLog({ combatantId })`.

### Live update

The HUD re-renders whenever its token's HUD is re-opened or updated; the section reads the flag fresh each render, so no extra refresh hook is needed. If the HUD is open when the log changes, it updates on the next HUD render (`updateCombat` already triggers `renderTokenHUD` for an open HUD in the current build; if not, a debounced `app.render()` on the log-flag update is added during planning).

### Styling

Uses #951's tone classes and the log row fragment; the section is narrow (HUD width) and scrolls within a max height of about 14em.

## Error handling

- No combatant, non-AI combatant, empty digest: no section, no error.
- Malformed log flag: treated as empty.
- `openAiActionLog` unavailable: the link is not rendered.

## Testing

- **Hook (mocked HUD root):** section appended for an AI combatant with rows; none for human combatants or empty digests; idempotent across re-renders; rows truncated to 5 newest-first across rounds; stale prefix.
- **Visibility:** non-GM sees no `visibility: "gm"` rows, rationale or tags; GM sees them.
- **Link:** click calls the API with the combatant id.
- **Collapse state:** toggle persists across re-render within the session.
- **Live verification:** right-click an AI token mid-combat as GM and as the owning player; the section lists recent actions and the link opens the filtered log.

## Explicitly out of scope

- Editing or acting on log rows from the HUD.
- A GM-only restriction (rejected; same visibility rules as #951).

## Open questions

None. Planning-time details: whether `renderTokenHUD` fires for an open HUD on combat updates in 14.368.
