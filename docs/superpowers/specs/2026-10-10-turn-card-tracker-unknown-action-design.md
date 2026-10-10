# Fix: AI Turn Card Logged as an "Unknown Action" by the Action Tracker

**Issue:** #1252 — every AI-controlled combatant gets one spurious "Unknown Action" in the PF2E Automated Action Tracker (`pf2e-auto-action-tracker`), because the module's AI turn chat card is logged as an action.

**Builds on:** #925 / `scripts/agent-action-display.mjs` and `renderAgentTurnCard` in `scripts/dungeon-combat.mjs` (the consolidated AI turn card), #951 / `scripts/ai-action-digest.mjs` (digest rows), #1094 / `docs/superpowers/specs/2026-10-09-human-turn-action-enforcement-design.md` (the module's integration with the tracker), #1212 / `scripts/combatant-flag-guard.mjs` (the tracker's flag-write quirk).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

The tracker treats any chat message from the acting combatant that contains `class="action-glyph"` as a one-action entry. The module's AI turn card contains that exact markup in every action row, so each AI turn is over-counted by one action (a 3-action turn shows 4 spent). The fix is to **stop using the system's `action-glyph` class in module-posted chat content**: the card uses a module-owned class styled to look identical, and a regression guard keeps the system class out of module-posted chat HTML.

## Investigation findings

Diagnosis from the live world (combat `IVHYA7A4bkArmMFV`, 2026-10-10) plus a read of the tracker source (`/srv/foundry/data/Data/modules/pf2e-auto-action-tracker/main.js`, v0.19.1).

- **What is logged.** Each AI combatant's `flags["pf2e-auto-action-tracker"].log` contains one `{ cost: 1, slug: "unknown-action", category: "action", isMapRelevant: false }` whose `msgId` is the module's own AI turn card (message flag `flags["pf2e-dungeon-crawl"].agentTurnCard`). Human-controlled combatants never post the card and have no such entry.
- **Why.** The tracker's `createChatMessage` hook resolves the combatant from the speaker, then runs its detectors on the message. `GenericActionDetector.isType` returns true when the message has no PF2e origin/item and its `flavor` or `content` includes the literal `class="action-glyph"`; `getDetails` then falls back to slug `unknown-action`, label `Unknown Action`, cost parsed from the text (default 1). The card is created with the AI combatant as speaker (`ChatMessage.getSpeaker({ actor, token })`) and its rows begin with `<span class="action-glyph">N</span>` from `costGlyph` in `agent-action-display.mjs`. Both conditions hold, so it is logged.
- **No opt-out exists.** The tracker's module flags on chat messages are `isExplicitUse`, `itemUsage`, `spellSlotUsage`, `damageOrigin` and similar internals; its break rules skip messages only by `flags.pf2e.context.type` (saving throw, recovery check, flat check, damage roll) or consumable/self-effect origins. There is no ignore flag.
- **Display-only for the module.** A search of `scripts/` and `tools/` finds no read of `actionsSpent`, `reactionsSpent` or the tracker log. The only code touching those flags is #1212's guard, which preserves this module's flag namespaces. The inflated count therefore only affects the tracker's pips and its overspend/underspend whispers.
- **Where the system class is used.** `costGlyph` in `agent-action-display.mjs` (the chat card, **the cause**) and `ai-action-digest.mjs` (digest rows rendered into the Combat Tracker row and token tooltip, which are DOM, not chat messages), the log window template (`ai-action-log.hbs`, an application window), and the parsers in `agent-candidates.mjs` that read `<span class="action-glyph">` out of compendium descriptions. Only the chat card reaches `createChatMessage`.
- **Updates don't re-log.** The card is created once per (combatant, round) and re-rendered in place with `message.update`; the tracker acts on creation only, hence exactly one extra entry per turn.

## Resolved decisions

1. **Rename the glyph class on the card** so the detector no longer matches; the card keeps its speaker, portrait and token hover. Rejected: posting without a combatant speaker (loses the token linkage) and deleting the tracker's entry after the fact (coupling to the tracker's internals).
2. **Style the new class to match** by copying the system's glyph rules onto a module class in `styles/dungeon.css`.
3. **Apply to every module-posted chat HTML** and add a **regression guard**.
4. **Explicitly out of scope (owner: skip, no tickets):** a cleanup of entries already logged in in-progress combats, a self-check warning if the tracker ever logs the card again, and an upstream request for an ignore flag.

## Design

### Markup

`costGlyph(cost)` in `scripts/agent-action-display.mjs` returns `<span class="pf2edc-action-glyph">${cost}</span> ` instead of `<span class="action-glyph">${cost}</span> `. The literal `class="action-glyph"` therefore no longer appears in the card. The glyph digit is unchanged (the Pathfinder actions font maps `1`/`2`/`3` to the action icons), so it renders as before once styled.

### CSS (`styles/dungeon.css`)

Copy the system's `.action-glyph` rule onto the module class, next to the existing `.pf2edc-agent-turn` rules:

```css
.pf2edc-action-glyph {
  align-self: center;
  display: inline;
  font-family: "Pathfinder2eActions", sans-serif;
  font-weight: normal;
  letter-spacing: 0;
  margin: 0;
  padding: 0;
}
```

The font family is loaded by the PF2e system; if it is unavailable the digit renders as plain text, the same degradation the system's class has.

### Other glyph users

- **Digest rows** (`ai-action-digest.mjs`) are rendered into the Combat Tracker row and token tooltip DOM (`scripts/ui/ai-action-detail.mjs`), never posted as chat, so the tracker never sees them. They keep the system class so they match the system's styling without extra CSS, but the guard test (below) enforces that the digest builder is not used for chat content.
- **Parsers** that read `<span class="action-glyph">` from compendium descriptions (`agent-candidates.mjs`) are input parsing, unaffected.
- **The log window template** is an application window, unaffected.
- **Any future chat poster** must not emit the system class; the guard below enforces this.

### Regression guard (`tests/chat-action-glyph.test.mjs`)

1. **Builder test.** Call `renderAgentTurnCardHtml` with records covering costs 1, 2 and 3, missing/invalid costs, a GM-only row, a fallback row, a target and a note, and assert the output contains no `class="action-glyph"` token (matching the exact attribute value the tracker tests for, and also any `class` attribute whose class list contains `action-glyph` as a whole word) and does contain `pf2edc-action-glyph` for rows with a valid cost.
2. **Static scan.** Read every file under `scripts/` that contains a chat-posting call (`ChatMessage.create`, `postChatCard`, `createChatMessage`-style helpers, or `.update({ content`) and assert it does not contain the literal `class="action-glyph"` in a string that is part of chat content. The scan keeps an explicit allowlist of files that legitimately mention the class for non-chat reasons, each with a one-line reason: `ai-action-digest.mjs` (DOM-only digest), `agent-candidates.mjs` (compendium parsing), `ai-action-log-app.mjs` (window). Adding a file to the allowlist requires a reason in the test.
3. **Digest isolation test.** Assert no chat-posting call site imports `renderDigestRowHtml`.

### Tracker interaction check (test)

A mocked-tracker unit test replicates the tracker's detector predicate (`content.includes('class="action-glyph"')`) and asserts the card HTML fails it, documenting the dependency without importing the tracker.

## Error handling

- The change is markup and CSS only; no runtime path can fail.
- A missing font degrades to plain digits, as with the system's own class.
- Cards already posted in an in-progress combat keep the old class; they are not rewritten, and their already-logged tracker entries are not cleaned up (out of scope by the owner's decision). New turns and new combats are correct.

## Testing

- **Existing tests:** `tests/agent-action-display.test.mjs` assertions on `action-glyph` are updated to the new class name; all other card tests unchanged.
- **New tests:** the three guard tests above.
- **Live verification:** start a combat with AI-controlled combatants and the tracker active; after an AI turn, read `combatant.flags["pf2e-auto-action-tracker"].log` and confirm there is no `unknown-action` entry from the turn card, `actionsSpent` equals the real actions taken (a 3-action turn shows 3), and the card's cost glyphs still render as action icons. Confirm a human-controlled combatant is unchanged.

## Explicitly out of scope

- Cleanup of already-logged "Unknown Action" entries, a self-check warning for tracker changes, and an upstream ignore-flag request (owner decision: skipped, no tickets).
- Changing the digest, the log window or the parsers' use of the system class.
- Any change to the card's content, speaker or whisper behavior.

## Open questions

None.
