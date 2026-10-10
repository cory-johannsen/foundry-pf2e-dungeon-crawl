/** Runs `mutate` once, the first time applyAgentDecision itself reads
 * `combat.combatant` -- right after it rebuilt (and found) the candidate,
 * before the target is re-resolved. (#925 removed the pre-execution decision
 * whisper these tests used to hook instead.) */
export function afterCandidateRebuild(combat, mutate) {
  const current = combat.combatant;
  let done = false;
  Object.defineProperty(combat, "combatant", {
    configurable: true,
    get() {
      const caller = new Error().stack.split("\n")[2] ?? "";
      if (!done && /\bapplyAgentDecision\b/.test(caller)) {
        done = true;
        mutate();
      }
      return current;
    },
  });
}
