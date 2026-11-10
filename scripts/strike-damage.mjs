/**
 * #1284: one place that knows how to roll a Strike's damage for a given hit
 * outcome. PF2e's strike object exposes two damage functions: `damage()`
 * always rolls as a success and `critical()` always rolls as a critical
 * success (pf2e 8.5.0; verified live). Neither reads an `outcome` argument,
 * so passing `outcome` to `strike.damage()` silently rolls single damage on a
 * critical hit. This helper picks the right function and never forwards
 * `outcome`. Zero imports so any module can use it.
 */
export function rollStrikeDamage(strike, { target, outcome, createMessage = true } = {}) {
  const args = { target, createMessage };
  return outcome === "criticalSuccess" ? strike.critical(args) : strike.damage(args);
}
