# AI Action History: Download a Single Selected Encounter

**Issue:** #1153 — let the user choose between the whole run and only the selected encounter when downloading. Deferred from #1014.

**Builds on:** #1014 / `docs/superpowers/specs/2026-10-09-ai-history-download-design.md` (`buildHistoryJson`, `buildHistoryMarkdown`, the window Download menu, `api.downloadAiHistory`), #1152 / `docs/superpowers/specs/2026-10-10-ai-history-journal-download-design.md` (`downloadRunHistory`, journal-sheet header entries, the remembered-format setting), #1150 / `docs/superpowers/specs/2026-10-10-ai-history-run-selector-design.md` (the Run select; downloads follow the viewed run), #1013 (`listArchivedEncounters`, `loadArchivedRecords`, the encounter select), #953 (journals and pages).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

#1014 exports the **whole run**. This spec adds a **scope**: the whole run or **just one encounter**. The Download menu in the AI Action Log window's History mode grows from two entries to four (Run or This encounter, as Markdown or JSON); the journal sheet's header menu from #1152 does the same, with "this encounter" meaning the page being viewed. A single-encounter export uses the same schema with one encounter and a `scope` marker, and its filename carries the encounter label and recorded time.

## Investigation findings

- **The pieces already exist.** Encounters are archive pages flagged `aiHistory.combatId`, each with structured `records` (#1013). `listArchivedEncounters` returns `[{ combatId, label, recordedAt, pageUuid, hasRecords }]` newest first; `loadArchivedRecords(pageUuid)` returns one page's records. The export builders take an **array of encounters** (`buildHistoryJson(encounters, …)`, `buildHistoryMarkdown(encounters, …)`), so a single-encounter export is the same call with a one-element array.
- **Selection state is already in the UI.** In History mode the window holds the selected run (#1150) and the selected encounter (#1013's encounter select, defaulting to the newest). On the journal sheet, the viewed page is a journal-entry page with `flags.pf2e-dungeon-crawl.aiHistory.combatId`.
- **Audience is the user's role**, as in #1014 and #1152; a single-encounter export reads the same pages the user can already open and applies `visibleRecords` defensively.
- **Filenames.** #1014 uses `ai-history-<dungeon-slug>-<YYYYMMDD-HHmm>.{md,json}` (timestamp = export time). A single encounter needs to be identifiable on disk without opening it.

## Resolved decisions

1. **UI:** the Download menu lists four entries — "Run as Markdown", "Run as JSON", "This encounter as Markdown", "This encounter as JSON" — in the window (History mode) and in the journal sheet's header menu. The remembered format (#1152) orders the entries within each scope.
2. **"Selected encounter":** in the window, the encounter chosen in the encounter select (of the selected run); on the journal sheet, the combat of the page being viewed, with the encounter entries disabled when no archive page is open.
3. **Format:** the same schema with one encounter and a `scope` field; Markdown keeps the same layout with just that encounter.
4. **Extra in scope:** the encounter label and recorded time in the filename. **Filed:** downloading the live in-progress combat (#1243), a round filter (#1244), and applying the combatant filter (#1245).

## Design

### Scope parameter on the shared handler (extends `downloadRunHistory`)

```js
downloadRunHistory({ historyId, format, scope = "run", combatId = null, isGM, notify, save })
```

- `scope: "run"` behaves exactly as in #1014/#1152.
- `scope: "encounter"` requires `combatId`; the handler loads the run's encounter list, selects the entry with that `combatId`, loads its records, and passes a one-element array to the builders. An unknown `combatId` (page removed meanwhile) notifies "That encounter is no longer in the archive." and saves nothing.
- The function name stays (callers are many); an alias `downloadEncounterHistory({ historyId, combatId, format, … })` calls it with `scope: "encounter"` for readability.

### Builders

- `buildHistoryJson(encounters, { isGM, dungeonName, historyId, exportedAt, scope })` adds `"scope": "run" | "encounter"` to the top level (default `"run"` for backward compatibility; `schemaVersion` stays `1` because the new field is additive). With `scope: "encounter"` the document has one `encounters` entry.
- `buildHistoryMarkdown(encounters, { …, scope })` titles a single-encounter export with the encounter label ("AI Action History — Room 4 — Combat") and a metadata line "Scope: encounter"; the per-round tables and GM blocks are unchanged.
- Truncated and legacy (no structured data) encounters follow #1014's notes: a legacy single encounter exports Markdown with "(no structured data)" and JSON is not offered for it (the entry is disabled with a tooltip).

### Window (`ai-action-log-app.mjs`)

The History mode Download menu shows four items; the two "This encounter" items are disabled when the run has no archived encounters or the selected encounter lacks structured data (tooltip: "This encounter has no structured data."). Handlers call `downloadRunHistory` with the selected run's `historyId`, the chosen `format`, and for the encounter scope the encounter select's `combatId`.

### Journal sheet (`ai-history-journal-controls.mjs`, from #1152)

The header menu grows from two entries to four with the same labels. "This encounter" resolves the **viewed page** (the sheet's current page) via its `aiHistory.combatId`; when the sheet shows no page or the page has no `combatId`, the encounter entries show a tooltip "Open an encounter page to export just that encounter." and are inactive. The remembered format orders the entries within each scope and marks the preferred one with a leading check (existing behavior).

### API

`api.downloadAiHistory({ format, scope = "run", combatId? })` extends the macro entry point; `scope: "encounter"` without a `combatId` uses the newest archived encounter of the current run, and reports that choice in the notification.

### Filenames

- Run: `ai-history-<dungeon-slug>-<YYYYMMDD-HHmm>.{md,json}` (unchanged).
- Encounter: `ai-history-<dungeon-slug>-<encounter-slug>-<YYYYMMDD-HHmm of the encounter's recordedAt>.{md,json}`, where `<encounter-slug>` is the encounter label lowercased and reduced to `[a-z0-9-]` (e.g. `room-4-combat`) and the timestamp is the **recorded** time from the page flag, so the file identifies the encounter, not the moment of export. When `recordedAt` is missing, the export time is used. The slug is capped (60 characters) to keep names portable.

## Error handling

- An encounter that disappears between selection and export, or whose records are malformed: a notification and no file; malformed records export an empty list with a note, as in #1014.
- A missing `recordedAt` or label falls back to the export time and `encounter`.
- Save failures notify and never throw into the window or sheet.
- A disabled entry never calls the handler; programmatic calls validate the same conditions.

## Testing

- **Handler:** `scope: "run"` unchanged; `scope: "encounter"` selects the right encounter, passes one element to the builders, rejects unknown `combatId`; alias behavior.
- **Builders:** JSON `scope` field and single-encounter shape (schemaVersion 1); Markdown single-encounter title and metadata; GM-only content absent for public audiences; truncated and legacy encounters.
- **Filenames:** slug rules (case, punctuation, length cap), recorded-time stamp, fallbacks.
- **Window (mocked DOM and save):** four entries, enabled/disabled rules, the encounter entries follow the encounter select and the selected run, remembered format ordering.
- **Journal sheet:** the viewed page drives the encounter scope, no-page and no-`combatId` states, the four entries and tooltips.
- **API:** default scope, `combatId` resolution, newest-encounter fallback notification.
- **Visibility:** a player's encounter export contains only public rows.
- **Regression:** #1014 run downloads, #1152 entries and #1150 run selection behave as before.
- **Live verification:** download a single encounter as Markdown and JSON from the window and from the journal sheet (as GM and as a player), confirm the filename carries the label and recorded time, and that the whole-run export is unchanged.

## Explicitly out of scope

- Downloading the live in-progress combat (#1243), selected rounds only (#1244), and the combatant filter (#1245).
- Localizing the strings (#1240) and the directory context-menu entries (#1241).
- Changing archive content or the builders' per-encounter layout.

## Open questions

None blocking. Left to planning: how the journal sheet exposes its currently viewed page in Foundry 14.368, and the exact slug helper shared with the existing dungeon-name slug.
