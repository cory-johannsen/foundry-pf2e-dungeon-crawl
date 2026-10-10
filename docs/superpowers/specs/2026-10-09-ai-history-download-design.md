# AI Action History: Markdown and JSON Download

**Issue:** #1014 — Markdown/JSON download of the run's history, deferred from #953.

**Builds on:** #1013 / `docs/superpowers/specs/2026-10-09-ai-action-log-history-mode-design.md` (structured `records` on archive pages, `listArchivedEncounters`, `loadArchivedRecords`, History mode), #953 (journals, public/GM split), #950 (window), #952 (`buildDecisionDetails`).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

Add a **Download** action to the #950 window's History mode that exports the current run's archived AI action history, all encounters in order, as **Markdown** and **JSON**. The export honors the public/GM split: a GM receives the GM content (all rows, rationale, alternatives, metadata); players receive only the public content.

## Investigation findings

- #1013 stores structured `records` on every archive page (public page: public rows only; GM page: all rows) and provides `listArchivedEncounters({ historyId, isGM })` / `loadArchivedRecords(pageUuid)`. The same sources can feed an export; no HTML parsing is needed.
- Visibility is enforced by which page is read, so an export built from those pages can never include more than the user can already open.
- `buildDecisionDetails(record, { isGM })` (#952) returns the metadata lines for GM output; `visibleRecords` strips GM-only content for players.
- Foundry offers `foundry.utils.saveDataToFile(data, type, filename)` for client-side downloads; no server involvement is needed.

## Resolved decisions

1. **Formats:** Markdown and JSON.
2. **Entry point:** a Download button in the #950 window's History mode header (the journal header control is #1152).
3. **Scope:** the whole run's archived encounters in one file (a single selected encounter is #1153).
4. **Privacy:** identical to History mode — GM gets GM content; others get public only.

## Design

### Pure builders (`scripts/ai-history-export.mjs`)

`buildHistoryJson(encounters, { isGM, dungeonName, historyId, exportedAt })` returns

```json
{
  "schemaVersion": 1,
  "module": "pf2e-dungeon-crawl",
  "run": { "dungeonName": "...", "historyId": "..." },
  "exportedAt": "2026-10-09T18:00:00Z",
  "audience": "gm" | "public",
  "encounters": [ { "combatId": "...", "label": "Room 4 — Combat", "recordedAt": "...", "truncated": false, "records": [ ... ] } ]
}
```

`buildHistoryMarkdown(encounters, { isGM, dungeonName, exportedAt })` returns Markdown: a title and metadata block, then per encounter a level-2 heading, per round a level-3 heading and a table (combatant, summary, target, result); for GM audience each row is followed by an indented block with the rationale, fallback tag/reason, the alternatives list (chosen marked, "+N more") and the metadata lines from `buildDecisionDetails`. All table cells and text are escaped for Markdown (pipes, backticks, newlines, leading markers).

Both builders apply `visibleRecords(records, isGM)` defensively even though the source page is already filtered, so a mis-stored record cannot leak.

### Window (`ai-action-log-app.mjs`)

In History mode a **Download** button with a small menu: "Markdown" and "JSON" (`data-action="downloadHistory" data-format="md|json"`). The handler:

1. Loads encounters with `listArchivedEncounters`/`loadArchivedRecords` for the current run (oldest first for the export).
2. Legacy pages without structured records are listed in the Markdown as "(no structured data)" and omitted from the JSON `encounters`, with a count noted in the output so nothing is silently lost.
3. Builds the file text with the pure builders and saves it with `foundry.utils.saveDataToFile`, filename `ai-history-<dungeon-slug>-<YYYYMMDD-HHmm>.{md,json}`.
4. Posts a UI notification on success or failure; failures never throw into the window.

Both buttons are disabled with a tooltip when the run has no archived encounters.

### API

`api.downloadAiHistory({ format })` exposes the same action for macros; it uses the caller's role for audience.

## Error handling

- No run / no archive: buttons disabled; API returns without saving and notifies.
- Malformed `records`: that encounter exports with an empty record list and a note.
- Very large exports (more than ~5 MB of text) show a warning but still save.

## Testing

- **Builders:** JSON schema and field set per audience; Markdown structure, escaping edge cases (pipes, backticks, newlines, HTML), GM-only content absent for public; deterministic ordering; truncated and legacy encounters.
- **Window (mocked save function):** button gating, format selection, filename, notifications, failure handling.
- **Visibility:** the public export contains no rationale, alternatives, metadata or GM-only rows.
- **Live verification:** finish two combats; download Markdown and JSON as GM and as a player; confirm the player file has no GM-only content.

## Explicitly out of scope

- A Download button on the journal sheet — #1152.
- Downloading only the selected encounter — #1153.
- Other formats (CSV, HTML).

## Open questions

None. Planning-time detail: the filename timestamp source (game clock vs wall clock).
