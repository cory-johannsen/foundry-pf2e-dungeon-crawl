# Advanced AI Actors: True Pre-Roll Interception via a `Check.roll` Wrapper

**Issue:** #1034 — true pre-roll interception by wrapping the system's `Check.roll`, deferred from #963.

**Builds on:** #963 / `docs/superpowers/specs/2026-10-09-ai-reaction-interception-design.md` (interception hooks, `applyDamage` wrapper, feature detection, kill switch, `commitId`, re-entrancy guard, fallback to #931/#960), #960 (deterministic save adjustments), #931 (registry, `markReactionUsed`).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions"); the system API was verified live.

## Summary

#963 adjusts a roll's *result* in `preCreateChatMessage`, after the dice are rolled, so a reaction that changes a DC or modifier (an AC bonus) cannot change what is rolled and the card shows the unmodified DC until adjusted. This spec adds an optional **guarded wrapper on `game.pf2e.Check.roll`** so reactions can change the roll's inputs — the DC, modifiers and roll options, or cancel the roll — **before** the dice are rolled, matching RAW timing and showing the correct DC. #963's post-hoc path stays as the fallback.

## Investigation findings

Inspected on the live world (Foundry 14.368, PF2e **8.5.0**):

- `game.pf2e.Check` has static members `roll`, `rerollFromMessage` and `renderReroll`. `roll` is a **writable, configurable** static, so it can be wrapped without a library.
- Signature: `async roll(check, context = {}, event = null, callback)` where `check` is the `CheckModifier`/statistic modifier set and `context` carries `actor`, `token`, `item`, `origin`, `target`, `dc` (`{ value, ... }`), `options` (a `Set` or array of roll options, converted to a `Set` inside), `type`, `skipDialog`, `createMessage`, `rollTwice`, `substitutions`, `isReroll`, `mapIncreases`, `messageMode` and so on.
- The function computes totals from `check` and `options` (`check.calculateTotal(options)`), resolves substitutions and fortune/misfortune, optionally shows the modifiers dialog, then rolls and builds the message. Because `context.dc` and `check.modifiers` are read *after* the entry point, mutating them in a wrapper before calling the original changes the dice, the DC and the card.
- Rerolls (`isReroll`) re-enter `roll` with the stored context and must not be adjusted twice.
- #963 already provides: feature detection plus a `module.json`-driven allowlist of verified system versions, a GM kill-switch setting, a re-entrancy guard, and a synchronous *decide*, then asynchronous *commit* split with `commitId`.

## Resolved decisions

1. **Install a guarded static wrap** of `game.pf2e.Check.roll` at `ready`; feature-detected, version-allowlisted, GM kill switch; no libWrapper dependency.
2. **Reactions may change:** the DC (`context.dc.value`), the roll modifiers and options (add a modifier, add roll options such as `fortune`/`misfortune`), and may **cancel** the roll (return `null`).
3. **#963's post-hoc path is kept** as the fallback; a marker on the context prevents double adjustment when both are active.
4. **Brittleness is accepted and contained:** every failure path calls the original unmodified; the wrapper never throws into the system.

## Design

### The wrapper (`scripts/check-roll-intercept.mjs`)

```js
export function installCheckRollWrapper({ Check = game.pf2e?.Check, version = game.system.version, settings, decide, commit }) {
  if (!Check || typeof Check.roll !== "function") return fail("missing");
  if (!versionVerified(version, allowlist)) return fail("version");
  if (settings.killSwitch()) return fail("killswitch");
  const original = Check.roll;
  let inIntercept = false;
  Check.roll = async function wrapped(check, context = {}, event = null, callback) {
    if (inIntercept || context.isReroll || context[ADJUSTED]) return original.call(this, check, context, event, callback);
    try {
      const plan = decide({ check, context });          // synchronous, pure; null → no change
      if (!plan) return original.call(this, check, context, event, callback);
      if (plan.cancel) { commit(plan); return null; }
      applyPlan(check, context, plan);                    // mutate DC / modifiers / options
      context[ADJUSTED] = plan.commitId;                  // the post-hoc path (#963) checks this marker
      commit(plan);                                       // async, GM client, idempotent on commitId
    } catch (err) { console.error(err); }
    inIntercept = true;
    try { return await original.call(this, check, context, event, callback); }
    finally { inIntercept = false; }
  };
  return { installed: true, uninstall() { Check.roll = original; } };
}
```

- The wrapper is installed once at `ready` (GM and players alike, because a player's roll runs on the player's client). `uninstall` restores the original (used by tests and the kill switch).
- `decide` is the pure function that evaluates the registry's pre-roll definitions for the roll; it reuses #963's eligibility gates (the reactor is an agent-controlled combatant, has the reaction item, the reaction is unused in the replicated `reactionUsed` flag, it observed the triggering creature).

### What can be adjusted (`applyPlan`)

- **DC:** `context.dc.value += bonus` (an AC or save-DC bonus from a defender's reaction, for example Wing Deflection, Ghost Dodge, Swat Projectile, Shield-style +2 circumstance that applies to the AC against this attack). The bonus is recorded in the context's roll notes so the card shows e.g. "DC +2 (Ghost Dodge)".
- **Modifiers and options:** `check.push(new game.pf2e.Modifier(...))`-style additions or `context.options.add(...)` (a Set after normalization) for options such as `fortune`/`misfortune` and `rollTwice`. The modifier is added before `calculateTotal` is called inside `roll`.
- **Cancel:** the plan returns `cancel: true` (a reaction that negates an attack before the roll, such as a reaction that makes the attacker unable to target), in which case `roll` returns `null` exactly as it does when the user cancels the dialog; an announcement explains it.
- It does **not** change the roll's formula beyond modifiers/options, does not touch rerolls, and does not synthesize results.

### Phases moved to the wrapper

AC bonuses (defender reactions) against attack rolls, save-DC bonuses for effects that force saves, and misfortune/fortune imposed by reactions move from #963's `preCreateChatMessage` adjustment to the wrapper when it is active. Reroll-type reactions stay on #1035. The `applyDamage` wrapper and `preCreateItem` condition negation are unchanged.

### Interaction with #963's post-hoc path

#963's `preCreateChatMessage` handler skips a message whose `flags.pf2e-dungeon-crawl.reactionAdjusted` or whose roll context carries `ADJUSTED` (copied onto the message flags by the wrapper through the `callback`/context passthrough), so a reaction never applies twice. With the wrapper disabled or unavailable, #963 behaves exactly as shipped.

### Safety

- **Feature detection:** `game.pf2e.Check.roll` exists and is a function; the system version is in the verified allowlist (in `module.json`; an out-of-range version disables the wrapper with a warning).
- **Kill switch:** a world setting (GM-only, default off) disables the wrapper; changing it uninstalls/reinstalls without reload.
- **No throwing:** every path in the wrapper's own code is inside try/catch; a failure logs once per session and calls the original.
- **Re-entrancy:** the shared guard from #963 plus the `inIntercept` flag stop a reaction roll (for example a reaction Strike) from triggering a further reaction in the same stack.
- **Self-test at ready:** the installer runs a no-op roll through a stubbed context in dev mode (a unit test in CI) to check that `decide` returning `null` leaves the call identical.

## Error handling

- Missing context fields (`dc`, `target`): `decide` returns `null`; the roll proceeds.
- Commit failures (race on the reaction): the commit is rejected, a GM note is posted, and the adjustment already applied stands, as #963.
- A system update that changes the `roll` signature is caught by the version allowlist; the wrapper is skipped and #963 carries on.

## Testing

- **Wrapper unit tests** with a fake `Check`: install/uninstall, pass-through when `decide` is null, DC and modifier mutation visible to the original, cancel, reroll bypass, re-entrancy, exception safety.
- **Decision tests:** AC-bonus reactions change the DC only when the reactor is eligible, and only once per reaction use; double-adjust prevention against #963.
- **Version and kill-switch tests:** disallowed version and kill switch skip installation.
- **Live verification:** with an AI defender holding Ghost Dodge and a player attacking it, the attack card shows the raised DC and the correct degree, versus the #963 fallback card.

## Explicitly out of scope

- Reroll-type reactions and two-roll reactions (#1035).
- Wrapping other system internals (damage rolls beyond the existing `applyDamage` wrapper).
- A libWrapper dependency (rejected).

## Open questions

None. Planning-time details: the exact modifier-construction API for the installed system and where roll notes are written for the "DC +2" display.
