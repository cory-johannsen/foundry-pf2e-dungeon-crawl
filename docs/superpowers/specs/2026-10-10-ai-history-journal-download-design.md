# AI Action History: Download From the Journal Sheet

**Issue:** #1152 — the same Download action as a header control on the "AI Action History" journal sheet. Deferred from #1014.

**Builds on:** #1014 / `docs/superpowers/specs/2026-10-09-ai-history-download-design.md` (the pure `buildHistoryJson` / `buildHistoryMarkdown` builders in `scripts/ai-history-export.mjs`, the window Download handler, `api.downloadAiHistory`), #1013 / `docs/superpowers/specs/2026-10-09-ai-action-log-history-mode-design.md` (`listArchivedEncounters`, `loadArchivedRecords`, structured `records`), #953 (`scripts/ai-history-journals.mjs`: journals flagged `aiHistory = { historyId, kind, sceneId }`), #1150 / `docs/superpowers/specs/2026-10-10-ai-history-run-selector-design.md` (runs other than the current one are browsable and downloadable).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

#1014 puts Download in the AI Action Log window's History mode. Players and GMs also open the archive from the **Journal sidebar** (the public "AI Action History" journal is observable by everyone), and a user reading it there has no way to export it. This spec adds **"Download Markdown" and "Download JSON" entries to the header controls menu of the AI-history journal sheets**, reusing #1014's builders and handler so the exported content is identical to the window's, for any run.

## Investigation findings

- **The journals are identifiable by flag.** Every AI-history journal carries `flags.pf2e-dungeon-crawl.aiHistory = { historyId, kind: "public" | "gm", sceneId }`, and every archived combat is a page flagged `aiHistory.combatId` with structured `records` (#1013). A journal sheet can therefore derive its run (`historyId`) without any new data.
- **Visibility is enforced by what the user can read.** A player can open only the public journal; a GM can open both. #1014's rule — a GM exports GM content, everyone else public content, defensively filtered by `visibleRecords` — depends on the **user's role**, not on which journal is open.
- **Exports are client-side.** `foundry.utils.saveDataToFile(data, type, filename)` downloads from the browser; no server work is needed.
- **Foundry V2 sheets expose header controls.** ApplicationV2-based sheets (the journal entry sheet in Foundry 14) build a header controls menu and fire `getHeaderControls…` hooks (a generic one for every ApplicationV2 and class-specific ones through the inheritance chain), where a module appends entries with `{ icon, label, action, visible, onClick }`. The exact hook name and entry shape for the installed Foundry (14.368) are confirmed during planning.
- **Legacy runs** archived before #1013 lack structured `records`; #1013 and #1150 already list them as "no structured data", and #1014 notes them in Markdown and omits them from JSON.

## Resolved decisions

1. **Audience follows the user's role**, exactly as #1014: a GM gets GM content, others get public content, whichever AI-history journal is open. The journal opened only selects the run.
2. **Two entries in the header controls menu:** "Download Markdown" and "Download JSON".
3. **Shown only on AI-history journals,** found by their `aiHistory` flag (public and GM journals of any run, not only the current one).
4. **Extras in scope:** the entries are disabled with an explanatory tooltip when the run has no structured data, and the last format chosen is remembered per user and shown as the preferred entry. **Filed:** localized labels (#1240) and Journal directory context-menu entries (#1241).

## Design

### Shared handler (`scripts/ai-history-export.mjs`, extended)

Extract #1014's window logic into one function both entry points call:

```js
downloadRunHistory({ historyId, format, isGM, notify, save = foundry.utils.saveDataToFile }) → { saved: boolean, reason? }
```

1. Loads the run's encounters with `listArchivedEncounters({ historyId, isGM })` / `loadArchivedRecords` (oldest first for export).
2. Builds the text with the existing pure builders (`buildHistoryJson` / `buildHistoryMarkdown`), applying `visibleRecords` defensively, listing legacy pages as "(no structured data)" in Markdown and omitting them from JSON with a count.
3. Saves with filename `ai-history-<dungeon-slug>-<YYYYMMDD-HHmm>.{md,json}` and notifies on success or failure; failures never throw.

The window's Download button and `api.downloadAiHistory({ format })` call the same function (the window passes the selected run per #1150; the API defaults to the current run).

### Header controls (`scripts/ai-history-journal-controls.mjs`)

A small module registers a header-controls hook for journal entry sheets. For each sheet:

1. Read `sheet.document.getFlag("pf2e-dungeon-crawl", "aiHistory")`; if absent, add nothing.
2. Otherwise append two entries, ordered with the user's preferred format first:
   - `{ action: "aiHistoryDownloadMd", icon: "fa-solid fa-file-lines", label: "Download Markdown", onClick: () => downloadRunHistory({ historyId, format: "md", isGM: game.user.isGM, … }) }`
   - `{ action: "aiHistoryDownloadJson", icon: "fa-solid fa-file-code", label: "Download JSON", onClick: … }`
3. Mark each entry `visible: true`; if the run has no structured data (`hasRecords === false` from the same helper #1150 uses, evaluated for the sheet's own `historyId`), set `disabled`-equivalent behavior (the control renders but its click handler shows a notification "This run has no structured data to export") and set the tooltip text to the same explanation.

The hook also tags the journal sheet's root element with `data-ai-history` for tests and styling; nothing else on the sheet changes.

### Remembering the last format

`game.settings` gets a client-scoped, hidden setting `aiHistoryDownloadFormat` (`"md" | "json"`, default `"md"`), written after each successful download. The header entries order the remembered format first and give it a leading check icon ("✓ Download Markdown"), so the preference is visible without adding a new control. A missing or invalid value falls back to `"md"`.

### Audience and privacy

`downloadRunHistory` takes `isGM` from the **current user**, not from the journal opened. A GM who opens the public journal exports the GM content for that run (the builders still honor `visibleRecords` for any non-GM caller). A player cannot open the GM journal, so no GM content can reach a player through this control; a player on the public journal exports public rows only. The module never reads pages the user cannot open.

## Error handling

- A sheet whose document has no readable flag shows no entries.
- A run with no pages or only legacy pages: the entries show the "no structured data" explanation instead of saving an empty file.
- A save failure (browser blocking the download) shows a notification and never throws into the sheet.
- A missing `historyId` (hand-edited flags) hides the entries.
- Header-control hook failures are logged and never prevent the sheet from rendering.

## Testing

- **Controls:** entries added only for AI-history journals; absent for ordinary journals; both kinds (public and GM); order follows the remembered format; disabled behavior for runs with no structured data; hook errors don't break the sheet.
- **Handler:** `downloadRunHistory` builds the same Markdown and JSON as the window path for the same run (shared fixtures); filename; notification and failure paths; legacy encounters noted/omitted.
- **Audience:** GM on the public journal gets GM content; a player on the public journal gets public content only; defensive filtering holds with a mis-stored record.
- **Preference:** the setting is written after a download, read on render, invalid values fall back to `md`.
- **Regression:** #1014 window Download and `api.downloadAiHistory` behavior unchanged; #1013/#1150 History mode unaffected.
- **Live verification:** as a GM and as a player open the public journal for a finished run, download Markdown and JSON from the header menu, confirm the player's file has no GM-only content and the GM's does; open an older run's journal and a legacy run and confirm the explanation.

## Explicitly out of scope

- Localizing the labels and notifications (#1240) and Journal directory context-menu entries (#1241).
- Downloading a single selected encounter (#1153); per-page download controls.
- Changes to what the builders emit or to archive content.

## Open questions

None blocking. Left to planning: the exact Foundry 14.368 header-controls hook and entry fields, and how to compute `hasRecords` cheaply for a sheet (page flags only, no record parsing).
