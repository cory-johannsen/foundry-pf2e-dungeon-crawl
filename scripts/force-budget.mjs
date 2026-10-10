/**
 * #1083: pure helpers for dividing one overall PF2e XP budget (xpBudget in
 * encounter-roster.mjs) across an encounter's opposing forces.
 */
const finite = (n) => (Number.isFinite(n) ? n : 0);

export function splitBudget(totalXp, shares) {
  const total = Math.max(0, finite(totalXp));
  return shares.map((s) => Math.max(0, Math.floor((total * Math.max(0, finite(s))) / 100)));
}

export function validateShares(shares) {
  const total = shares.reduce((sum, s) => sum + finite(s), 0);
  const ok =
    shares.length > 0 &&
    shares.every((s) => Number.isFinite(s) && s > 0) &&
    total === 100;
  return { ok, total };
}
