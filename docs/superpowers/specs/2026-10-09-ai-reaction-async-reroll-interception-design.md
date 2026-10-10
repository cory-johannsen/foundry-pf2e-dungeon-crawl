# Advanced AI Actors: Asynchronous Interception for Reroll-Type Reactions

**Issue:** #1035 — asynchronous interception for reroll-type reactions (Cat's Luck, Shift Fate, Distracting Frolic), deferred from #963.

**Builds on:** #1034 / `docs/superpowers/specs/2026-10-09-ai-reaction-check-roll-wrapper-design.md` (the guarded `Check.roll` wrapper, `decide`/`commit`, `ADJUSTED` marker), #963 / `docs/superpowers/specs/2026-10-09-ai-reaction-interception-design.md` (feature detection, kill switch, `commitId`), #960 (after-the-fact adjustments), #931 (registry, `markReactionUsed`).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions"); the system behavior was verified live.

## Summary

Hooks like `preCreateChatMessage` are synchronous, so #963 cannot reroll a save before its card appears. This spec lets reactions that **reroll** or **roll twice** hold a roll's result until an asynchronous reaction decision completes, so the player never sees the pre-reaction result. It extends #1034's `Check.roll` wrapper to create the chat message itself after the reaction has resolved, and handles **Cat's Luck**, **Shift Fate** and **Distracting Frolic**. A short timeout bounds the hold and falls back to #960's after-the-fact path.

## Investigation findings

Verified on the live world (Foundry 14.368, PF2e **8.5.0**):

- The end of `Check.roll` calls `roll.toMessage({ speaker, flavor, flags }, { messageMode, create: context.createMessage })`. When `createMessage` is `false`, `toMessage` returns **message data**, and the optional fourth-argument `callback(roll, outcome, message, event)` receives an **uncreated `ChatMessagePF2e`** (`D instanceof ChatMessagePF2e ? D : new ChatMessagePF2e(D)`). `roll` returns the `Roll` (`h`), not the message.
- Rerolls are driven by `Check.rerollFromMessage(message, { resource })`, which deep-clones `message.flags.pf2e.context`, sets `isReroll`, adds the `check:reroll` option, rerolls the first roll's terms (keeping the better/worse result according to the resource used) and updates/creates the message. The system already implements "reroll and keep better/worse" semantics for Hero Points.
- `rollTwice` (`"keep-higher" | "keep-lower"`) is a context field read inside `roll` and adds the fortune/misfortune option; it needs no async step.
- The three reactions:
  - *Cat's Luck* (catfolk pouncer; also the ancestry feat): trigger "fails or critically fails a Reflex saving throw", once per day; "reroll that saving throw and take the better result". A genuinely *post-roll* reaction: the failure must be seen before deciding.
  - *Shift Fate* (norn, occult): trigger "a creature within 120 feet attempts a saving throw"; the creature rolls the save twice and the norn decides which applies (choosing the lower is a misfortune effect, the higher a fortune effect).
  - *Distracting Frolic* (caligni dancer, fortune/manipulate): trigger "an ally within 10 feet rolls a saving throw against a mental or illusion effect"; the ally rolls the save twice and takes the better result.
- #1034 provides the wrapper, `decide`/`commit`, the `ADJUSTED` marker and kill switch; its `applyPlan` already supports `rollTwice` and roll options.

## Resolved decisions

1. **Mechanism:** extend #1034's wrapper — run the original with `createMessage: false` and a callback that holds the uncreated message, await the reaction decision, optionally reroll, then create the message once.
2. **First slice:** Cat's Luck, Shift Fate, Distracting Frolic.
3. **Timeout:** hold at most a short, setting-controlled time (default 3 s); on timeout, create the original message unmodified and let #960's after-the-fact path apply the reaction.

## Design

### Held-message flow (`scripts/check-roll-intercept.mjs`, extended)

For a roll whose `decide` returns a plan of kind `postRoll` (or `rollTwice` for the two pre-roll cases), the wrapper:

1. Marks the context (`ADJUSTED`), records `createMessage` as requested, sets `context.createMessage = false`, and wraps the callback: `held = { roll, outcome, message, event, originalCallback }`.
2. Runs the original `Check.roll`. It returns the `Roll`; the held message is captured by the callback.
3. Evaluates `postDecide({ roll, outcome, message, context })` — a pure function over the held data — for any post-roll reaction (Cat's Luck). If a reaction applies it executes the reroll (below). If the plan is `rollTwice` (Shift Fate, Distracting Frolic), the roll was already made with `rollTwice` set before the call (decided in step 0), and `postDecide` just picks which of the two results applies when the reaction says so (Shift Fate).
4. Creates the message (`ChatMessage.create(message.toObject())` for the requested `messageMode`), invokes the original callback with the final message, and returns the `Roll`.
5. Timeouts and errors at any step create the unmodified held message and invoke the original callback, so a roll is never lost.

When `context.createMessage` was already `false` (a roll made quietly by the module), the flow is unchanged; the wrapper returns after decisions without creating anything.

### Rerolling a held roll

`rerollHeld(held, mode)` builds a new `Roll` from the held roll's formula with the same modifiers (the held message's `flags.pf2e.modifiers`), with `check:reroll` added to its options, and sets `held.message.rolls` / `flags.pf2e.context` (`isReroll: true`, `outcome` and `unadjustedOutcome` recomputed from the DC with nat 20/1 degree adjustments, as `Check.rerollFromMessage` does). The mode is `keep-better` (Cat's Luck: take the better of the two results), `keep-lower` or `keep-higher`. The flavor is regenerated to show both results ("Rerolled with Cat's Luck: 7 → 15"). No extra Hero Point or resource is touched.

### The three reactions

- **Cat's Luck (`postRollReroll`):** registered with trigger `saveFailed` + `statistic: reflex`. After the held roll's outcome is `failure`/`criticalFailure` and the reactor is the roller, an eligible reactor (reaction item present, daily frequency available per #910, reaction unused) rerolls with `keep-better`. Deterministic policy: always fire when eligible. Commit (GM client): `markReactionUsed`, decrement frequency, announce.
- **Shift Fate (`rollTwiceChoose`):** trigger `anySaveWithin120`. Decided **pre-roll** (the wrapper sets `rollTwice` to `"keep-higher"` or `"keep-lower"` according to the deterministic choice: the norn forces the lower of the two against a hostile roller and the higher for an ally, which is what the text lets the norn choose after seeing both; since the choice is always determined by the roller's side, no look at the dice is needed). The resulting effect is a fortune/misfortune effect per the text. Commit as above.
- **Distracting Frolic (`rollTwiceBetter`):** trigger `allySaveVsMentalIllusion` within 10 ft of the reactor. Pre-roll `rollTwice: "keep-higher"` for the ally; commit as above. Links the compendium effect only for display.

All three are exact-match reviewed definitions in the registry (item name and trigger text fixture-checked; all-or-nothing).

### Fallback and interaction with #960/#963

If the wrapper is off or unavailable (version, kill switch), these reactions use #960's after-the-fact path unchanged. #963's `preCreateChatMessage` skips messages carrying the `ADJUSTED` marker so a reaction cannot apply twice; the timeout path clears the marker and lets #960/#963 apply normally.

### Setting

`reactionHoldTimeoutMs` (world, GM; default 3000, 0 disables holding and forces the after-the-fact path).

## Error handling

- A reroll builder error or a missing held message: create the original message unmodified and log once.
- Timeout: the original is created, and the reaction (if the GM-side decision arrives later) is applied by #960's after-the-fact path with a GM note.
- Re-entrancy: the shared guard prevents a reaction roll from triggering a further reaction; held messages are created in the order their rolls started.
- A held message is never lost: `finally` always creates it.

## Testing

- **Held flow (fake `Check`, fake `ChatMessage`):** createMessage forced false and restored; callback receives the final message; timeout creates the original; exceptions create the original.
- **Reroll:** `keep-better`/`keep-lower`/`keep-higher` with dice fixtures; outcome recomputation with nat 20/1; flavor shows both results.
- **Reactions:** Cat's Luck only on failure/critical failure of a Reflex save by the reactor and once per day; Shift Fate choice by side; Distracting Frolic range and trait gate (mental/illusion); `markReactionUsed`; idempotent commit.
- **Interaction:** `ADJUSTED` prevents double application with #963; fallback when the wrapper is off.
- **Live verification:** a catfolk AI fails a Reflex save: the card shows only the final (rerolled) result; a norn makes a player's save roll twice and the card shows the applied result.

## Explicitly out of scope

- Reroll reactions on attack rolls and skill checks beyond the three listed.
- Spending Hero/Mythic Points (the AI never does so for reactions).
- Holding messages for rolls the module itself creates quietly.

## Open questions

None. Planning-time details: the exact flavor text for rerolled cards and where the `keep-better` result is recorded in the message flags.
