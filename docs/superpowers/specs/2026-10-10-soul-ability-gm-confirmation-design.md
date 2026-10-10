# Advanced AI NPCs: Optional GM Confirmation for Soul-Devouring Abilities Against Dying PCs

**Issue:** #1188 — an optional world setting requiring GM confirmation before Drain Soul / Trap Soul is used on a dying player character, deferred from #1064.

**Builds on:** #1064 / `docs/superpowers/specs/2026-10-09-ai-npc-dying-creature-abilities-design.md` (the `npcDyingTarget` vocabulary, Drain Soul and Trap Soul, the owner decision that monsters may target dying PCs per the rules), #931 (the one-click GM-confirm card: `postReactionConfirmCard`, the `pendingReactions` map on the combat flag, `isGmLessCombat`, `defensiveReactionMode`), #925 / #953 (result descriptor and AI history), #1094 (human-turn conventions for prompts), `scripts/module.mjs` (world setting registration).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

#1064 lets a soul eater's **Drain Soul** and a demilich's **Trap Soul** target dying player characters because the rules allow it and the owner decided the module should apply them, in GM and GM-less runs alike. That is the default and stays the default. This spec adds a **world setting** with three modes — **Automatic** (today's behavior), **GM confirms** (a confirm card per use) and **Never against PCs** — plus the card, its stakes text, an "always allow for this combat" button, a configurable timeout, and a record in the AI action history.

## Investigation findings

- **The abilities and their stakes** (from #1064). *Drain Soul* (soul eater, 3 actions): adjacent to a Dying creature; Will DC 25; success Doomed 1 (or +1), failure Doomed 2, critical failure Doomed 3; a creature killed this way can't be restored short of an 8th-rank spell or ritual, and the soul returns if the soul eater is slain within 100 feet of the corpse within 1 minute. *Trap Soul* (demilich, 1 action, once per day per gem): Fortitude DC 38; success Drained 2; failure or critical failure traps the soul and the body turns to dust. Both are permanent-consequence abilities for a player character.
- **The GM-confirm pattern exists.** #931's `postReactionConfirmCard(combat, chosen, attacker, decision, …)` writes a pending record to `flags.pf2e-dungeon-crawl.pendingReactions[confirmId]`, posts a GM-whispered chat card with Accept/Decline buttons, and returns `{ confirmPending: true }`; the paired damage waits for the answer. It is used only when a human GM runs the table: `defensiveReactionMode({ attackerIsPlayerDriven, gmLess: isGmLessCombat(combat) })` picks automatic resolution in GM-less runs.
- **World settings** are registered in `scripts/module.mjs` with `game.settings.register(MODULE_ID, key, { scope: "world", config: true, … })` next to `autoRetreat`, `actionPaceDelayMs` and the others.
- **#1064 is specced, not implemented,** so the `npcDyingTarget` vocabulary this setting filters is defined by #1064's design; this spec states the filter and the hook points rather than modifying existing code.
- **Who counts as a PC.** The module's party is `game.actors.party.members`; AI-controlled party members are character-type actors played by the agent, and human players own character-type actors via user ownership.

## Resolved decisions

1. **Three modes:** Automatic (default), GM confirms, Never against PCs.
2. **Decline or timeout:** the action is **not spent**; the AI re-decides with that (ability, target) pair excluded for the remainder of the turn. The card has a timeout (a setting, default 120 s) that counts as a decline.
3. **Who counts as a player character:** character-type actors in the party, including AI-controlled party members. NPC allies and monsters are never gated.
4. **All four extras are in scope** (no follow-up tickets): stakes text on the card, an "always allow for this combat" button, a timeout setting, and recording the confirmation in the AI action history.

## Design

### Settings (`scripts/module.mjs`)

- `soulAbilitiesOnPcs` — world, config, `choices: { automatic, confirm, never }`, default `"automatic"`. Hint: "How monsters may use Drain Soul and Trap Soul on dying player characters."
- `soulAbilityConfirmTimeoutS` — world, config, number, default `120`, range 15–900. Hint: "How long the GM confirmation card waits before counting as a decline."

### Vocabulary gate (`scripts/npc-dying-abilities.mjs`, extends #1064)

`soulAbilityPolicy({ mode, targetIsPc, gmPresent, alwaysAllowed })` is a pure function returning `"offer"`, `"confirm"` or `"hide"`:

| Mode | Target is not a PC | PC, GM present | PC, GM-less |
|---|---|---|---|
| `automatic` | offer | offer | offer |
| `confirm` | offer | confirm (offer, but the executor holds for the card) unless `alwaysAllowed` → offer | **hide** |
| `never` | offer | hide | hide |

- `targetIsPc(target)`: the target actor is `type: "character"` and a member of the party (`game.actors.party.members`), regardless of whether a human or the agent plays it.
- `gmPresent`: `!isGmLessCombat(combat)` and an active GM user exists.
- `alwaysAllowed`: the combat has an "always allow" record for this ability slug (see below).
- The vocabulary builder calls the policy per (ability, target) entry; `hide` removes the entry, `confirm` keeps it marked `needsConfirm: true` so the summary tells the model and the log that GM approval is required ("requires GM confirmation").

### Confirm card (extends #931's pattern, `scripts/soul-confirm.mjs`)

When a chosen `needsConfirm` candidate reaches `applyAgentDecision`, **before** the cost is spent or the ability's save is rolled, the executor calls `requestSoulConfirm(combat, actor, target, ability)`:

1. Writes `pendingReactions[confirmId] = { kind: "soulAbility", abilitySlug, actorId, targetId, round, status: "pending", expiresAt }` (same map and record style as #931).
2. Posts the GM-whispered card with:
   - **Stakes text** built deterministically from the ability and the target's current state: Drain Soul — "raises <name>'s Doomed by 1–3 on a failed Will DC 25 save (currently dying <n>, Doomed <m>); a death from it can't be undone short of an 8th-rank spell or ritual"; Trap Soul — "on a failed Fortitude DC 38 save <name>'s soul is trapped and the body turns to dust; on a success <name> is Drained 2".
   - Three buttons: **Allow**, **Decline**, and **Allow for the rest of this combat** (sets the combat-scoped `soulAlwaysAllowed[abilitySlug] = true` and then behaves as Allow).
3. Returns `{ confirmPending: true, confirmId }`; the AI turn does not spend the action or roll anything yet.

The click handler (the same `createChatMessage`/render hook family that handles #931's card, active GM only) updates the record's `status` to `allowed` or `declined`, edits the card to show the answer, and resumes the turn.

### Resolution

- **Allowed:** the executor re-checks the target is still dying and adjacent/visible, then runs #1064's execution unchanged (cost spent, save rolled, consequences applied).
- **Declined or timed out:** the record is set to `declined`; the candidate `(abilitySlug, targetId)` is added to the turn's excluded set (`turnState.excludedCandidates`), the action is **not spent**, and `getPendingAgentTurn` is rebuilt so the AI re-decides without it. The card is edited to "Declined" or "Timed out" and the AI log line notes it.
- **Timeout:** a timer armed when the card is posted (using `soulAbilityConfirmTimeoutS`) resolves a still-pending record as `timedOut` (treated as declined) — the same fallback-timer discipline as the agent loop, re-armed after any turn-state write.
- **GM leaves mid-combat / combat ends with a pending card:** the record is closed as `expired`; nothing executes.
- **"Always allow for this combat"** is stored on the combat (`soulAlwaysAllowed`) and cleared with the combat.

### AI history

The #925 / #953 record for the action gains `confirmation: { requested: true, answer: "allowed" | "declined" | "timedOut" | "alwaysAllowed" | "expired", answeredBy?, ms }`; the formatter appends a short clause ("GM allowed", "GM declined — re-decided"), and the GM journal page shows the full record. A declined candidate leaves a record with the excluded `(ability, target)` so the choice is visible.

## Error handling

- A missing or malformed setting value reads as `automatic`.
- A card that fails to post leaves the action unspent and falls back to excluding the candidate for the turn (the safe direction) with a GM-visible console error.
- A click from a non-GM user is ignored; a click on a closed or unknown `confirmId` is ignored with a notice.
- If the target stops being dying before the answer, the allowed action aborts unspent and the card says why.
- Hooks and the executor never throw into the combat turn; every failure path errs toward not using the ability.

## Testing

- **`soulAbilityPolicy` (pure):** every row of the table, including `alwaysAllowed`, GM-less and non-PC targets.
- **`targetIsPc`:** character-type party members (human- and AI-controlled), NPC allies, monsters, non-party characters.
- **Vocabulary:** `hide` removes the entry, `confirm` marks it `needsConfirm` and annotates the summary, `automatic` unchanged from #1064.
- **Card:** pending record and card content, stakes text per ability and degree table, buttons, active-GM-only handling, edit on answer.
- **Resolution (mocked loop):** Allow runs #1064's execution; Decline excludes the pair and re-decides with the action unspent; timeout behaves as decline; always-allow stops further prompts for the ability this combat and clears at combat end; expiry on combat end.
- **Settings:** registration defaults and ranges.
- **AI history:** the `confirmation` field and formatter output.
- **Regression:** `automatic` mode behaves exactly like #1064; #931's reaction confirm cards unaffected.
- **Live verification:** with `confirm`, a soul eater's Drain Soul against a dying PC posts the card; Decline leads to a different action; Allow runs the save; with no GM the entry isn't offered; `never` hides it for PCs; always-allow stops repeat prompts.

## Explicitly out of scope

- Other permanent-consequence abilities (Devour a Soul and similar) — they can adopt the same policy function later.
- Changing #1064's default (monsters may use these on PCs).
- Confirming anything on NPC or monster targets.

## Open questions

None blocking. Left to planning: where `turnState.excludedCandidates` lives and how it is cleared at turn end, and the exact chat-message hook the existing #931 buttons use so the new card shares it.
