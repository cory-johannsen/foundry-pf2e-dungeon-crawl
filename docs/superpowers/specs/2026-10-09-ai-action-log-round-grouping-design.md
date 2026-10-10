# AI Action Log: Collapsible Round Groups

**Issue:** #1003 — group rows by round with collapsible round headers, deferred from #950.

**Builds on:** #950 / `docs/superpowers/specs/2026-10-09-ai-actor-action-log-panel-design.md` (`AiActionLogApp`, `buildAiLogView`, live update and auto-scroll), #925 (the log record).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#950's window is a flat, filterable list with a round select. This adds **round headers** with collapse/expand. Headers are always shown; the round select stays and narrows the list to one round. The latest round starts expanded and earlier rounds collapsed. Collapsed state is remembered while the window is open. A row arriving in a collapsed round does not expand it; the header's count updates and a "+N new" badge appears until it is expanded.

## Investigation findings

- `buildAiLogView(records, { combatantId, round, isGM })` returns `{ rows, combatants, rounds }` with filters already applied; it has no notion of groups. Rows carry `round` and `turn`.
- The window re-renders on `updateCombat` (when `flags.pf2e-dungeon-crawl.agentLog` changes). Auto-scroll preserves the user's position (stay at bottom only if they were at the bottom). Window state (filters) lives on the app instance and resets when the combat changes.
- Expanding or collapsing must not trigger a full re-render of filter state; the app is an ApplicationV2 with Handlebars, so a `data-action` toggle handler can re-render the list part only.

## Resolved decisions

1. **Always group; keep the round filter.** The round select narrows the list to a single group, which is then shown expanded.
2. **Default state:** the highest round present is expanded; all earlier rounds are collapsed.
3. **Collapsed rounds receiving a new row stay collapsed**, with an updated row count and a "+N new" badge that clears on expand. No auto-scroll for collapsed groups.
4. **State is kept on the app instance** (a `Set` of expanded rounds and a `Map` of unread counts) and reset when the combat changes, as the filters are.

## Design

### View building (`buildAiLogView`)

Adds `groups` alongside `rows` (keeping `rows` for existing callers):

```js
groups: [{ round, count, rows: [...], expanded: boolean, unread: number }]
```

- Groups are the filtered rows bucketed by `round`, ordered by round ascending (rounds are chronological; within a group, rows keep log order). `count` is the number of rows in the group after filtering.
- `expanded` and `unread` are not computed in the pure function; it accepts `{ expandedRounds, unreadByRound }` and copies them in, defaulting to the rules in decision 2 when `expandedRounds` is null.
- With a round filter active, `groups` contains that single group and `expanded` is forced true.

### Window (`ai-action-log-app.mjs`, `templates/ai-action-log.hbs`)

- Each group renders as a `<section class="group">` with a `<header>` button (`data-action="toggleRound" data-round="N"`), a chevron, the title "Round N", the count ("5 actions"), and a "+N new" badge when `unread > 0`.
- `toggleRound` flips membership in `expandedRounds`, clears that round's unread count, and re-renders only the list part.
- On each live refresh the app diffs the previous record ids per round; for a round not in `expandedRounds` it adds the number of new rows to `unreadByRound`. For an expanded round the existing auto-scroll rule applies unchanged.
- The first render after a combat change sets `expandedRounds = {latest round}`. A new round starting collapses nothing: it is added to the expanded set and the previously latest round stays as the user left it.

### Accessibility and styling

Header is a real `<button aria-expanded>` controlling the section body; keyboard activation works. Styling uses the module's existing log row classes; collapsed bodies use `hidden`, not removal, so the DOM and scroll geometry stay simple.

## Error handling

- Records without a numeric `round` are bucketed under a "No round" group placed first.
- Toggle of a round that no longer exists (combat changed) is ignored.
- An empty filtered result shows the existing empty state with no groups.

## Testing

- **Pure view:** bucketing by round, ordering, counts, default expanded latest, forced expand under a round filter, GM-only rows excluded for players (counts reflect visible rows), missing round bucket.
- **App (mocked DOM):** toggle expands/collapses and clears the badge; a new row in a collapsed round increments the badge without expanding; a new round expands itself; state resets on combat change; auto-scroll unaffected.
- **Live verification:** run a multi-round AI combat with the window open; earlier rounds collapse and the badge appears only for collapsed rounds that receive rows.

## Explicitly out of scope

- Remembering collapse state across window closes or sessions.
- Per-actor sub-grouping within a round.

## Open questions

None. Planning-time detail: whether the toggle re-renders a template part or manipulates the DOM directly.
